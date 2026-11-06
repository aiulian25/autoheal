import { randomUUID } from "node:crypto";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { API_ERRORS } from "../../shared/api.js";
import { AUDIT_ACTIONS, JOB_ACTION, JOB_STATUS, SETTING_KEYS, TARGET_INTEGRATION } from "../../shared/constants.js";
import {
  BACKUP_SETTINGS_DEFAULT,
  CONTAINER_BACKUP,
  backupJobSchema,
  backupSettingsSchema,
  type BackupAnswer,
  type BackupJobDetails,
  type BackupRequest,
  type BackupSettings,
  type BackupTarget,
} from "../../shared/container-backups.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import { decryptBackup, encryptBackup } from "../backups/backup-crypto.js";
import type { DatabaseHandle } from "../database/connection.js";
import { jobs } from "../database/schema.js";
import { DomainError } from "../domain-error.js";
import type { HostRow } from "../hosts/hosts-service.js";
import type { JobsService } from "../jobs/jobs-service.js";
import type { SettingsStore } from "../settings/settings-store.js";
import type { ContainerAccessService } from "./container-access-service.js";
import { RunnerRelay } from "./runner-relay.js";
import type { WaitingRunners } from "./waiting-runners.js";

const BACKUP_ACTIONS: ReadonlySet<string> = new Set([JOB_ACTION.backupContainer, JOB_ACTION.restoreContainer]);
const ageIdentity = z.string().startsWith(CONTAINER_BACKUP.identityPrefix);
// What a key holds since keys name their host: backup folders may sit on storage several hosts share.
const hostBoundKey = z.object({ host: z.string(), identity: ageIdentity });

function hostBoundKeyIn(opened: string) {
  try {
    return hostBoundKey.safeParse(JSON.parse(opened)).data ?? null;
  } catch {
    return null;
  }
}

/**
 * A container's backups, which live in a plain folder on its own host. The dashboard holds no list of them, only the
 * passphrase: it seals a new key for each, and opens one for the job that needs it, keeping nothing of what it opened.
 */
export class ContainerBackupService {
  private readonly relay: RunnerRelay<BackupRequest, BackupAnswer>;
  // ponytail: in memory, so a restart lets a restore open one more old key; store it on the job if that ever matters.
  private readonly oldKeyOpenedFor = new Map<string, string>();

  constructor(
    private readonly handle: DatabaseHandle,
    private readonly access: Pick<ContainerAccessService, "requireHostAdmin">,
    runners: Pick<WaitingRunners, "wake">,
    private readonly jobsService: Pick<JobsService, "request">,
    private readonly store: SettingsStore,
    private readonly auditLog: Pick<AuditLog, "recordUserAction">,
    private readonly passphrase: string,
  ) {
    this.relay = new RunnerRelay(runners);
  }

  settings(): BackupSettings {
    return this.store.read(SETTING_KEYS.containerBackup, backupSettingsSchema) ?? BACKUP_SETTINGS_DEFAULT;
  }

  saveSettings(actor: Actor, settings: BackupSettings) {
    this.store.write(SETTING_KEYS.containerBackup, settings);
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.containerBackupSettingsChanged,
      { kind: TARGET_INTEGRATION, id: "container-backup" },
      { ...settings },
    );
  }

  ask(actor: Actor, hostId: string, kind: BackupRequest["kind"], target: BackupTarget) {
    this.access.requireHostAdmin(hostId, actor.userId);
    const { directory } = this.settings();
    return this.relay.ask(hostId, { id: randomUUID(), kind, target, directory });
  }

  private async newKey(hostId: string): Promise<BackupJobDetails["key"]> {
    const identity = await generateX25519Identity();
    const sealed = await encryptBackup(Buffer.from(JSON.stringify({ host: hostId, identity })), this.passphrase);
    return { recipient: await identityToRecipient(identity), sealedKey: Buffer.from(sealed).toString("base64") };
  }

  private async request(
    actor: Actor,
    hostId: string,
    action: string,
    target: BackupTarget,
    { include = [], restoreId = null }: { include?: readonly string[]; restoreId?: string | null },
  ) {
    this.access.requireHostAdmin(hostId, actor.userId);
    const { directory, copyDirectory } = this.settings();
    const backup: BackupJobDetails = {
      target,
      directory,
      copyDirectory,
      include: [...include],
      key: await this.newKey(hostId),
      restoreId,
    };
    return this.jobsService.request(
      { kind: "user", actor },
      hostId,
      target.container ?? "",
      action as typeof JOB_ACTION.backupContainer,
      null,
      { backup, ...(target.stack === null ? {} : { stack: { project: target.stack, removeData: false } }) },
    );
  }

  backUp(actor: Actor, hostId: string, target: BackupTarget, include: readonly string[]) {
    return this.request(actor, hostId, JOB_ACTION.backupContainer, target, { include });
  }

  restore(actor: Actor, hostId: string, target: BackupTarget, restoreId: string) {
    return this.request(actor, hostId, JOB_ACTION.restoreContainer, target, { restoreId });
  }

  /**
   * Only for a backup job this host is running now: the key made for that job, or, for a restore, the key of a backup
   * this host made. What opens goes to that runner and is not kept.
   */
  async openKey(host: Pick<HostRow, "id">, jobId: string, sealedKey: string) {
    const refused = () => new DomainError(API_ERRORS.backupKeyRefused);
    const job = this.handle.database.select().from(jobs).where(eq(jobs.id, jobId)).get();
    const running =
      job !== undefined &&
      job.hostId === host.id &&
      job.status === JOB_STATUS.delivered &&
      BACKUP_ACTIONS.has(job.action);
    if (!running) throw refused();
    const issued = job.backupJson === null ? null : backupJobSchema.parse(JSON.parse(job.backupJson)).key.sealedKey;
    const isIssued = sealedKey === issued;
    // A backup only ever needs its own key; a restore also needs the one stored with the backup it puts back.
    if (!isIssued && job.action !== JOB_ACTION.restoreContainer) throw refused();
    const sealed = await decryptBackup(Buffer.from(sealedKey, "base64"), this.passphrase).catch(() => {
      throw refused();
    });
    const opened = Buffer.from(sealed).toString("utf8");
    const bound = hostBoundKeyIn(opened);
    if (bound !== null) {
      if (bound.host !== host.id) throw refused();
      return { identity: bound.identity };
    }
    if (!ageIdentity.safeParse(opened).success) throw refused();
    if (isIssued) return { identity: opened };
    // A key from before keys named their host could be any host's: a restore opens one of those, never a second.
    const first = this.oldKeyOpenedFor.get(jobId);
    if (first !== undefined && first !== sealedKey) throw refused();
    this.oldKeyOpenedFor.set(jobId, sealedKey);
    return { identity: opened };
  }

  take(host: Pick<HostRow, "id">) {
    return this.relay.take(host.id);
  }

  answer(host: Pick<HostRow, "id">, requestId: string, answer: BackupAnswer) {
    this.relay.answer(host.id, requestId, answer);
  }

  reset() {
    this.relay.reset();
  }
}
