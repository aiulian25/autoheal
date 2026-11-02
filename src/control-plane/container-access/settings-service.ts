import type { ResourceMember } from "../auth/resource-permissions.js";
import { randomUUID } from "node:crypto";
import { API_ERRORS, type JobView } from "../../shared/api.js";
import {
  AUDIT_ACTIONS,
  JOB_ACTION,
  JOB_EXPIRY_MILLISECONDS,
  JOB_STATUS,
  TARGET_CONTAINER,
  type AuditAction,
} from "../../shared/constants.js";
import type { ContainerSettings, SettingsAnswer, SettingsRequest } from "../../shared/protocol.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import { DomainError } from "../domain-error.js";
import type { HostRow } from "../hosts/hosts-service.js";
import type { JobsService } from "../jobs/jobs-service.js";
import type { ContainerAccessService } from "./container-access-service.js";
import { RunnerRelay } from "./runner-relay.js";
import type { WaitingRunners } from "./waiting-runners.js";

const OPEN_STATUSES = new Set<string>([JOB_STATUS.pending, JOB_STATUS.delivered]);

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
 * code), and changed by an edit job, which recreates it as an update does. The new settings wait in memory for
 * the runner to fetch, once; the job row holds none of them.
 */
export class SettingsService {
  private readonly authorizations = new Map<
    string,
    { hostId: string; containerName: string; userId: string; tokenHash: string }
  >();
  private readonly relay: RunnerRelay<SettingsRequest, SettingsAnswer>;
  private readonly waiting = new Map<string, { hostId: string; settings: ContainerSettings; until: number }>();

  constructor(
    private readonly access: Pick<ContainerAccessService, "require"> &
      Partial<Pick<ContainerAccessService, "operatorUserId" | "authorizeOperator">>,
    private readonly jobs: Pick<JobsService, "request" | "list">,
    private readonly auditLog: AuditLog,
    runners: Pick<WaitingRunners, "wake">,
    private readonly clock: () => number = Date.now,
  ) {
    this.relay = new RunnerRelay(runners);
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
    const job = this.jobs.request({ kind: "user", actor }, hostId, containerName, JOB_ACTION.edit, null);
    this.forgetExpired();
    this.waiting.set(job.id, { hostId, settings, until: this.clock() + JOB_EXPIRY_MILLISECONDS });
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

  /** The settings an edit job applies, handed to its runner once. */
  forJob(host: HostRow, jobId: string): ContainerSettings {
    const entry = this.waiting.get(jobId);
    if (entry === undefined || entry.hostId !== host.id) {
      throw new DomainError(API_ERRORS.runnerRequestNotFound);
    }
    this.waiting.delete(jobId);
    return entry.settings;
  }

  reset() {
    this.authorizations.clear();
    this.relay.reset();
    this.waiting.clear();
  }

  private forgetExpired() {
    const now = this.clock();
    for (const [jobId, entry] of this.waiting) {
      if (entry.until <= now) {
        this.waiting.delete(jobId);
      }
    }
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
