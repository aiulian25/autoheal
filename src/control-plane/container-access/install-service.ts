import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";
import { API_ERRORS, type JobView } from "../../shared/api.js";
import { AUDIT_ACTIONS, JOB_ACTION, JOB_STATUS, TARGET_HOST } from "../../shared/constants.js";
import { projectNameOf } from "../../shared/compose-lint.js";
import {
  installDetailsSchema,
  type InstallAnswer,
  type InstallDetails,
  type InstallRequest,
  type InstallSpec,
} from "../../shared/install.js";
import type { OwnCheckBody, OwnFiles, OwnRetry } from "../../shared/own-compose.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { jobs } from "../database/schema.js";
import type { SecretBox } from "../database/secret-box.js";
import { DomainError } from "../domain-error.js";
import type { HostRow } from "../hosts/hosts-service.js";
import type { JobsService } from "../jobs/jobs-service.js";
import type { ContainerAccessService } from "./container-access-service.js";
import { RunnerRelay } from "./runner-relay.js";
import type { WaitingRunners } from "./waiting-runners.js";

// A job still to run, or running: the runner may yet need its details, and may ask more than once.
const OPEN_JOBS = [JOB_STATUS.pending, JOB_STATUS.delivered];
const sha256Of = (text: string) => createHash("sha256").update(text).digest("hex");

interface WrittenFiles extends OwnRetry {
  folder: string;
}

/**
 * Putting a new app on a host: its draft and checks asked of its runner, then a job. The details are sealed in the
 * job's own row, written with it, and stay there until the job has an outcome, so a reply lost on the way or a restart
 * here costs nothing. Asking for them again runs nothing: the job was handed out once. They hold no generated secret,
 * which only the host ever sees, though a person's own .env is in them.
 */
export class InstallService {
  private readonly relay: RunnerRelay<InstallRequest, InstallAnswer>;

  constructor(
    private readonly access: Pick<ContainerAccessService, "requireHostDeploy">,
    private readonly jobs: Pick<JobsService, "request" | "onFinished">,
    private readonly auditLog: AuditLog,
    runners: Pick<WaitingRunners, "wake">,
    private readonly databaseHandle: DatabaseHandle,
    private readonly secretBox: Pick<SecretBox, "seal" | "open">,
  ) {
    this.relay = new RunnerRelay(runners);
    jobs.onFinished(() => this.retire());
    this.retire();
  }

  private get database() {
    return this.databaseHandle.database;
  }

  private accepted(
    actor: Actor,
    hostId: string,
    name: string,
    details: InstallDetails,
    written: WrittenFiles | null = null,
  ): JobView {
    return this.database.transaction(() => {
      const job = this.jobs.request({ kind: "user", actor }, hostId, name, JOB_ACTION.install, null);
      // Asked twice while one waits, there is one job: it keeps the details it was asked with.
      this.database
        .update(jobs)
        .set({
          installPayload: this.secretBox.seal(JSON.stringify(details)),
          installRetry: written === null ? null : this.secretBox.seal(JSON.stringify(written)),
        })
        .where(and(eq(jobs.id, job.id), isNull(jobs.installPayload)))
        .run();
      return job;
    });
  }

  // Every job over by now: this runs when one ends, and at the start, for what a crash left between the two.
  private retire() {
    this.database
      .update(jobs)
      .set({ installPayload: null })
      .where(and(isNotNull(jobs.installPayload), notInArray(jobs.status, OPEN_JOBS)))
      .run();
  }

  draft(
    actor: Actor,
    hostId: string,
    wanted: {
      image?: string | undefined;
      recipe?: string | undefined;
      project?: string | undefined;
      composeFile?: string | undefined;
      compose?: string | undefined;
    },
  ) {
    this.access.requireHostDeploy(hostId, actor.userId);
    return this.relay.ask(hostId, {
      id: randomUUID(),
      kind: "draft",
      image: wanted.image ?? null,
      recipe: wanted.recipe ?? null,
      project: wanted.project ?? null,
      composeFile: wanted.composeFile ?? null,
      compose: wanted.compose ?? null,
    });
  }

  check(actor: Actor, hostId: string, spec: InstallSpec) {
    this.access.requireHostDeploy(hostId, actor.userId);
    return this.relay.ask(hostId, { id: randomUUID(), kind: "check", spec });
  }

  install(actor: Actor, hostId: string, spec: InstallSpec): JobView {
    this.access.requireHostDeploy(hostId, actor.userId);
    const job = this.accepted(actor, hostId, spec.name, spec);
    // Names and paths, never a value.
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.appInstallAsked,
      { kind: TARGET_HOST, id: hostId },
      {
        jobId: job.id,
        name: spec.name,
        image: spec.image,
        folder: spec.folder,
        mounts: spec.mounts.map((mount) => `${mount.source}->${mount.target}`),
        networks: spec.networks,
        environment: spec.environment.map((entry) => entry.name),
        generated: spec.secrets.map((entry) => entry.name),
      },
    );
    return job;
  }

  /**
   * A retry grants nothing by being asked for. It must name a failed install on this host, of this folder, by this
   * person, with none tried since; what comes back is what that install wrote, for the host to compare with its folder.
   */
  private retryOf(actor: Actor, hostId: string, folder: string | null, retryOf: string | null): OwnRetry | null {
    if (retryOf === null) return null;
    const failed = this.database.select().from(jobs).where(eq(jobs.id, retryOf)).get();
    const opened = failed?.installRetry == null ? null : this.secretBox.open(failed.installRetry);
    const written = opened === null ? null : (JSON.parse(opened) as WrittenFiles);
    const admitted =
      failed !== undefined &&
      written !== null &&
      folder === written.folder &&
      failed.hostId === hostId &&
      failed.status === JOB_STATUS.failed &&
      failed.requestedByUserId === actor.userId &&
      !this.triedSince(failed);
    if (!admitted) throw new DomainError(API_ERRORS.installRetryRefused);
    return { composeSha256: written.composeSha256, envSha256: written.envSha256 };
  }

  private triedSince({ hostId, containerName, createdAt }: typeof jobs.$inferSelect) {
    const later = this.database
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.hostId, hostId),
          eq(jobs.containerName, containerName),
          eq(jobs.action, JOB_ACTION.install),
          gt(jobs.createdAt, createdAt),
        ),
      )
      .get();
    return later !== undefined;
  }

  checkOwn(actor: Actor, hostId: string, { retryOf, ...files }: OwnCheckBody) {
    this.access.requireHostDeploy(hostId, actor.userId);
    const retry = this.retryOf(actor, hostId, files.folder, retryOf);
    return this.relay.ask(hostId, { id: randomUUID(), kind: "ownCheck", files: { ...files, retry } });
  }

  /** A person's own files: only their folder and name in the audit log. */
  installOwn(actor: Actor, hostId: string, { retryOf, ...own }: OwnFiles): JobView {
    this.access.requireHostDeploy(hostId, actor.userId);
    const name = projectNameOf(own.folder);
    const retry = this.retryOf(actor, hostId, own.folder, retryOf);
    const written = { folder: own.folder, composeSha256: sha256Of(own.compose), envSha256: sha256Of(own.env) };
    const job = this.accepted(actor, hostId, name, { ...own, retry }, written);
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.appInstallAsked,
      { kind: TARGET_HOST, id: hostId },
      { jobId: job.id, name, folder: own.folder, ownFiles: true, retryOf },
    );
    return job;
  }

  undo(actor: Actor, hostId: string, name: string, removeData: boolean): JobView {
    this.access.requireHostDeploy(hostId, actor.userId);
    const action = removeData ? JOB_ACTION.uninstallWithData : JOB_ACTION.uninstall;
    return this.jobs.request({ kind: "user", actor }, hostId, name, action, null);
  }

  take(host: Pick<HostRow, "id">) {
    return this.relay.take(host.id);
  }

  answer(host: Pick<HostRow, "id">, requestId: string, answer: InstallAnswer) {
    this.relay.answer(host.id, requestId, answer);
  }

  /** Only to the host the job is for, and only while the job is open. */
  forJob(host: Pick<HostRow, "id">, jobId: string): InstallDetails {
    const row = this.database
      .select({ payload: jobs.installPayload })
      .from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.hostId, host.id), inArray(jobs.status, OPEN_JOBS)))
      .get();
    const opened = row?.payload == null ? null : this.secretBox.open(row.payload);
    if (opened === null) {
      throw new DomainError(API_ERRORS.runnerRequestNotFound);
    }
    return installDetailsSchema.parse(JSON.parse(opened));
  }

  reset() {
    this.relay.reset();
  }

  resetHost(hostId: string) {
    this.relay.resetHost(hostId);
  }
}
