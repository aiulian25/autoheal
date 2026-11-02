import { randomUUID } from "node:crypto";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { eq } from "drizzle-orm";
import { API_ERRORS } from "../../shared/api.js";
import { AUDIT_ACTIONS, JOB_ACTION, JOB_STATUS, SETTING_KEYS, TARGET_INTEGRATION } from "../../shared/constants.js";
import {
  BACKUP_SETTINGS_DEFAULT,
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

/**
 * A container's backups, which live in a plain folder on its own host. The dashboard holds no list of them, only the
 * passphrase: it seals a new key for each, and opens one for the job that needs it, keeping nothing of what it opened.
 */
export class ContainerBackupService {
  private readonly relay: RunnerRelay<BackupRequest, BackupAnswer>;

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

  private async newKey(): Promise<BackupJobDetails["key"]> {
    const identity = await generateX25519Identity();
    const sealed = await encryptBackup(Buffer.from(identity), this.passphrase);
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
      key: await this.newKey(),
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

  /** Only for a backup job this host is running now. What opens goes to that runner and is not kept. */
  async openKey(host: Pick<HostRow, "id">, jobId: string, sealedKey: string) {
    const job = this.handle.database.select().from(jobs).where(eq(jobs.id, jobId)).get();
    const running =
      job !== undefined &&
      job.hostId === host.id &&
      job.status === JOB_STATUS.delivered &&
      BACKUP_ACTIONS.has(job.action);
    if (!running) throw new DomainError(API_ERRORS.backupKeyRefused);
    const opened = await decryptBackup(Buffer.from(sealedKey, "base64"), this.passphrase).catch(() => {
      throw new DomainError(API_ERRORS.backupKeyRefused);
    });
    return { identity: Buffer.from(opened).toString("utf8") };
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
