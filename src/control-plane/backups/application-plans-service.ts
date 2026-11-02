import { applicationArtifactStream } from "./application-artifact-stream.js";
import { randomUUID, createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, rename, copyFile, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { z } from "zod";
import {
  APPLICATION_BACKUP_FAILURE,
  APPLICATION_BACKUPS,
  APPLICATION_BOOT_READINESS,
  applicationBackupResultSchema,
  applicationBackupTaskSchema,
  applicationPlanDefinitionSchema,
  type ApplicationBackupsView,
  type ApplicationBackupTask,
  type ApplicationBackupResult,
  type ApplicationBackupFailure,
} from "../../shared/application-backups.js";
import { API_ERRORS } from "../../shared/api.js";
import {
  ACTOR_USER,
  APPLICATION_BACKUP_FILES,
  AUDIT_ACTIONS,
  HOST_STATUS_ACTIVE,
  HOST_SILENT_AFTER_MILLISECONDS,
  MILLISECONDS_PER_HOUR,
  TARGET_APPLICATION_BACKUP_PLAN,
} from "../../shared/constants.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { WaitingRunners } from "../container-access/waiting-runners.js";
import type { DatabaseHandle } from "../database/connection.js";
import type { HostRow } from "../hosts/hosts-service.js";
import { DomainError } from "../domain-error.js";
import { encryptBackup, decryptBackup } from "./backup-crypto.js";
import type { BackupSettings } from "./backup-service.js";

const saveSchema = z
  .object({
    id: z.uuid().optional(),
    revision: z.number().int().positive().optional(),
    hostId: z.uuid(),
    definition: applicationPlanDefinitionSchema,
    enabled: z.boolean(),
  })
  .strict();
interface PlanRow {
  id: string;
  host_id: string;
  revision: number;
  definition_json: string;
  enabled: number;
  next_due_at: number | null;
  created_at: number;
  updated_at: number;
}
interface RunRow {
  id: string;
  plan_id: string;
  host_id: string;
  operation: "capture" | "drill" | "boot-drill" | "restore" | "preview";
  status: string;
  task_json: string;
  requested_by: string | null;
  request_key: string;
  artifact_id: string;
  safety_artifact_id: string | null;
  progress_json: string | null;
  result_json: string | null;
  failure: ApplicationBackupFailure | null;
  created_at: number;
  claimed_at: number | null;
  finished_at: number | null;
}
interface ArtifactRow {
  id: string;
  plan_id: string;
  host_id: string;
  capture_run_id: string;
  key_ciphertext: string;
  recipient: string;
  status: string;
  payload_bytes: number | null;
  payload_sha256: string | null;
  metadata_json: string | null;
  created_at: number;
  verified_at: number | null;
  last_drill_at: number | null;
  boot_verified_at: number | null;
  image_id: string | null;
  retained_by_run_id: string | null;
}
const invalid = () => new DomainError(API_ERRORS.applicationBackupInvalid);
// A run's task until its key is made and the task written: never handed to a runner.
const UNWRITTEN_TASK = "{}";
// Where an artifact's files live under a backup folder: its encrypted payload and its sealed key.
const artifactsIn = (root: string) => join(root, APPLICATION_BACKUP_FILES.directory);
const payloadFileIn = (root: string, id: string) =>
  join(artifactsIn(root), `${id}${APPLICATION_BACKUP_FILES.payloadSuffix}`);
const keyFileIn = (root: string, id: string) => join(artifactsIn(root), `${id}${APPLICATION_BACKUP_FILES.keySuffix}`);
/** Durable tasks are claimed once. Lost result responses cause report retry, never action retry. */
export class ApplicationPlansService {
  private readonly writing = new Set<string>();
  private scheduling = false;
  private enqueuing = false;
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly settings: BackupSettings,
    private readonly runners: Pick<WaitingRunners, "wake">,
    private readonly audit: AuditLog,
    private readonly clock = Date.now,
  ) {}
  private get db() {
    return this.handle.sqlite;
  }
  private plan(id: string) {
    const row = this.db.prepare("SELECT * FROM application_backup_plans WHERE id=?").get(id) as PlanRow | undefined;
    if (!row) throw new DomainError(API_ERRORS.applicationBackupNotFound);
    return row;
  }
  private runRow(id: string) {
    const row = this.db.prepare("SELECT * FROM application_backup_runs WHERE id=?").get(id) as RunRow | undefined;
    if (!row) throw new DomainError(API_ERRORS.applicationBackupNotFound);
    return row;
  }
  private artifact(id: string) {
    const row = this.db.prepare("SELECT * FROM application_backup_artifacts WHERE id=?").get(id) as
      ArtifactRow | undefined;
    if (!row) throw new DomainError(API_ERRORS.applicationBackupNotFound);
    return row;
  }
  private available() {
    return this.settings.backupPassphrase.length > 0;
  }
  private host(id: string) {
    const row = this.db.prepare("SELECT * FROM hosts WHERE id=?").get(id) as
      { status: string; last_heartbeat_at: number | null; application_backups?: number } | undefined;
    const now = this.clock();
    if (
      !row ||
      row.status !== HOST_STATUS_ACTIVE ||
      !row.application_backups ||
      !row.last_heartbeat_at ||
      now - row.last_heartbeat_at > HOST_SILENT_AFTER_MILLISECONDS ||
      now < row.last_heartbeat_at ||
      !this.available()
    )
      throw new DomainError(API_ERRORS.applicationBackupUnavailable);
  }
  private expireClaims() {
    const now = this.clock();
    this.db
      .prepare("UPDATE application_backup_runs SET status='recovery-required' WHERE status='running' AND claimed_at<=?")
      .run(now - APPLICATION_BACKUPS.taskMilliseconds);
    // A queued run its runner did not collect in time ends here too, whether or not that runner ever asks again. One
    // still being prepared has no task, so no window, yet: the comparison leaves it alone.
    const uncollected = this.db
      .prepare(
        "SELECT id FROM application_backup_runs WHERE status='queued' AND json_extract(task_json,'$.expiresAt')<=?",
      )
      .all(now) as { id: string }[];
    for (const { id } of uncollected) this.fail(id, APPLICATION_BACKUP_FAILURE.expired);
  }
  /** Ends a run its runner never got, keeping why: no report from the runner will say. */
  private fail(runId: string, failure: ApplicationBackupFailure) {
    this.db
      .prepare("UPDATE application_backup_runs SET status='failed',failure=?,finished_at=? WHERE id=?")
      .run(failure, this.clock(), runId);
  }
  view(): ApplicationBackupsView {
    this.expireClaims();
    const plans = (
      this.db.prepare("SELECT * FROM application_backup_plans ORDER BY created_at").all() as PlanRow[]
    ).map((p) => ({
      id: p.id,
      hostId: p.host_id,
      revision: p.revision,
      definition: applicationPlanDefinitionSchema.parse(JSON.parse(p.definition_json)),
      enabled: !!p.enabled,
      nextDueAt: p.next_due_at,
    }));
    const runs = (
      this.db.prepare("SELECT * FROM application_backup_runs ORDER BY created_at DESC LIMIT 100").all() as RunRow[]
    ).map((r) => ({
      id: r.id,
      planId: r.plan_id,
      hostId: r.host_id,
      operation: r.operation,
      status: r.status as ApplicationBackupsView["runs"][number]["status"],
      artifactId: r.artifact_id,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
      result: r.result_json ? applicationBackupResultSchema.parse(JSON.parse(r.result_json)) : null,
      failure: r.failure,
    }));
    const artifacts = (
      this.db
        .prepare("SELECT * FROM application_backup_artifacts ORDER BY created_at DESC LIMIT 256")
        .all() as ArtifactRow[]
    ).map((a) => ({
      id: a.id,
      planId: a.plan_id,
      hostId: a.host_id,
      status: a.status as "ready" | "pending" | "failed",
      createdAt: a.created_at,
      payloadBytes: a.payload_bytes,
      verifiedAt: a.verified_at,
      lastDrillAt: a.last_drill_at,
      bootVerifiedAt: a.boot_verified_at,
      imageId: a.image_id,
      retained: !!a.retained_by_run_id,
    }));
    return {
      plans,
      runs,
      artifacts,
      available: this.available(),
      sourceBytes: APPLICATION_BACKUPS.sourceBytes,
      payloadBytes: APPLICATION_BACKUPS.payloadBytes,
    };
  }
  save(actor: Actor, input: unknown) {
    const value = saveSchema.parse(input);
    this.host(value.hostId);
    const now = this.clock();
    const id = value.id ?? randomUUID();
    if (value.id) {
      const before = this.plan(id);
      if (before.revision !== value.revision || before.host_id !== value.hostId)
        throw new DomainError(API_ERRORS.permissionConflict);
      this.db
        .prepare(
          "UPDATE application_backup_plans SET revision=revision+1,definition_json=?,enabled=?,next_due_at=?,updated_at=? WHERE id=?",
        )
        .run(
          JSON.stringify(value.definition),
          +value.enabled,
          value.enabled && value.definition.intervalHours
            ? now + value.definition.intervalHours * MILLISECONDS_PER_HOUR
            : null,
          now,
          id,
        );
    } else {
      const count = (this.db.prepare("SELECT COUNT(*) AS n FROM application_backup_plans").get() as { n: number }).n;
      if (count >= APPLICATION_BACKUPS.plans) throw new DomainError(API_ERRORS.applicationBackupBusy);
      this.db
        .prepare("INSERT INTO application_backup_plans VALUES(?,?,?,?,?,?,?,?)")
        .run(
          id,
          value.hostId,
          1,
          JSON.stringify(value.definition),
          +value.enabled,
          value.enabled && value.definition.intervalHours
            ? now + value.definition.intervalHours * MILLISECONDS_PER_HOUR
            : null,
          now,
          now,
        );
    }
    this.audit.record({
      actorKind: ACTOR_USER,
      actorId: actor.userId,
      actorLabel: actor.username,
      action: AUDIT_ACTIONS.applicationBackupPlanSaved,
      targetKind: TARGET_APPLICATION_BACKUP_PLAN,
      targetId: id,
    });
    return this.view();
  }
  private async createArtifact(plan: PlanRow, runId: string) {
    const id = randomUUID(),
      identity = await generateX25519Identity(),
      recipient = await identityToRecipient(identity);
    const key = Buffer.from(await encryptBackup(Buffer.from(identity), this.settings.backupPassphrase)).toString(
      "base64",
    );
    this.db
      .prepare(
        "INSERT INTO application_backup_artifacts(id,plan_id,host_id,capture_run_id,key_ciphertext,recipient,status,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(id, plan.id, plan.host_id, runId, key, recipient, "pending", this.clock());
    await mkdir(artifactsIn(this.settings.dataDirectory), { recursive: true, mode: 0o700 });
    await writeFile(keyFileIn(this.settings.dataDirectory, id), Buffer.from(key, "base64"), {
      flag: "wx",
      mode: 0o600,
    });
    if (this.settings.offboxBackupDirectory) {
      await mkdir(artifactsIn(this.settings.offboxBackupDirectory), { recursive: true, mode: 0o700 });
      await copyFile(keyFileIn(this.settings.dataDirectory, id), keyFileIn(this.settings.offboxBackupDirectory, id));
    }
    return { id, recipient };
  }
  async run(
    actor: Actor | null,
    planId: string,
    input: { operation: "capture" | "drill" | "boot-drill"; artifactId?: string; requestKey: string },
  ) {
    return this.enqueue(actor, planId, input);
  }
  private async enqueue(
    actor: Actor | null,
    planId: string,
    input: {
      operation: "capture" | "drill" | "boot-drill" | "preview" | "restore";
      artifactId?: string;
      requestKey: string;
      expectedFingerprint?: string;
      previewSession?: string;
    },
  ) {
    this.expireClaims();
    const plan = this.plan(planId);
    this.host(plan.host_id);
    const existing = this.db
      .prepare("SELECT id,plan_id FROM application_backup_runs WHERE request_key=?")
      .get(input.requestKey) as { id: string; plan_id: string } | undefined;
    if (existing) {
      if (existing.plan_id !== planId) throw invalid();
      return { id: existing.id };
    }
    if (this.enqueuing || this.writing.has(planId)) throw new DomainError(API_ERRORS.applicationBackupBusy);
    this.enqueuing = true;
    this.writing.add(planId);
    try {
      const active = this.db
        .prepare(
          "SELECT id FROM application_backup_runs WHERE host_id=? AND status IN ('queued','running','recovery-required')",
        )
        .get(plan.host_id);
      if (active) throw new DomainError(API_ERRORS.applicationBackupBusy);
      const stored = (
        this.db.prepare("SELECT COALESCE(SUM(payload_bytes),0) AS bytes FROM application_backup_artifacts").get() as {
          bytes: number;
        }
      ).bytes;
      const pending = (
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM application_backup_artifacts WHERE status='pending' AND payload_bytes IS NULL",
          )
          .get() as { n: number }
      ).n;
      if (
        (input.operation === "capture" || input.operation === "restore") &&
        stored + (pending + 1) * APPLICATION_BACKUPS.payloadBytes > APPLICATION_BACKUPS.storedBytes
      )
        throw new DomainError(API_ERRORS.applicationBackupBusy);
      const id = randomUUID(),
        now = this.clock();
      const definition = applicationPlanDefinitionSchema.parse(JSON.parse(plan.definition_json));
      // Reserve task identity before independent key generation; no private key is ever persisted in task_json.
      const artifact = input.artifactId ? this.artifact(input.artifactId) : null;
      if (
        artifact &&
        (artifact.plan_id !== plan.id || artifact.host_id !== plan.host_id || artifact.status !== "ready")
      )
        throw invalid();
      if (input.operation !== "capture" && !artifact) throw invalid();
      // Only for a plan that asked for it, as starting an application is not safe for every application.
      if (input.operation === "boot-drill" && (!definition.bootDrill || !artifact?.image_id)) throw invalid();
      this.db
        .prepare(
          "INSERT INTO application_backup_runs(id,plan_id,host_id,operation,status,task_json,requested_by,request_key,artifact_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          plan.id,
          plan.host_id,
          input.operation,
          "queued",
          UNWRITTEN_TASK,
          actor?.userId ?? null,
          input.requestKey,
          input.artifactId ?? null,
          now,
        );
      try {
        const primary = artifact ?? (await this.createArtifact(plan, id));
        const safety = input.operation === "restore" ? await this.createArtifact(plan, id) : null;
        const task: ApplicationBackupTask = {
          id,
          attempt: 0,
          automatic: actor === null,
          planId: plan.id,
          hostId: plan.host_id,
          operation: input.operation,
          artifactId: primary.id,
          recipient: primary.recipient,
          definition,
          ...(input.operation === "boot-drill" && artifact?.image_id ? { imageId: artifact.image_id } : {}),
          expiresAt: now + APPLICATION_BACKUPS.taskMilliseconds,
          ...(input.expectedFingerprint ? { expectedFingerprint: input.expectedFingerprint } : {}),
          ...(safety ? { safetyArtifactId: safety.id, safetyRecipient: safety.recipient } : {}),
        };
        this.db
          .prepare(
            "UPDATE application_backup_runs SET task_json=?,artifact_id=?,safety_artifact_id=?,progress_json=? WHERE id=?",
          )
          .run(
            JSON.stringify(task),
            primary.id,
            safety?.id ?? null,
            input.previewSession ? JSON.stringify({ session: input.previewSession }) : null,
            id,
          );
      } catch (error) {
        this.fail(id, APPLICATION_BACKUP_FAILURE.notPrepared);
        throw error;
      }
      this.runners.wake(plan.host_id);
      return { id };
    } finally {
      this.enqueuing = false;
      this.writing.delete(planId);
    }
  }
  prepareRestore(actor: Actor, session: string, planId: string, artifactId: string) {
    return this.enqueue(actor, planId, {
      operation: "preview",
      artifactId,
      requestKey: randomUUID(),
      previewSession: session,
    });
  }
  async restore(
    actor: Actor,
    session: string,
    planId: string,
    input: { artifactId: string; previewRunId: string; requestKey: string },
  ) {
    const preview = this.runRow(input.previewRunId);
    const context = JSON.parse(preview.progress_json ?? "{}");
    const result = preview.result_json ? applicationBackupResultSchema.parse(JSON.parse(preview.result_json)) : null;
    if (
      preview.plan_id !== planId ||
      preview.artifact_id !== input.artifactId ||
      preview.operation !== "preview" ||
      preview.status !== "succeeded" ||
      context.session !== session ||
      context.consumed ||
      !result?.fingerprint ||
      !preview.finished_at ||
      this.clock() - preview.finished_at > APPLICATION_BACKUPS.reviewMilliseconds ||
      this.clock() < preview.finished_at
    )
      throw invalid();
    const historical = JSON.parse(this.artifact(input.artifactId).metadata_json ?? "{}");
    if (
      historical.result?.fingerprint !== result.fingerprint ||
      JSON.stringify(historical.definition) !==
        JSON.stringify(applicationPlanDefinitionSchema.parse(JSON.parse(this.plan(planId).definition_json)))
    )
      throw invalid();
    // One-use approval: consume synchronously before any key generation can yield.
    this.db
      .prepare("UPDATE application_backup_runs SET progress_json=? WHERE id=?")
      .run(JSON.stringify({ ...context, consumed: true }), preview.id);
    return this.enqueue(actor, planId, {
      operation: "restore",
      artifactId: input.artifactId,
      requestKey: input.requestKey,
      expectedFingerprint: result.fingerprint,
    });
  }
  resume(actor: Actor, runId: string) {
    const run = this.runRow(runId);
    if (run.status !== "recovery-required") throw invalid();
    const task = applicationBackupTaskSchema.parse(JSON.parse(run.task_json));
    this.host(run.host_id);
    this.db
      .prepare(
        "UPDATE application_backup_runs SET status='queued',task_json=?,requested_by=?,claimed_at=NULL,result_json=NULL WHERE id=?",
      )
      .run(
        JSON.stringify({
          ...task,
          attempt: task.attempt + 1,
          resume: true,
          automatic: false,
          expiresAt: this.clock() + APPLICATION_BACKUPS.taskMilliseconds,
        }),
        actor.userId,
        run.id,
      );
    this.runners.wake(run.host_id);
    return { id: run.id };
  }
  private permitted(row: RunRow) {
    if (row.requested_by) {
      const user = this.db
        .prepare("SELECT role,status,must_change_password,totp_enabled FROM users WHERE id=?")
        .get(row.requested_by) as
        { role: string; status: string; must_change_password: number; totp_enabled: number } | undefined;
      return (
        !!user && user.role === "admin" && user.status === "active" && !user.must_change_password && !!user.totp_enabled
      );
    }
    const plan = this.plan(row.plan_id);
    const task = applicationBackupTaskSchema.parse(JSON.parse(row.task_json));
    return (
      row.operation === "capture" &&
      row.request_key.startsWith(`scheduled:${plan.id}:`) &&
      !!plan.enabled &&
      plan.definition_json === JSON.stringify(task.definition)
    );
  }
  authorize(host: HostRow, taskId: string, attempt: number) {
    const run = this.runRow(taskId);
    const task = applicationBackupTaskSchema.parse(JSON.parse(run.task_json));
    const allowed =
      host.applicationBackups &&
      run.host_id === host.id &&
      run.status === "running" &&
      task.attempt === attempt &&
      task.expiresAt > this.clock() &&
      this.permitted(run);
    if (allowed)
      this.db
        .prepare("UPDATE application_backup_runs SET progress_json=? WHERE id=?")
        .run(JSON.stringify({ admittedAt: this.clock(), attempt }), run.id);
    return { allowed: !!allowed };
  }
  async take(host: HostRow & { applicationBootDrills?: boolean }): Promise<ApplicationBackupTask[]> {
    if (!host.applicationBackups) return [];
    const rows = this.db
      .prepare(
        "SELECT * FROM application_backup_runs WHERE host_id=? AND status='queued' AND task_json<>? ORDER BY created_at LIMIT 1",
      )
      .all(host.id, UNWRITTEN_TASK) as RunRow[];
    const output = [];
    for (const row of rows) {
      if (!this.permitted(row)) {
        // A run with no requester is a scheduled capture, refused only once its plan is turned off or edited.
        this.fail(
          row.id,
          row.requested_by ? APPLICATION_BACKUP_FAILURE.requesterLostAccess : APPLICATION_BACKUP_FAILURE.planChanged,
        );
        continue;
      }
      const task = applicationBackupTaskSchema.parse(JSON.parse(row.task_json));
      if (task.expiresAt <= this.clock()) {
        this.fail(row.id, APPLICATION_BACKUP_FAILURE.expired);
        continue;
      }
      // A runner too old for this leaves it queued, and it expires: no older runner is sent what it cannot read.
      if (task.operation === "boot-drill" && !host.applicationBootDrills) continue;
      if (
        this.db
          .prepare("UPDATE application_backup_runs SET status='running',claimed_at=? WHERE id=? AND status='queued'")
          .run(this.clock(), row.id).changes !== 1
      )
        continue;
      if (task.operation === "drill" || task.operation === "boot-drill" || task.operation === "restore") {
        const artifact = this.artifact(task.artifactId);
        if (artifact.host_id !== host.id) throw invalid();
        task.identity = Buffer.from(
          await decryptBackup(Buffer.from(artifact.key_ciphertext, "base64"), this.settings.backupPassphrase),
        ).toString();
      }
      // Its test values go only to the task that uses them, and an older runner's strict reading never meets them.
      const { bootDrill, ...definition } = task.definition;
      output.push(
        task.operation === "boot-drill"
          ? { ...task, definition: { ...definition, bootDrill } }
          : { ...task, definition },
      );
    }
    return output;
  }
  private bound(host: HostRow, runId: string, artifactId: string) {
    const run = this.runRow(runId);
    if (
      run.host_id !== host.id ||
      !host.applicationBackups ||
      ![run.artifact_id, run.safety_artifact_id].includes(artifactId)
    )
      throw invalid();
    const artifact = this.artifact(artifactId);
    if (artifact.host_id !== host.id || artifact.plan_id !== run.plan_id) throw invalid();
    return { run, artifact };
  }
  authorizeTransfer(host: HostRow, taskId: string, artifactId: string, attempt: number) {
    const { run } = this.bound(host, taskId, artifactId);
    const task = applicationBackupTaskSchema.parse(JSON.parse(run.task_json));
    if (run.status !== "running" || task.attempt !== attempt) throw new DomainError(API_ERRORS.resultConflict);
    return { allowed: true };
  }
  private path(id: string) {
    if (!z.uuid().safeParse(id).success) throw invalid();
    return payloadFileIn(this.settings.dataDirectory, id);
  }
  async upload(host: HostRow, runId: string, artifactId: string, source: Readable, attempt = 0) {
    this.authorizeTransfer(host, runId, artifactId, attempt);
    const { run, artifact } = this.bound(host, runId, artifactId);
    if (
      run.status !== "running" ||
      (run.operation === "capture"
        ? artifactId !== run.artifact_id
        : run.operation !== "restore" || artifactId !== run.safety_artifact_id)
    )
      throw invalid();
    if (this.writing.has(artifactId)) throw new DomainError(API_ERRORS.applicationBackupBusy);
    this.writing.add(artifactId);
    const path = this.path(artifactId),
      partial = `${path}${APPLICATION_BACKUP_FILES.partialSuffix}`;
    let bytes = 0;
    const hash = createHash("sha256");
    try {
      await mkdir(artifactsIn(this.settings.dataDirectory), { recursive: true, mode: 0o700 });
      const disk = await statfs(artifactsIn(this.settings.dataDirectory));
      if (Number(disk.bavail) * Number(disk.bsize) < APPLICATION_BACKUPS.payloadBytes * 2)
        throw new DomainError(API_ERRORS.applicationBackupBusy);
      if (this.settings.offboxBackupDirectory) {
        await mkdir(artifactsIn(this.settings.offboxBackupDirectory), { recursive: true, mode: 0o700 });
        const offbox = await statfs(this.settings.offboxBackupDirectory);
        if (Number(offbox.bavail) * Number(offbox.bsize) < APPLICATION_BACKUPS.payloadBytes * 2)
          throw new DomainError(API_ERRORS.applicationBackupBusy);
      }
      await pipeline(
        source,
        applicationArtifactStream(),
        new Transform({
          transform(chunk: Buffer, _enc, cb) {
            bytes += chunk.length;
            if (bytes > APPLICATION_BACKUPS.payloadBytes) cb(new Error("Application backup transfer exceeds quota."));
            else {
              hash.update(chunk);
              cb(null, chunk);
            }
          },
        }),
        createWriteStream(partial, { flags: "wx", mode: 0o600 }),
      );
      this.authorizeTransfer(host, runId, artifactId, attempt);
      const checksum = hash.digest("hex");
      if (artifact.payload_sha256 && artifact.payload_sha256 !== checksum) throw invalid();
      await rename(partial, path);
      this.db
        .prepare("UPDATE application_backup_artifacts SET payload_bytes=?,payload_sha256=? WHERE id=?")
        .run(bytes, checksum, artifactId);
      if (this.settings.offboxBackupDirectory) {
        await mkdir(artifactsIn(this.settings.offboxBackupDirectory), { recursive: true, mode: 0o700 });
        await copyFile(path, payloadFileIn(this.settings.offboxBackupDirectory, artifactId));
      }
      return { bytes, sha256: checksum };
    } finally {
      await rm(partial, { force: true });
      this.writing.delete(artifactId);
    }
  }
  download(host: HostRow, runId: string, artifactId: string, attempt = 0) {
    this.authorizeTransfer(host, runId, artifactId, attempt);
    const { run, artifact } = this.bound(host, runId, artifactId);
    if (
      !["drill", "boot-drill", "restore"].includes(run.operation) ||
      run.status !== "running" ||
      artifact.status !== "ready"
    )
      throw invalid();
    return createReadStream(this.path(artifactId));
  }
  async complete(host: HostRow, input: ApplicationBackupResult) {
    const result = applicationBackupResultSchema.parse(input);
    const { run, artifact } = this.bound(host, result.id, result.artifactId);
    if (result.artifactId !== run.artifact_id) throw invalid();
    const expectedTask = applicationBackupTaskSchema.parse(JSON.parse(run.task_json));
    if (result.attempt !== expectedTask.attempt) throw new DomainError(API_ERRORS.resultConflict);
    if (run.result_json) {
      if (run.result_json !== JSON.stringify(result)) throw new DomainError(API_ERRORS.resultConflict);
      return { ok: true };
    }
    if (run.status !== "running" && run.status !== "recovery-required") throw invalid();
    if (
      result.ok &&
      run.operation === "capture" &&
      (!artifact.payload_bytes ||
        artifact.payload_bytes !== result.payloadBytes ||
        artifact.payload_sha256 !== result.payloadSha256)
    )
      throw invalid();
    const now = this.clock(),
      status = result.ok
        ? "succeeded"
        : result.recoveryRequired || result.stopped.length
          ? "recovery-required"
          : "failed";
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE application_backup_runs SET status=?,result_json=?,finished_at=? WHERE id=?")
        .run(status, JSON.stringify(result), now, run.id);
      if (run.operation === "capture")
        this.db
          .prepare(
            "UPDATE application_backup_artifacts SET status=?,verified_at=?,metadata_json=?,image_id=? WHERE id=?",
          )
          .run(
            result.ok ? "ready" : "failed",
            result.ok ? now : null,
            JSON.stringify({ definition: expectedTask.definition, result }),
            result.imageId ?? null,
            artifact.id,
          );
      if (result.ok && run.operation === "drill")
        this.db.prepare("UPDATE application_backup_artifacts SET last_drill_at=? WHERE id=?").run(now, artifact.id);
      // A failed boot says nothing against the backup: its other marks stay as they are. Staying up is not proof, as a
      // process supervisor stays up whatever fails inside it: only the image's own health check earns this mark.
      if (result.ok && run.operation === "boot-drill" && result.boot?.readiness === APPLICATION_BOOT_READINESS.healthy)
        this.db.prepare("UPDATE application_backup_artifacts SET boot_verified_at=? WHERE id=?").run(now, artifact.id);
      if (run.safety_artifact_id)
        this.db
          .prepare(
            "UPDATE application_backup_artifacts SET status=CASE WHEN payload_bytes IS NULL THEN status ELSE 'ready' END,retained_by_run_id=? WHERE id=?",
          )
          .run(result.ok ? null : run.id, run.safety_artifact_id);
    })();
    await this.retention(run.plan_id);
    await this.cleanupFailed();
    return { ok: true };
  }
  private async cleanupFailed() {
    const rows = this.db
      .prepare(
        "SELECT a.* FROM application_backup_artifacts a JOIN application_backup_runs r ON r.id=a.capture_run_id WHERE a.retained_by_run_id IS NULL AND (a.status='failed' OR (a.status='pending' AND r.status='failed')) AND NOT EXISTS (SELECT 1 FROM application_backup_runs work WHERE (work.artifact_id=a.id OR work.safety_artifact_id=a.id) AND work.status IN ('queued','running','recovery-required'))",
      )
      .all() as ArtifactRow[];
    for (const artifact of rows) {
      await rm(this.path(artifact.id), { force: true });
      await rm(keyFileIn(this.settings.dataDirectory, artifact.id), { force: true });
      if (this.settings.offboxBackupDirectory) {
        await rm(payloadFileIn(this.settings.offboxBackupDirectory, artifact.id), { force: true });
        await rm(keyFileIn(this.settings.offboxBackupDirectory, artifact.id), { force: true });
      }
      this.db
        .prepare(
          "UPDATE application_backup_artifacts SET status='failed',payload_bytes=NULL,payload_sha256=NULL,key_ciphertext='' WHERE id=?",
        )
        .run(artifact.id);
    }
  }
  private async retention(planId: string) {
    const plan = this.plan(planId);
    const retain = applicationPlanDefinitionSchema.parse(JSON.parse(plan.definition_json)).retain;
    const rows = this.db
      .prepare("SELECT * FROM application_backup_artifacts WHERE plan_id=? AND status='ready' ORDER BY created_at DESC")
      .all(planId) as ArtifactRow[];
    for (const artifact of rows.slice(retain)) {
      if (
        artifact.retained_by_run_id ||
        this.db
          .prepare(
            "SELECT id FROM application_backup_runs WHERE artifact_id=? AND status IN ('queued','running','recovery-required')",
          )
          .get(artifact.id)
      )
        continue;
      await rm(this.path(artifact.id), { force: true });
      await rm(keyFileIn(this.settings.dataDirectory, artifact.id), { force: true });
      if (this.settings.offboxBackupDirectory)
        await rm(payloadFileIn(this.settings.offboxBackupDirectory, artifact.id), { force: true });
      this.db
        .prepare("UPDATE application_backup_artifacts SET status='failed',key_ciphertext='' WHERE id=?")
        .run(artifact.id);
    }
  }
  async schedule() {
    // An uncollected capture ends first, so its pending artifact goes in this same pass.
    this.expireClaims();
    await this.cleanupFailed();
    if (this.scheduling || !this.available()) return;
    this.scheduling = true;
    try {
      const now = this.clock();
      for (const plan of this.db
        .prepare("SELECT * FROM application_backup_plans WHERE enabled=1 AND next_due_at<=? LIMIT 32")
        .all(now) as PlanRow[]) {
        try {
          await this.run(null, plan.id, {
            operation: "capture",
            requestKey: `scheduled:${plan.id}:${plan.next_due_at}`,
          });
          const definition = applicationPlanDefinitionSchema.parse(JSON.parse(plan.definition_json));
          this.db
            .prepare("UPDATE application_backup_plans SET next_due_at=? WHERE id=?")
            .run(definition.intervalHours ? now + definition.intervalHours * MILLISECONDS_PER_HOUR : null, plan.id);
        } catch {
          /* Busy/offline plans retain their due date for the next bounded sweep. */
        }
      }
    } finally {
      this.scheduling = false;
    }
  }
}
