import { RestoreJournal, type RestoreRecord } from "./restore-journal.js";
import { settleDispatchedWork } from "./settle-dispatched-work.js";
import { describeError } from "../../shared/errors.js";
import { log } from "../../shared/log.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { API_ERRORS, type RestorePreviewView, type RestoreResultView } from "../../shared/api.js";
import {
  ACTOR_SYSTEM,
  AUDIT_ACTIONS,
  BACKUP_ORIGIN,
  HOST_STATUS_ACTIVE,
  INTEGRITY_OK,
  JOB_CANCELLED_BY_RESTORE,
  JOB_STATUS,
  RESTORE_MESSAGES,
  RESTORE_PENDING_MILLISECONDS,
  RESTORE_REQUIRED_TABLES,
  RESTORE_SOURCE,
  RESTORE_SUFFIX,
  ROLLBACK_SUFFIX,
  SQLITE_SIDE_FILES,
  SYSTEM_ACTOR_LABEL,
  TARGET_BACKUP,
  USER_STATUS_ACTIVE,
  USER_STATUS_DEACTIVATED,
  WORK_ITEM_STATUS,
  UPDATE_RUN_STATUS,
} from "../../shared/constants.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import { openReadOnly, type DatabaseHandle } from "../database/connection.js";
import { LATEST_SCHEMA_VERSION } from "../database/migrations/index.js";
import { jobs, sessions, workItems, stackRestarts } from "../database/schema.js";
import { SecretBox } from "../database/secret-box.js";
import { sealStoredSecrets, unreadableSecrets } from "../database/stored-secrets.js";
import { DomainError } from "../domain-error.js";
import { decryptBackup } from "./backup-crypto.js";
import { inspectSnapshot, type BackupService } from "./backup-service.js";

type Source = typeof RESTORE_SOURCE.stored | typeof RESTORE_SOURCE.uploaded;

interface PendingRestore {
  preview: RestorePreviewView;
  snapshotPath: string;
  preparedBy: string;
}

/** Decrypt and check a backup; refuse anything that is not a healthy Autoheal database we can run. */
async function validatedSnapshot(
  encrypted: Uint8Array,
  passphrase: string,
  secretBox: SecretBox,
  snapshotPath: string,
) {
  const plain = await decryptBackup(encrypted, passphrase).catch(() => {
    throw new DomainError(API_ERRORS.backupUnreadable);
  });
  await writeFile(snapshotPath, plain);
  try {
    const { integrity, schemaVersion } = inspectSnapshot(snapshotPath);
    const tables = readTableNames(snapshotPath);
    const looksLikeAutoheal = integrity === INTEGRITY_OK && RESTORE_REQUIRED_TABLES.every((table) => tables.has(table));
    if (!looksLikeAutoheal) {
      throw new DomainError(API_ERRORS.notAutohealDatabase);
    }
    if (schemaVersion > LATEST_SCHEMA_VERSION) {
      throw new DomainError(API_ERRORS.backupTooNew);
    }
    // Restoring it would bring back sign-in codes nobody can check and tokens nothing can send with.
    if (unreadableSecretsIn(snapshotPath, secretBox) > 0) {
      throw new DomainError(API_ERRORS.backupSecretsUnreadable);
    }
    return schemaVersion;
  } catch (error) {
    await rm(snapshotPath, { force: true });
    throw error instanceof DomainError ? error : new DomainError(API_ERRORS.notAutohealDatabase);
  }
}

function readTableNames(path: string): Set<string> {
  const sqlite = openReadOnly(path);
  try {
    const rows = sqlite.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[];
    return new Set(rows.map((row) => row.name));
  } finally {
    sqlite.close();
  }
}

function unreadableSecretsIn(path: string, secretBox: SecretBox): number {
  const sqlite = openReadOnly(path);
  try {
    return unreadableSecrets(sqlite, secretBox);
  } finally {
    sqlite.close();
  }
}

/**
 * After any restore: nothing approved or asked for before it may run, a replay or an Autoheal run
 * that was mid-flight in the restored data has no process behind it, and everyone signs in again.
 */
function applicationWorkInFlight(handle: DatabaseHandle) {
  return handle.sqlite
    .prepare(
      "SELECT id,host_id AS hostId,operation,artifact_id AS artifactId,safety_artifact_id AS safetyArtifactId FROM application_backup_runs WHERE status IN ('running','recovery-required')",
    )
    .all();
}

function settleAfterRestore(databaseHandle: DatabaseHandle, secretBox: SecretBox, now: number): number {
  // An older backup brings its secrets back in plain text: they are sealed before anything reads them.
  sealStoredSecrets(databaseHandle.sqlite, secretBox);
  const cancelledIncidents = settleDispatchedWork(databaseHandle, now, JOB_CANCELLED_BY_RESTORE);
  // A backup is from another day: its schedules and everyone's sessions belong to that day, not this one.
  databaseHandle.sqlite
    .prepare(
      "UPDATE application_backup_plans SET enabled=0,next_due_at=NULL,revision=revision+1,updated_at=? WHERE enabled<>0 OR next_due_at IS NOT NULL",
    )
    .run(now);
  databaseHandle.database.delete(sessions).run();
  return cancelledIncidents;
}

/**
 * Restoring is two steps: prepare (decrypt, check, show what would come back) and confirm
 * (safety backup, swap, clean up). Authenticity comes from age's passphrase mode: a file that
 * decrypts was made with this passphrase.
 */
export class RestoreService {
  private get journal() {
    return new RestoreJournal(dirname(this.backups.temporaryDirectory));
  }
  private readonly pending = new Map<string, PendingRestore>();

  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly auditLog: AuditLog,
    private readonly backups: BackupService,
    private readonly passphrase: string,
    private readonly secretBox: SecretBox,
    private readonly clock: () => number = Date.now,
  ) {}

  async prepareStored(actor: Actor, fileName: string): Promise<RestorePreviewView> {
    const encrypted = await readFile(await this.backups.pathOf(fileName));
    return this.prepare(actor, encrypted, RESTORE_SOURCE.stored, fileName);
  }

  prepareUploaded(actor: Actor, encrypted: Uint8Array): Promise<RestorePreviewView> {
    return this.prepare(actor, encrypted, RESTORE_SOURCE.uploaded, null);
  }

  async cancel(actor: Actor, restoreId: string) {
    const pending = this.takePending(actor, restoreId);
    await rm(pending.snapshotPath, { force: true });
  }

  async confirm(actor: Actor, restoreId: string): Promise<RestoreResultView> {
    return this.databaseHandle.restore.exclusive(async () => {
      const pending = this.takePending(actor, restoreId);
      const rollbackPath = `${this.databaseHandle.path}${ROLLBACK_SUFFIX}`;
      this.journal.assertClean();
      const record: RestoreRecord = {
        version: 1,
        restoreId,
        phase: "safety-backup",
        databasePath: this.databaseHandle.path,
        snapshotPath: pending.snapshotPath,
        rollbackPath,
        safetyBackup: null,
      };
      this.journal.save(record);
      let safety;
      try {
        safety = await this.backups.create(BACKUP_ORIGIN.preRestore, actor);
      } catch (error) {
        this.journal.complete();
        throw error;
      }
      record.safetyBackup = safety.fileName;
      record.phase = "retaining-previous";
      this.journal.save(record);
      await rm(rollbackPath, { force: true });
      this.databaseHandle.sqlite.prepare("VACUUM INTO ?").run(rollbackPath);
      // The snapshot cannot cancel host processes already dispatched. Retain their identities in the restored audit.
      const runningJobs = this.databaseHandle.database
        .select({ id: jobs.id, hostId: jobs.hostId })
        .from(jobs)
        .where(eq(jobs.status, JOB_STATUS.delivered))
        .all();
      const runningWork = this.databaseHandle.database
        .select({ id: workItems.id, hostId: workItems.hostId })
        .from(workItems)
        .where(eq(workItems.status, WORK_ITEM_STATUS.delivered))
        .all();
      const runningApplicationBackups = applicationWorkInFlight(this.databaseHandle);
      // Those the restored file does not know of would otherwise leave no trace.
      const runningStackRestarts = this.databaseHandle.database
        .select({ id: stackRestarts.id, hostId: stackRestarts.hostId, stack: stackRestarts.stack })
        .from(stackRestarts)
        .where(eq(stackRestarts.status, UPDATE_RUN_STATUS.running))
        .all();
      let swapped = false;
      let cancelledIncidents: number;
      try {
        record.phase = "swapping";
        this.journal.save(record);
        this.databaseHandle.swapFile(pending.snapshotPath, rollbackPath);
        swapped = true;
        record.phase = "settling";
        this.journal.save(record);
        cancelledIncidents = this.databaseHandle.database.transaction(() =>
          settleAfterRestore(this.databaseHandle, this.secretBox, this.clock()),
        );
        if (this.databaseHandle.sqlite.pragma("integrity_check", { simple: true }) !== INTEGRITY_OK)
          throw new Error(RESTORE_MESSAGES.integrityFailed);
        this.databaseHandle.restore.reconcile();
        this.auditLog.recordUserAction(
          actor,
          AUDIT_ACTIONS.restoreCompleted,
          { kind: TARGET_BACKUP, id: pending.preview.fileName ?? pending.preview.source },
          {
            source: pending.preview.source,
            schemaVersion: pending.preview.schemaVersion,
            safetyBackup: safety.fileName,
            cancelledIncidents,
            runningJobs,
            runningWork,
            runningApplicationBackups,
            runningStackRestarts,
          },
        );
      } catch (error) {
        if (swapped) this.databaseHandle.restorePrevious(rollbackPath);
        this.databaseHandle.restore.reconcile();
        this.journal.complete();
        throw error;
      } finally {
        await rm(pending.snapshotPath, { force: true }).catch((error: unknown) =>
          log(`Restore snapshot cleanup: ${describeError(error)}`),
        );
      }
      record.phase = "committed";
      this.journal.save(record);
      // Only after settlement, checks and reconciliation succeed may rollback material be discarded.
      await rm(rollbackPath, { force: true }).catch((error: unknown) =>
        log(`Previous database cleanup: ${describeError(error)}`),
      );
      this.journal.complete();
      await this.clearPending().catch((error: unknown) => log(`Restore preview cleanup: ${describeError(error)}`));
      return { safetyBackup: safety.fileName, cancelledIncidents };
    });
  }

  /** Remove every leftover of an unfinished restore, e.g. after the process was restarted. */
  async clearPending() {
    this.journal.assertClean();
    for (const [restoreId, pending] of this.pending) {
      this.pending.delete(restoreId);
      await rm(pending.snapshotPath, { force: true });
    }
    await rm(this.backups.temporaryDirectory, { recursive: true, force: true });
  }

  private async prepare(actor: Actor, encrypted: Uint8Array, source: Source, fileName: string | null) {
    await mkdir(this.backups.temporaryDirectory, { recursive: true });
    // One restore in preparation per person: a new one replaces the previous, so nothing piles up.
    await this.forgetExpired((pending) => pending.preparedBy === actor.userId);
    const restoreId = randomUUID();
    const snapshotPath = join(this.backups.temporaryDirectory, `${restoreId}${RESTORE_SUFFIX}`);
    const schemaVersion = await validatedSnapshot(encrypted, this.passphrase, this.secretBox, snapshotPath);
    const preview: RestorePreviewView = {
      restoreId,
      source,
      fileName,
      schemaVersion,
      ...this.compare(snapshotPath),
      expiresAt: this.clock() + RESTORE_PENDING_MILLISECONDS,
    };
    this.pending.set(restoreId, { preview, snapshotPath, preparedBy: actor.userId });
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.restorePrepared,
      { kind: TARGET_BACKUP, id: fileName ?? source },
      {
        schemaVersion,
      },
    );
    return preview;
  }

  /** What would come back that is gone or switched off now: people should know before confirming. */
  private compare(snapshotPath: string) {
    const backup = openReadOnly(snapshotPath);
    try {
      const live = this.databaseHandle.sqlite;
      const rows = <Row>(database: Database.Database, sql: string) => database.prepare(sql).all() as Row[];
      const count = (sql: string) => (backup.prepare(sql).get() as { total: number }).total;
      const tables = readTableNames(snapshotPath);
      const countIfPresent = (table: string) =>
        tables.has(table) ? count(`select count(*) as total from ${table}`) : 0;
      const liveUsers = new Map(
        rows<{ username: string; status: string }>(live, "select username, status from users").map((user) => [
          user.username,
          user.status,
        ]),
      );
      const backupUsers = rows<{ username: string; status: string }>(backup, "select username, status from users");
      const liveHosts = new Map(
        rows<{ label: string; status: string }>(live, "select label, status from hosts").map((host) => [
          host.label,
          host.status,
        ]),
      );
      const backupHosts = tables.has("hosts")
        ? rows<{ label: string; status: string }>(backup, "select label, status from hosts")
        : [];
      const dataAsOf = tables.has("audit_events")
        ? (backup.prepare("select max(occurred_at) as latest from audit_events").get() as { latest: number | null })
            .latest
        : null;
      return {
        dataAsOf,
        counts: {
          users: backupUsers.length,
          hosts: backupHosts.length,
          incidents: countIfPresent("incidents"),
          runbooks: countIfPresent("runbooks"),
        },
        usersReactivated: backupUsers
          .filter(
            (user) => user.status === USER_STATUS_ACTIVE && liveUsers.get(user.username) === USER_STATUS_DEACTIVATED,
          )
          .map((user) => user.username),
        usersAdded: backupUsers.filter((user) => !liveUsers.has(user.username)).map((user) => user.username),
        hostsRestored: backupHosts
          .filter((host) => host.status === HOST_STATUS_ACTIVE && liveHosts.get(host.label) !== HOST_STATUS_ACTIVE)
          .map((host) => host.label),
      };
    } finally {
      backup.close();
    }
  }

  private takePending(actor: Actor, restoreId: string): PendingRestore {
    const pending = this.pending.get(restoreId);
    const usable =
      pending !== undefined && pending.preparedBy === actor.userId && pending.preview.expiresAt > this.clock();
    if (!usable) {
      throw new DomainError(API_ERRORS.restoreNotFound);
    }
    this.pending.delete(restoreId);
    return pending;
  }

  private async forgetExpired(alsoDrop: (pending: PendingRestore) => boolean = () => false) {
    const now = this.clock();
    for (const [restoreId, pending] of this.pending) {
      if (pending.preview.expiresAt <= now || alsoDrop(pending)) {
        this.pending.delete(restoreId);
        await rm(pending.snapshotPath, { force: true });
      }
    }
  }
}

/** The command-line path, for when the dashboard cannot start: no live database is needed. */
export async function restoreOffline(
  databaseHandleFactory: () => DatabaseHandle,
  auditLogFactory: (handle: DatabaseHandle) => AuditLog,
  settings: { databasePath: string; temporaryDirectory: string; passphrase: string },
  backupPath: string,
  now: number,
): Promise<{ schemaVersion: number; cancelledIncidents: number; previousKeptAt: string }> {
  await mkdir(settings.temporaryDirectory, { recursive: true });
  const secretBox = SecretBox.fromPassphrase(settings.passphrase);
  const snapshotPath = join(settings.temporaryDirectory, `${randomUUID()}${RESTORE_SUFFIX}`);
  const schemaVersion = await validatedSnapshot(
    await readFile(backupPath),
    settings.passphrase,
    secretBox,
    snapshotPath,
  );
  const previousKeptAt = `${settings.databasePath}${ROLLBACK_SUFFIX}-${now}`;
  // The old file's write-ahead log goes with it, or SQLite would replay it into the restored file.
  const moveAside = (from: string, to: string) =>
    Promise.all(
      ["", ...SQLITE_SIDE_FILES].map((suffix) => rename(`${from}${suffix}`, `${to}${suffix}`).catch(() => undefined)),
    );
  await moveAside(settings.databasePath, previousKeptAt);
  await rename(snapshotPath, settings.databasePath);
  let handle: DatabaseHandle;
  try {
    handle = databaseHandleFactory();
  } catch (error) {
    // The restored file would not open: put the previous database back exactly as it was.
    await rm(settings.databasePath, { force: true });
    await moveAside(previousKeptAt, settings.databasePath);
    throw error;
  }
  try {
    const snapshotApplicationBackups = applicationWorkInFlight(handle);
    const cancelledIncidents = handle.database.transaction(() => settleAfterRestore(handle, secretBox, now));
    auditLogFactory(handle).record({
      actorKind: ACTOR_SYSTEM,
      actorLabel: SYSTEM_ACTOR_LABEL,
      action: AUDIT_ACTIONS.restoreCompleted,
      targetKind: TARGET_BACKUP,
      targetId: RESTORE_SOURCE.commandLine,
      details: { source: RESTORE_SOURCE.commandLine, schemaVersion, cancelledIncidents, snapshotApplicationBackups },
    });
    return { schemaVersion, cancelledIncidents, previousKeptAt };
  } finally {
    handle.close();
  }
}
