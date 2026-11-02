import { randomBytes } from "node:crypto";
import { sha256Hex } from "../../shared/hash.js";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { API_ERRORS, type BackupView } from "../../shared/api.js";
import {
  ACTOR_SYSTEM,
  APP_VERSION,
  AUDIT_ACTIONS,
  BACKUP_EXTENSION,
  BACKUP_FILE_PATTERN,
  BACKUP_FILE_PREFIX,
  BACKUP_ID_LENGTH,
  BACKUP_MESSAGES,
  BACKUP_RETENTION_COUNT,
  BACKUPS_DIRECTORY,
  CHECK_SUFFIX,
  HEX_CHARACTERS_PER_BYTE,
  INTEGRITY_OK,
  JSON_INDENT,
  MANIFEST_EXTENSION,
  PARTIAL_EXTENSION,
  SNAPSHOT_SUFFIX,
  SYSTEM_ACTOR_LABEL,
  TARGET_BACKUP,
  TEMPORARY_DIRECTORY,
  type BackupOrigin,
} from "../../shared/constants.js";
import { describeError } from "../../shared/errors.js";
import { log } from "../../shared/log.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import { openReadOnly, type DatabaseHandle } from "../database/connection.js";
import { schemaVersionOf } from "../database/migrations/index.js";
import { DomainError } from "../domain-error.js";
import { decryptBackup, encryptBackup } from "./backup-crypto.js";

export interface BackupSettings {
  dataDirectory: string;
  offboxBackupDirectory: string | null;
  backupPassphrase: string;
}

const pad = (value: number) => String(value).padStart(2, "0");
const fileStamp = (moment: Date) =>
  `${moment.getUTCFullYear()}${pad(moment.getUTCMonth() + 1)}${pad(moment.getUTCDate())}-` +
  `${pad(moment.getUTCHours())}${pad(moment.getUTCMinutes())}${pad(moment.getUTCSeconds())}`;

/** Opens a decrypted copy read-only and reports SQLite's integrity check and schema version. */
export function inspectSnapshot(path: string): { integrity: string; schemaVersion: number } {
  const sqlite = openReadOnly(path);
  try {
    const integrity = String(sqlite.pragma("integrity_check", { simple: true }));
    return { integrity, schemaVersion: schemaVersionOf(sqlite) };
  } finally {
    sqlite.close();
  }
}

/**
 * Database-aware, encrypted backups: VACUUM INTO gives a consistent copy of the live database,
 * age encrypts it, and every backup is decrypted and integrity-checked straight away, so a
 * backup that exists is a backup that restores. The manifest sits next to the file (not in the
 * database, which a restore replaces) and travels with it off-box.
 */
export class BackupService {
  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly auditLog: AuditLog,
    private readonly settings: BackupSettings,
    private readonly clock: () => number = Date.now,
  ) {}

  get backupsDirectory() {
    return join(this.settings.dataDirectory, BACKUPS_DIRECTORY);
  }

  get temporaryDirectory() {
    return join(this.settings.dataDirectory, TEMPORARY_DIRECTORY);
  }

  async create(origin: BackupOrigin, actor: Actor | null): Promise<BackupView> {
    await mkdir(this.backupsDirectory, { recursive: true });
    await mkdir(this.temporaryDirectory, { recursive: true });
    const createdAt = this.clock();
    const uniqueId = randomBytes(BACKUP_ID_LENGTH / HEX_CHARACTERS_PER_BYTE).toString("hex");
    const fileName = `${BACKUP_FILE_PREFIX}${fileStamp(new Date(createdAt))}-${uniqueId}${BACKUP_EXTENSION}`;
    const snapshot = join(this.temporaryDirectory, `${fileName}${SNAPSHOT_SUFFIX}`);
    try {
      this.databaseHandle.sqlite.prepare("VACUUM INTO ?").run(snapshot);
      const encrypted = await encryptBackup(await readFile(snapshot), this.settings.backupPassphrase);
      const verified = await this.verify(encrypted, snapshot);
      const target = join(this.backupsDirectory, fileName);
      await writeFile(`${target}${PARTIAL_EXTENSION}`, encrypted);
      await rename(`${target}${PARTIAL_EXTENSION}`, target);
      const manifest: BackupView = {
        fileName,
        createdAt,
        createdBy: actor?.username ?? SYSTEM_ACTOR_LABEL,
        origin,
        schemaVersion: verified.schemaVersion,
        appVersion: APP_VERSION,
        sha256: sha256Hex(encrypted),
        sizeBytes: encrypted.length,
        integrityCheck: verified.integrity,
        offboxCopied: false,
      };
      manifest.offboxCopied = await this.copyOffbox(fileName, manifest);
      await writeFile(
        `${target}${MANIFEST_EXTENSION}${PARTIAL_EXTENSION}`,
        JSON.stringify(manifest, null, JSON_INDENT),
      );
      await rename(`${target}${MANIFEST_EXTENSION}${PARTIAL_EXTENSION}`, `${target}${MANIFEST_EXTENSION}`);
      await this.prune();
      this.audit(actor, fileName, origin);
      return manifest;
    } finally {
      await rm(snapshot, { force: true });
    }
  }

  /** Newest first. One unreadable manifest (a crash mid-write) must not hide the others. */
  async list(): Promise<BackupView[]> {
    const names = await readdir(this.backupsDirectory).catch(() => [] as string[]);
    const manifests = await Promise.all(
      names
        .filter((name) => name.endsWith(`${BACKUP_EXTENSION}${MANIFEST_EXTENSION}`))
        .map((name) => this.readManifest(name)),
    );
    return manifests
      .filter((manifest): manifest is BackupView => manifest !== null)
      .sort((first, second) => second.createdAt - first.createdAt);
  }

  private async readManifest(name: string): Promise<BackupView | null> {
    try {
      return JSON.parse(await readFile(join(this.backupsDirectory, name), "utf8")) as BackupView;
    } catch (error) {
      log(BACKUP_MESSAGES.manifestUnreadable(name, describeError(error)));
      return null;
    }
  }

  /** The stored file for a name from list(); refuses anything that is not exactly such a name. */
  async pathOf(fileName: string): Promise<string> {
    if (!BACKUP_FILE_PATTERN.test(fileName)) {
      throw new DomainError(API_ERRORS.backupNotFound);
    }
    const path = join(this.backupsDirectory, fileName);
    await stat(path).catch(() => {
      throw new DomainError(API_ERRORS.backupNotFound);
    });
    return path;
  }

  private async verify(encrypted: Uint8Array, snapshot: string) {
    const check = `${snapshot}${CHECK_SUFFIX}`;
    try {
      await writeFile(check, await decryptBackup(encrypted, this.settings.backupPassphrase));
      const result = inspectSnapshot(check);
      if (result.integrity !== INTEGRITY_OK) {
        throw new Error(BACKUP_MESSAGES.integrityFailed(result.integrity));
      }
      return result;
    } finally {
      await rm(check, { force: true });
    }
  }

  private async copyOffbox(fileName: string, manifest: BackupView): Promise<boolean> {
    const offbox = this.settings.offboxBackupDirectory;
    if (offbox === null) {
      return false;
    }
    try {
      await copyFile(join(this.backupsDirectory, fileName), join(offbox, fileName));
      await writeFile(
        join(offbox, `${fileName}${MANIFEST_EXTENSION}`),
        JSON.stringify({ ...manifest, offboxCopied: true }, null, JSON_INDENT),
      );
      return true;
    } catch (error) {
      log(BACKUP_MESSAGES.offboxFailed(describeError(error)));
      return false;
    }
  }

  // Local copies only: the off-box directory is the long-term archive and keeps everything. A name
  // comes from a manifest file, so only one shaped like a backup's is ever deleted.
  private async prune() {
    const surplus = (await this.list())
      .slice(BACKUP_RETENTION_COUNT)
      .filter((manifest) => BACKUP_FILE_PATTERN.test(manifest.fileName));
    for (const manifest of surplus) {
      const path = join(this.backupsDirectory, manifest.fileName);
      await rm(path, { force: true });
      await rm(`${path}${MANIFEST_EXTENSION}`, { force: true });
    }
  }

  private audit(actor: Actor | null, fileName: string, origin: BackupOrigin) {
    const target = { kind: TARGET_BACKUP, id: fileName };
    if (actor !== null) {
      this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.backupCreated, target, { origin });
      return;
    }
    this.auditLog.record({
      actorKind: ACTOR_SYSTEM,
      actorLabel: SYSTEM_ACTOR_LABEL,
      action: AUDIT_ACTIONS.backupCreated,
      targetKind: target.kind,
      targetId: target.id,
      details: { origin },
    });
  }
}
