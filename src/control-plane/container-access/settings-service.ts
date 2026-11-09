import type { ResourceMember } from "../auth/resource-permissions.js";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";
import { API_ERRORS, type JobView } from "../../shared/api.js";
import { AUDIT_ACTIONS, JOB_ACTION, JOB_STATUS, TARGET_CONTAINER, type AuditAction } from "../../shared/constants.js";
import {
  containerSettingsSchema,
  type ContainerSettings,
  type SettingsAnswer,
  type SettingsRequest,
} from "../../shared/protocol.js";
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

const OPEN_JOBS = [JOB_STATUS.pending, JOB_STATUS.delivered];
const OPEN_STATUSES: ReadonlySet<string> = new Set(OPEN_JOBS);

// What the audit log keeps of new settings: names, ports and paths; never a value.
const shapeOf = (settings: ContainerSettings) => ({
  environment: settings.environment.map((entry) => entry.name),
  labels: settings.labels.map((entry) => entry.name),
  ports: settings.ports.map((port) => `${port.address}:${port.published}->${port.target}/${port.protocol}`),
  mounts: settings.mounts.map((mount) => `${mount.source}->${mount.target}${mount.readOnly ? " (read-only)" : ""}`),
  restart: settings.restart,
});

/**
 * A container's own settings: read through its runner (environment values included, for admins who gave a
 * code), and changed by an edit job, which recreates it as an update does. The new settings are sealed in the job's
 * own row, written with it, so a restart here loses no edit: its runner fetches them once, and they go then, or
 * once the job is over without them.
 */
export class SettingsService {
  private readonly authorizations = new Map<
    string,
    { hostId: string; containerName: string; userId: string; tokenHash: string }
  >();
  private readonly relay: RunnerRelay<SettingsRequest, SettingsAnswer>;

  constructor(
    private readonly access: Pick<ContainerAccessService, "require"> &
      Partial<Pick<ContainerAccessService, "operatorUserId" | "authorizeOperator">>,
    private readonly jobs: Pick<JobsService, "request" | "list" | "onFinished">,
    private readonly auditLog: AuditLog,
    runners: Pick<WaitingRunners, "wake">,
    private readonly databaseHandle: DatabaseHandle,
    private readonly secretBox: Pick<SecretBox, "seal" | "open">,
  ) {
    // Reading a container's settings may go to the runner twice; joining or leaving a network never does.
    this.relay = new RunnerRelay(runners, (request) => request.network === undefined);
    jobs.onFinished(() => this.retire());
    this.retire();
  }

  private get database() {
    return this.databaseHandle.database;
  }

  read(
    actor: Actor,
    hostId: string,
    containerName: string,
    tokenHash?: string,
    details: boolean = false,
    network?: { name: string; joined: boolean },
  ): Promise<SettingsAnswer> {
    const container = this.access.require(hostId, containerName, actor.userId, "settings");
    const operatorUserId = this.access.operatorUserId?.(actor.userId);
    if (operatorUserId && !tokenHash) throw new DomainError(API_ERRORS.resourceForbidden);
    const request: SettingsRequest = {
      id: randomUUID(),
      containerName,
      requestedBy: actor.username,
      ...(operatorUserId ? { operatorUserId } : {}),
      ...(details ? { details } : {}),
      ...(network === undefined ? {} : { network }),
    };
    if (operatorUserId)
      this.authorizations.set(request.id, { hostId, containerName, userId: operatorUserId, tokenHash: tokenHash! });
    // Details carry no environment, and a panel reads them each time it opens.
    if (network !== undefined) this.audit(actor, AUDIT_ACTIONS.containerNetworkChanged, hostId, containerName, network);
    else if (!details) this.audit(actor, AUDIT_ACTIONS.settingsRead, hostId, containerName, {});
    return this.relay
      .ask(hostId, request)
      .then((answer) => {
        if (
          operatorUserId &&
          !this.authorizeOperator({ id: hostId } as HostRow, request.id, [
            { name: containerName, composeProject: container.composeProject },
          ])
        )
          throw new DomainError(API_ERRORS.resourceForbidden);
        // A runner from before details answers with its settings, environment and all: those were not asked for.
        return details ? { ...answer, settings: null, details: answer.details ?? null } : answer;
      })
      .finally(() => this.authorizations.delete(request.id));
  }

  apply(actor: Actor, hostId: string, containerName: string, settings: ContainerSettings): JobView {
    this.access.require(hostId, containerName, actor.userId, "settings");
    const editing = this.jobs
      .list(hostId, containerName)
      .some((job) => job.action === JOB_ACTION.edit && OPEN_STATUSES.has(job.status));
    if (editing) {
      throw new DomainError(API_ERRORS.editBusy);
    }
    const job = this.database.transaction(() => {
      const requested = this.jobs.request({ kind: "user", actor }, hostId, containerName, JOB_ACTION.edit, null);
      this.database
        .update(jobs)
        .set({ editSettings: this.secretBox.seal(JSON.stringify(settings)) })
        .where(and(eq(jobs.id, requested.id), isNull(jobs.editSettings)))
        .run();
      return requested;
    });
    this.audit(actor, AUDIT_ACTIONS.settingsChanged, hostId, containerName, { jobId: job.id, ...shapeOf(settings) });
    return job;
  }

  authorizeOperator(host: HostRow, requestId: string, members: readonly ResourceMember[]): boolean {
    const owner = this.authorizations.get(requestId);
    return (
      owner !== undefined &&
      owner.hostId === host.id &&
      (this.access.authorizeOperator?.(
        host.id,
        owner.containerName,
        owner.userId,
        "settings",
        members,
        owner.tokenHash,
      ) ??
        false)
    );
  }

  take(host: HostRow): SettingsRequest[] {
    return this.relay.take(
      host.id,
      (request) => request.operatorUserId === undefined || host.resourcePermissions === true,
    );
  }

  answer(host: HostRow, requestId: string, answer: SettingsAnswer) {
    this.relay.answer(host.id, requestId, answer);
  }

  /** The settings an edit job applies, handed once to its own host's runner while the job is open. */
  forJob(host: HostRow, jobId: string): ContainerSettings {
    const sealed = this.database.transaction(() => {
      const mine = and(eq(jobs.id, jobId), eq(jobs.hostId, host.id), inArray(jobs.status, OPEN_JOBS));
      const row = this.database.select({ sealed: jobs.editSettings }).from(jobs).where(mine).get();
      this.database.update(jobs).set({ editSettings: null }).where(mine).run();
      return row?.sealed ?? null;
    });
    const opened = sealed === null ? null : this.secretBox.open(sealed);
    if (opened === null) {
      throw new DomainError(API_ERRORS.runnerRequestNotFound);
    }
    return containerSettingsSchema.parse(JSON.parse(opened));
  }

  reset() {
    this.authorizations.clear();
    this.relay.reset();
  }

  // A revoked host's runner fetches none of the settings kept for it, so they go now, not when its jobs expire.
  resetHost(hostId: string) {
    this.relay.resetHost(hostId);
    this.database
      .update(jobs)
      .set({ editSettings: null })
      .where(and(eq(jobs.hostId, hostId), isNotNull(jobs.editSettings)))
      .run();
  }

  // Every job over by now: this runs when one ends, and at the start, for what a crash left between the two.
  private retire() {
    this.database
      .update(jobs)
      .set({ editSettings: null })
      .where(and(isNotNull(jobs.editSettings), notInArray(jobs.status, OPEN_JOBS)))
      .run();
  }

  private audit(actor: Actor, action: AuditAction, hostId: string, containerName: string, details: object) {
    this.auditLog.recordUserAction(
      actor,
      action,
      { kind: TARGET_CONTAINER, id: `${hostId}/${containerName}` },
      { hostId, ...details },
    );
  }
}
