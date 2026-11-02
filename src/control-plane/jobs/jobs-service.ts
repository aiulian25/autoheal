import type { ContainerJob, StackAction } from "../../shared/protocol.js";
import { backupJobSchema, type BackupJobDetails } from "../../shared/container-backups.js";
import { stackJobSchema, type StackJobDetails } from "../../shared/stacks.js";
import { newVolumeSchema, volumeRemovalSchema, type NewVolume, type VolumeRemoval } from "../../shared/volumes.js";
import {
  isLocked,
  networkRemovalSchema,
  newNetworkSchema,
  type NetworkRemoval,
  type NewNetwork,
} from "../../shared/networks.js";
import { rolloutJobSchema, type RolloutJob } from "../../shared/rollouts.js";
import type { ResourceMember, ResourcePermissions } from "../auth/resource-permissions.js";
import { actionPermission } from "../../shared/resource-permissions.js";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, notInArray, or } from "drizzle-orm";
import { z } from "zod";
import { API_ERRORS, type JobView } from "../../shared/api.js";
import {
  ACTOR_SYSTEM,
  ROLE_ADMIN,
  USER_STATUS_ACTIVE,
  AGENT_AUTOHEAL,
  AGENT_NAMES,
  AUDIT_ACTIONS,
  DIGEST_PATTERN,
  HOST_PACKAGE_ACTIONS,
  HOST_PACKAGE_ANSWER_MILLISECONDS,
  HOST_STATUS_ACTIVE,
  isHostPackageAction,
  isPowerAction,
  POWER,
  POWER_ACTIONS,
  POWER_OUTCOMES,
  JOB_ACTION,
  JOB_ANSWER_MILLISECONDS,
  CONTAINER_BACKUP_ACTIONS,
  CONTAINER_BACKUP_ANSWER_MILLISECONDS,
  JOB_EXPIRED,
  JOB_EXPIRY_MILLISECONDS,
  JOB_LIST_LIMIT,
  JOB_NO_ANSWER,
  JOB_OUTCOMES,
  JOB_REBOOTED,
  JOB_STATUS,
  MILLISECONDS_PER_MINUTE,
  OPEN_TASK_STATUSES,
  REPORT_LIMITS,
  SYSTEM_ACTOR_LABEL,
  TARGET_CONTAINER,
  TARGET_HOST,
  TASK_ACTIVITY,
  TASK_RESOURCE,
  TASK_STATUS,
  WHOLE_HOST_ACTIONS,
  UPDATE_POLICY,
  type JobAction,
  LIVE_EVENT,
} from "../../shared/constants.js";
import type { Job, JobProgress, JobResult, UpdateProgress } from "../../shared/protocol.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { hosts, jobs, users } from "../database/schema.js";
import { DomainError } from "../domain-error.js";
import type { HostRow } from "../hosts/hosts-service.js";
import type { InventoryService } from "../inventory/inventory-service.js";
import type { LiveEvents } from "../live/live-events.js";
import type { TaskAuthor, TasksService } from "../tasks/tasks-service.js";
import { jobViews, packagesOf, type JobRow } from "./job-views.js";

const OPEN_JOBS = [JOB_STATUS.pending, JOB_STATUS.delivered];
const AUTOHEAL: TaskAuthor = { kind: "agent", agent: AGENT_AUTOHEAL };
// Actions whose success means the task's update is done.
const UPDATE_ACTIONS: ReadonlySet<JobAction> = new Set([JOB_ACTION.update]);
const storedImages = z.array(z.string().regex(DIGEST_PATTERN)).max(REPORT_LIMITS.unusedImages);
const jsonOfNetwork = (value: NewNetwork | NetworkRemoval | undefined) =>
  value === undefined ? null : JSON.stringify(value);
const imagesOf = (json: string | null): string[] =>
  json === null ? [] : (storedImages.safeParse(JSON.parse(json)).data ?? []);
const jsonOf = (names: readonly string[]) => (names.length === 0 ? null : JSON.stringify(names));
// What a job names besides its container: the packages an upgrade upgrades, the images a removal removes.
// What a job names besides its container, and whether an update is put back at once when it does not hold.
interface JobDetails {
  rollout?: RolloutJob;
  expectedResourcesFingerprint?: string;
  packages?: readonly string[];
  images?: readonly string[];
  network?: NewNetwork;
  removal?: NetworkRemoval;
  volume?: NewVolume;
  volumeRemoval?: VolumeRemoval;
  stack?: StackJobDetails;
  backup?: BackupJobDetails;
  undoIfUnhealthy?: boolean;
}

export const bootIdOf = (host: HostRow): string | null =>
  host.healthJson === null ? null : ((JSON.parse(host.healthJson) as { bootId?: string | null }).bootId ?? null);

/**
 * Container actions asked for by a person or by Autoheal, delivered to the host's runner, which
 * re-checks them against its own rules. What each did is written into its task.
 */
export class JobsService {
  rolloutDispatchAllowed: (jobId: string) => boolean = () => false;
  private readonly finishedListeners: ((job: JobRow, succeeded: boolean) => void)[] = [];
  // Each update or recreate on its way: what its runner said of it last. Gone with the job's end, or a restart.
  private readonly progressOf = new Map<string, UpdateProgress>();

  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly auditLog: AuditLog,
    private readonly tasks: TasksService,
    private readonly inventory: Pick<InventoryService, "containers" | "unusedImages" | "networks" | "volumes">,
    private readonly live: Pick<LiveEvents, "publish">,
    private readonly clock: () => number = Date.now,
    private readonly maintenanceHeld: (hostId: string, name: string) => boolean = () => false,
    private readonly permissions?: ResourcePermissions,
  ) {}

  resetProgress() {
    this.progressOf.clear();
  }

  private get database() {
    return this.databaseHandle.database;
  }

  /** The same action already on its way is returned instead of sent twice (a double click). */
  request(
    author: TaskAuthor,
    hostId: string,
    containerName: string,
    action: JobAction,
    taskId: string | null,
    details: JobDetails = {},
  ): JobView {
    if (
      details.rollout &&
      (action !== JOB_ACTION.update ||
        author.kind !== "user" ||
        !this.permissions?.isAdmin(author.actor.userId) ||
        !details.expectedResourcesFingerprint)
    )
      throw new DomainError(API_ERRORS.resourceForbidden);
    if (author.kind === "user") this.requireUserPermission(author.actor.userId, hostId, containerName, action);
    if ((author.kind === "agent" || details.rollout) && this.maintenanceHeld(hostId, containerName))
      throw new DomainError(API_ERRORS.maintenanceActive);
    // Once each, and sorted: the same images ticked in another order are the same removal.
    const images = [...new Set(details.images)].toSorted();
    this.requireActiveHost(hostId);
    // Sorted too: the same networks ticked in another order are the same removal.
    const removal =
      details.removal === undefined
        ? undefined
        : { ...details.removal, names: [...new Set(details.removal.names)].toSorted() };
    const networkJson = jsonOfNetwork(details.network ?? removal);
    this.requireActionable(hostId, containerName, action, images);
    this.requireNetworkChange(hostId, action, details.network, removal);
    const volumeRemoval =
      details.volumeRemoval === undefined
        ? undefined
        : { ...details.volumeRemoval, names: [...new Set(details.volumeRemoval.names)].toSorted() };
    const volumeChange = details.volume ?? volumeRemoval;
    const volumeJson = volumeChange === undefined ? null : JSON.stringify(volumeChange);
    this.requireVolumeChange(hostId, action, details.volume, volumeRemoval);
    const stackJson = details.stack === undefined ? null : JSON.stringify(details.stack);
    this.requireStack(hostId, details.stack);
    if (taskId !== null) {
      this.requireSameContainer(
        taskId,
        hostId,
        containerName,
        author.kind === "user" && this.permissions !== undefined && !this.permissions.isAdmin(author.actor.userId),
      );
    }
    const imagesJson = jsonOf(images);
    const waiting = this.database
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.hostId, hostId),
          eq(jobs.containerName, containerName),
          eq(jobs.action, action),
          imagesJson === null ? isNull(jobs.imagesJson) : eq(jobs.imagesJson, imagesJson),
          networkJson === null ? isNull(jobs.networkJson) : eq(jobs.networkJson, networkJson),
          volumeJson === null ? isNull(jobs.volumeJson) : eq(jobs.volumeJson, volumeJson),
          stackJson === null ? isNull(jobs.stackJson) : eq(jobs.stackJson, stackJson),
          inArray(jobs.status, OPEN_JOBS),
        ),
      )
      .get();
    if (waiting !== undefined) {
      if (
        details.expectedResourcesFingerprint !== undefined &&
        waiting.expectedResourcesFingerprint !== details.expectedResourcesFingerprint
      )
        throw new DomainError(API_ERRORS.topologyPreviewExpired);
      if (
        (details.rollout || waiting.rolloutJson !== null) &&
        waiting.rolloutJson !== (details.rollout ? JSON.stringify(details.rollout) : null)
      )
        throw new DomainError(API_ERRORS.topologyPreviewExpired);
      return this.view(waiting.id);
    }
    const now = this.clock();
    const job = this.database
      .insert(jobs)
      .values({
        id: randomUUID(),
        hostId,
        taskId,
        containerName,
        action,
        operatorUserId:
          author.kind === "user" && this.permissions && !this.permissions.isAdmin(author.actor.userId)
            ? author.actor.userId
            : null,
        requestedByUserId: author.kind === "user" ? author.actor.userId : null,
        requestedByAgent: author.kind === "agent" ? author.agent : null,
        status: JOB_STATUS.pending,
        createdAt: now,
        expiresAt: now + JOB_EXPIRY_MILLISECONDS,
        packagesJson: jsonOf(details.packages ?? []),
        imagesJson,
        networkJson,
        volumeJson,
        stackJson,
        backupJson: details.backup === undefined ? null : JSON.stringify(details.backup),
        undoIfUnhealthy: details.undoIfUnhealthy ?? false,
        expectedResourcesFingerprint: details.expectedResourcesFingerprint ?? null,
        rolloutJson: details.rollout ? JSON.stringify(rolloutJobSchema.parse(details.rollout)) : null,
      })
      .returning()
      .get();
    this.audit(author, job);
    this.live.publish({ kind: LIVE_EVENT.job, hostId, jobId: job.id });
    if (taskId !== null) {
      this.tasks.addActivity(taskId, TASK_ACTIVITY.jobRequested, author, { action, jobId: job.id });
      this.startWork(taskId, author);
    }
    return this.view(job.id);
  }

  /** This host's waiting actions, each delivered once; ones nobody collected in time expire. */
  take(host: HostRow): Job[] {
    this.expireStale();
    const now = this.clock();
    const pending = this.database
      .select()
      .from(jobs)
      .where(and(eq(jobs.hostId, host.id), eq(jobs.status, JOB_STATUS.pending)))
      .all();
    const available = pending.filter((job) => {
      if (
        job.rolloutJson !== null &&
        (!host.rollouts || !this.rolloutDispatchAllowed(job.id) || this.maintenanceHeld(host.id, job.containerName))
      )
        return false;
      if (job.operatorUserId !== null && !host.resourcePermissions) {
        const outcome = JOB_OUTCOMES.delegationUnsupported;
        this.database
          .update(jobs)
          .set({ status: JOB_STATUS.failed, completedAt: now, outcome })
          .where(eq(jobs.id, job.id))
          .run();
        if (job.taskId !== null) this.finishWork(job, false, outcome);
        this.announce(job, false);
        return false;
      }
      if (job.expectedResourcesFingerprint !== null && !host.operationPreviews) {
        const outcome = JOB_OUTCOMES.reviewedScopeUnsupported;
        this.database
          .update(jobs)
          .set({ status: JOB_STATUS.failed, completedAt: now, outcome })
          .where(eq(jobs.id, job.id))
          .run();
        if (job.taskId !== null) this.finishWork(job, false, outcome);
        this.announce(job, false);
        return false;
      }
      if (job.requestedByAgent !== null) return !this.maintenanceHeld(host.id, job.containerName);
      try {
        if (!job.requestedByUserId) throw new DomainError(API_ERRORS.resourceForbidden);
        this.requireUserPermission(job.requestedByUserId, host.id, job.containerName, job.action);
        if (this.permissions && !this.permissions.isAdmin(job.requestedByUserId)) {
          if (!host.resourcePermissions) throw new DomainError(API_ERRORS.resourceRunnerRequired);
          job.operatorUserId = job.requestedByUserId;
          this.database.update(jobs).set({ operatorUserId: job.operatorUserId }).where(eq(jobs.id, job.id)).run();
        }
        return true;
      } catch {
        this.database
          .update(jobs)
          .set({
            status: JOB_STATUS.failed,
            completedAt: now,
            outcome: JOB_OUTCOMES.permissionRevoked,
          })
          .where(eq(jobs.id, job.id))
          .run();
        if (job.taskId !== null) this.finishWork(job, false, JOB_OUTCOMES.permissionRevokedBeforeDelivery);
        this.announce(job, false);
        return false;
      }
    });
    if (available.length === 0) {
      return [];
    }
    const bootId = bootIdOf(host);
    for (const job of available) {
      const deliveredBootId = isPowerAction(job.action) ? bootId : null;
      this.database
        .update(jobs)
        .set({ status: JOB_STATUS.delivered, deliveredAt: now, deliveredBootId })
        .where(eq(jobs.id, job.id))
        .run();
      this.live.publish({ kind: LIVE_EVENT.job, hostId: host.id, jobId: job.id });
    }
    const views = new Map(
      jobViews(
        this.databaseHandle,
        inArray(
          jobs.id,
          available.map(({ id }) => id),
        ),
        available.length + 1,
      ).map((view) => [view.id, view]),
    );
    return available.map((job): Job => {
      const delivered = {
        id: job.id,
        ...(job.operatorUserId ? { operatorUserId: job.operatorUserId } : {}),
        ...(job.expectedResourcesFingerprint ? { expectedResourcesFingerprint: job.expectedResourcesFingerprint } : {}),
        containerName: job.containerName,
        ...(job.requestedByAgent !== null || job.rolloutJson !== null ? { automatic: true } : {}),
        ...(job.rolloutJson ? { rollout: rolloutJobSchema.parse(JSON.parse(job.rolloutJson)) } : {}),
        requestedBy: views.get(job.id)?.requestedBy ?? AGENT_NAMES[AGENT_AUTOHEAL],
        expiresAt: job.expiresAt,
      };
      if (isHostPackageAction(job.action)) {
        return { ...delivered, action: job.action, packages: packagesOf(job.packagesJson) };
      }
      if (job.action === JOB_ACTION.removeImages) {
        return { ...delivered, action: job.action, images: imagesOf(job.imagesJson) };
      }
      if (job.backupJson !== null) {
        return {
          ...delivered,
          action: job.action as typeof JOB_ACTION.backupContainer,
          backup: backupJobSchema.parse(JSON.parse(job.backupJson)),
        };
      }
      if (job.stackJson !== null) {
        return {
          ...delivered,
          action: job.action as StackAction,
          stack: stackJobSchema.parse(JSON.parse(job.stackJson)),
        };
      }
      if (job.action === JOB_ACTION.createVolume) {
        return {
          ...delivered,
          action: job.action,
          volume: newVolumeSchema.parse(JSON.parse(job.volumeJson ?? "null")),
        };
      }
      if (job.action === JOB_ACTION.removeVolumes) {
        return {
          ...delivered,
          action: job.action,
          removal: volumeRemovalSchema.parse(JSON.parse(job.volumeJson ?? "null")),
        };
      }
      if (job.action === JOB_ACTION.createNetwork) {
        return {
          ...delivered,
          action: job.action,
          network: newNetworkSchema.parse(JSON.parse(job.networkJson ?? "null")),
        };
      }
      if (job.action === JOB_ACTION.removeNetworks) {
        return {
          ...delivered,
          action: job.action,
          removal: networkRemovalSchema.parse(JSON.parse(job.networkJson ?? "null")),
        };
      }
      return {
        ...delivered,
        action: job.action as ContainerJob["action"],
        ...(job.undoIfUnhealthy ? { undoIfUnhealthy: true } : {}),
        ...(job.action === JOB_ACTION.update &&
        job.requestedByUserId !== null &&
        !job.operatorUserId &&
        !job.rolloutJson
          ? { allowWithoutCheckpoint: true }
          : {}),
      };
    });
  }

  private requireUserPermission(userId: string, hostId: string, containerName: string, action: JobAction) {
    if (this.permissions) return this.permissions.requireJob(userId, hostId, containerName, action);
    const user = this.database.select().from(users).where(eq(users.id, userId)).get();
    if (!user || user.role !== ROLE_ADMIN || user.status !== USER_STATUS_ACTIVE)
      throw new DomainError(API_ERRORS.resourceForbidden);
  }

  /** A runner-discovered group is authorized against current grants after its operation lock is held. */
  authorizeOperator(host: HostRow, jobId: string, members: readonly ResourceMember[]): boolean {
    try {
      const job = this.database.select().from(jobs).where(eq(jobs.id, jobId)).get();
      if (
        !job ||
        job.hostId !== host.id ||
        job.status !== JOB_STATUS.delivered ||
        !job.requestedByUserId ||
        !this.permissions ||
        this.clock() >= job.expiresAt
      )
        return false;
      if (!members.some((member) => member.name === job.containerName)) return false;
      if (
        job.rolloutJson &&
        (!host.rollouts ||
          !this.permissions.isAdmin(job.requestedByUserId) ||
          !this.rolloutDispatchAllowed(job.id) ||
          members.some((member) => this.maintenanceHeld(host.id, member.name)))
      )
        return false;
      const action = actionPermission(job.action);
      if (action === null) return false;
      this.permissions.requireMembers(job.requestedByUserId, host.id, action, members);
      return true;
    } catch {
      return false;
    }
  }

  complete(host: HostRow, jobId: string, reported: JobResult) {
    const job = this.database.select().from(jobs).where(eq(jobs.id, jobId)).get();
    const awaitingLateResult =
      job?.deliveredAt != null && job.status === JOB_STATUS.failed && job.outcome === JOB_NO_ANSWER;
    if (job === undefined || job.hostId !== host.id || (job.status !== JOB_STATUS.delivered && !awaitingLateResult)) {
      throw new DomainError(API_ERRORS.jobNotFound);
    }
    // A host that came back from a new boot did what its reboot or shutdown asked, whatever its runner could say:
    // one that restarted with it may only know that it was interrupted.
    const result = this.cameBack(job, bootIdOf(host)) ? this.poweredOff(job) : reported;
    // Its listeners hear of it as it now is, with the runner's outcome.
    const finished = this.database
      .update(jobs)
      .set({
        status: result.succeeded ? JOB_STATUS.succeeded : JOB_STATUS.failed,
        completedAt: this.clock(),
        outcome: result.outcome,
        output: result.output,
        recoveryBackupId: job.action === JOB_ACTION.restoreContainer ? (result.recoveryBackupId ?? null) : null,
      })
      .where(eq(jobs.id, jobId))
      .returning()
      .get()!;
    if (job.taskId !== null) {
      this.finishWork(job, result.succeeded, result.outcome);
    }
    this.announce(finished, result.succeeded);
  }

  /** Told of each job's end: done, failed, never answered, or never collected in time. */
  onFinished(listener: (job: JobRow, succeeded: boolean) => void) {
    this.finishedListeners.push(listener);
  }

  /** A running job's live output (a package job's), or its progress (an update's), kept in memory and passed on. */
  progress(host: HostRow, jobId: string, progress: JobProgress) {
    const running = and(eq(jobs.id, jobId), eq(jobs.hostId, host.id), eq(jobs.status, JOB_STATUS.delivered));
    if (this.database.select({ id: jobs.id }).from(jobs).where(running).get() === undefined) {
      throw new DomainError(API_ERRORS.jobNotFound);
    }
    if (progress.output !== undefined) {
      this.database.update(jobs).set({ output: progress.output }).where(eq(jobs.id, jobId)).run();
    }
    if (progress.update !== undefined) {
      this.progressOf.set(jobId, progress.update);
      this.live.publish({ kind: LIVE_EVENT.progress, hostId: host.id, jobId, progress: progress.update });
    }
  }

  /**
   * A reboot's runner may go down before its answer gets out: the host coming back from a new boot
   * is the answer, then.
   */
  noteBoot(host: HostRow, bootId: string | null | undefined) {
    if (bootId === null || bootId === undefined) {
      return;
    }
    const poweredOff = this.database
      .select()
      .from(jobs)
      .where(
        and(eq(jobs.hostId, host.id), inArray(jobs.action, [...POWER_ACTIONS]), eq(jobs.status, JOB_STATUS.delivered)),
      )
      .all()
      .filter((job) => this.cameBack(job, bootId));
    for (const job of poweredOff) {
      this.complete(host, job.id, this.poweredOff(job));
    }
  }

  /**
   * A shutdown is done once its host has gone quiet: no runner is left on it to say so, and nothing else will until
   * someone powers it on.
   */
  finishShutdowns(lastSeenOf: (hostId: string) => number | null) {
    const now = this.clock();
    const quietSince = now - POWER.silentAfterMilliseconds;
    const delivered = this.database
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.action, JOB_ACTION.shutdown),
          eq(jobs.status, JOB_STATUS.delivered),
          lte(jobs.deliveredAt, quietSince),
        ),
      )
      .all()
      .filter((job) => (lastSeenOf(job.hostId) ?? 0) <= quietSince);
    for (const job of delivered) {
      const host = this.database.select().from(hosts).where(eq(hosts.id, job.hostId)).get();
      if (host !== undefined)
        this.complete(host, job.id, { succeeded: true, outcome: POWER_OUTCOMES.shutDown, output: null });
    }
  }

  // The host reports a boot other than the one it had when its reboot or shutdown was delivered.
  private cameBack(job: JobRow, bootId: string | null | undefined): boolean {
    return (
      isPowerAction(job.action as JobAction) &&
      job.deliveredBootId !== null &&
      bootId != null &&
      bootId !== job.deliveredBootId
    );
  }

  private poweredOff(job: JobRow): JobResult {
    if (job.action === JOB_ACTION.shutdown) {
      return { succeeded: true, outcome: POWER_OUTCOMES.shutDown, output: null };
    }
    const minutes = Math.round((this.clock() - (job.deliveredAt ?? this.clock())) / MILLISECONDS_PER_MINUTE);
    return { succeeded: true, outcome: JOB_REBOOTED(minutes), output: null };
  }

  list(hostId: string, containerName: string | undefined): JobView[] {
    // A host whose runner is gone collects nothing: what it would have expired must not read as still at work.
    this.expireStale();
    const forContainer = containerName === undefined ? undefined : eq(jobs.containerName, containerName);
    return jobViews(this.databaseHandle, and(eq(jobs.hostId, hostId), forContainer), JOB_LIST_LIMIT).map((view) =>
      this.withProgress(view),
    );
  }

  view(jobId: string): JobView {
    const [view] = jobViews(this.databaseHandle, eq(jobs.id, jobId), 1);
    if (view === undefined) {
      throw new DomainError(API_ERRORS.jobNotFound);
    }
    return this.withProgress(view);
  }

  private withProgress(view: JobView): JobView {
    return { ...view, progress: this.progressOf.get(view.id) ?? null };
  }

  // An action on the task's subject means someone (or Autoheal) is working on it now.
  private startWork(taskId: string, author: TaskAuthor) {
    const task = this.tasks.find(taskId);
    const idle = OPEN_TASK_STATUSES.includes(task.status) && task.status !== TASK_STATUS.inProgress;
    if (!idle) {
      return;
    }
    if (author.kind === "user") {
      this.tasks.change(author.actor, taskId, { status: TASK_STATUS.inProgress });
      return;
    }
    this.tasks.setByAutoheal(taskId, { status: TASK_STATUS.inProgress });
  }

  private finishWork(job: JobRow, succeeded: boolean, outcome: string) {
    const taskId = job.taskId!;
    this.tasks.addActivity(taskId, TASK_ACTIVITY.jobFinished, AUTOHEAL, {
      action: job.action,
      succeeded,
      outcome,
      jobId: job.id,
    });
    const task = this.tasks.find(taskId);
    const heldByAutoheal = task.assigneeAgent !== null;
    if (UPDATE_ACTIONS.has(job.action) && succeeded) {
      this.tasks.setByAutoheal(taskId, { status: TASK_STATUS.done });
    }
    // Autoheal could not finish it, or installed a host's packages: the task goes to a person, with the reason in
    // its activity. What packages are left is the next check's to say; with none, the task closes by itself.
    const handBack = !succeeded || isHostPackageAction(job.action);
    if (handBack && heldByAutoheal) {
      this.tasks.setByAutoheal(taskId, { status: TASK_STATUS.todo, assignee: this.tasks.owner() });
    }
    // A person's job that failed ends the work it began: the task waits for them again, and closes by itself once
    // its problem is gone.
    if (!succeeded && !heldByAutoheal && task.status === TASK_STATUS.inProgress) {
      this.tasks.setByAutoheal(taskId, { status: TASK_STATUS.todo });
    }
    this.tasks.release(taskId);
  }

  // A job about the host itself names no container: the audit entry is about the host.
  private audit(author: TaskAuthor, job: JobRow) {
    const aboutHost = job.containerName === "";
    const target = aboutHost
      ? { kind: TARGET_HOST, id: job.hostId }
      : { kind: TARGET_CONTAINER, id: `${job.hostId}/${job.containerName}` };
    const action = aboutHost ? AUDIT_ACTIONS.hostActionRequested : AUDIT_ACTIONS.containerActionRequested;
    const details = {
      action: job.action,
      taskId: job.taskId,
      packages: packagesOf(job.packagesJson),
      images: imagesOf(job.imagesJson),
    };
    if (author.kind === "user") {
      this.auditLog.recordUserAction(author.actor, action, target, details);
      return;
    }
    this.auditLog.record({
      actorKind: ACTOR_SYSTEM,
      actorLabel: SYSTEM_ACTOR_LABEL,
      action,
      targetKind: target.kind,
      targetId: target.id,
      details,
    });
  }

  // A task about one container can't be worked by acting on another.
  private requireSameContainer(taskId: string, hostId: string, containerName: string, delegated = false) {
    const task = this.tasks.find(taskId);
    const aboutContainer = task.resourceKind === TASK_RESOURCE.container;
    if (
      (delegated && !aboutContainer) ||
      ((aboutContainer || delegated) && (task.hostId !== hostId || task.resourceId !== containerName))
    ) {
      throw new DomainError(API_ERRORS.invalidTarget);
    }
  }

  private reportsNoDocker(hostId: string): boolean {
    return (
      this.database.select({ docker: hosts.docker }).from(hosts).where(eq(hosts.id, hostId)).get()?.docker === false
    );
  }

  private requireActiveHost(hostId: string) {
    const host = this.database.select({ status: hosts.status }).from(hosts).where(eq(hosts.id, hostId)).get();
    if (host === undefined) {
      throw new DomainError(API_ERRORS.hostNotFound);
    }
    if (host.status !== HOST_STATUS_ACTIVE) {
      throw new DomainError(API_ERRORS.hostRevoked);
    }
  }

  // A container action needs the container to exist; an update, a container that allows one; a removal, images
  // the host's runner reported unused.
  private requireActionable(hostId: string, containerName: string, action: JobAction, images: readonly string[]) {
    // A host that reports no Docker has only its own packages to act on, until Docker is there.
    if (!isHostPackageAction(action) && this.reportsNoDocker(hostId)) {
      throw new DomainError(API_ERRORS.hostHasNoDocker);
    }
    if (action === JOB_ACTION.removeImages) {
      this.requireUnused(hostId, images);
      return;
    }
    if (WHOLE_HOST_ACTIONS.has(action) || isHostPackageAction(action)) {
      return;
    }
    const container = this.inventory.containers({ hostId }).find((candidate) => candidate.name === containerName);
    if (container === undefined) {
      throw new DomainError(API_ERRORS.containerNotFound);
    }
    // The runner would refuse it: say so now instead of sending it.
    if (action !== JOB_ACTION.logs && container.handsOff !== null) {
      throw new DomainError(API_ERRORS.handsOff);
    }
    if (action === JOB_ACTION.update && container.update.policy === UPDATE_POLICY.off) {
      throw new DomainError(API_ERRORS.jobUnavailable);
    }
  }

  // Only what the host's runner reported: one from before networks were reported is never sent these.
  private requireNetworkChange(hostId: string, action: JobAction, network?: NewNetwork, removal?: NetworkRemoval) {
    if (action !== JOB_ACTION.createNetwork && action !== JOB_ACTION.removeNetworks) return;
    const reported = this.inventory.networks(hostId);
    if (reported === null) throw new DomainError(API_ERRORS.jobUnavailable);
    if (action === JOB_ACTION.createNetwork) {
      if (network === undefined) throw new DomainError(API_ERRORS.jobUnavailable);
      if (reported.some((each) => each.name === network.name)) throw new DomainError(API_ERRORS.networkNameTaken);
      return;
    }
    const chosen = removal?.names.map((name) => reported.find((each) => each.name === name)) ?? [];
    if (chosen.length === 0 || chosen.some((each) => each === undefined || isLocked(each))) {
      throw new DomainError(API_ERRORS.networkNotFound);
    }
  }

  // Only a project on this host, and none with a container the host keeps to itself.
  private requireStack(hostId: string, stack?: StackJobDetails) {
    if (stack === undefined) return;
    const members = this.inventory
      .containers({ hostId })
      .filter(({ composeProject }) => composeProject === stack.project);
    if (members.length === 0) throw new DomainError(API_ERRORS.stackNotFound);
    if (members.some(({ handsOff }) => handsOff !== null)) throw new DomainError(API_ERRORS.handsOff);
  }

  private requireVolumeChange(hostId: string, action: JobAction, volume?: NewVolume, removal?: VolumeRemoval) {
    if (action !== JOB_ACTION.createVolume && action !== JOB_ACTION.removeVolumes) return;
    const reported = this.inventory.volumes(hostId);
    if (reported === null) throw new DomainError(API_ERRORS.jobUnavailable);
    if (action === JOB_ACTION.createVolume) {
      if (volume === undefined) throw new DomainError(API_ERRORS.jobUnavailable);
      if (reported.some((each) => each.name === volume.name)) throw new DomainError(API_ERRORS.volumeNameTaken);
      return;
    }
    const chosen = removal?.names.map((name) => reported.find((each) => each.name === name)) ?? [];
    if (chosen.length === 0 || chosen.some((each) => each === undefined || each.own)) {
      throw new DomainError(API_ERRORS.volumeNotFound);
    }
  }

  private requireUnused(hostId: string, images: readonly string[]) {
    const unused = new Set((this.inventory.unusedImages(hostId) ?? []).map((image) => image.id));
    if (images.length === 0 || images.some((id) => !unused.has(id))) {
      throw new DomainError(API_ERRORS.imageNotFound);
    }
  }

  private expireStale() {
    const now = this.clock();
    const expired = this.database
      .update(jobs)
      .set({ status: JOB_STATUS.expired, completedAt: now })
      .where(and(eq(jobs.status, JOB_STATUS.pending), lte(jobs.expiresAt, now)))
      .returning()
      .all();
    const deliveredBefore = (milliseconds: number) =>
      and(eq(jobs.status, JOB_STATUS.delivered), lte(jobs.deliveredAt, now - milliseconds));
    const unanswered = this.database
      .update(jobs)
      .set({ status: JOB_STATUS.failed, completedAt: now, outcome: JOB_NO_ANSWER })
      .where(
        or(
          and(
            deliveredBefore(JOB_ANSWER_MILLISECONDS),
            notInArray(jobs.action, [...HOST_PACKAGE_ACTIONS, ...CONTAINER_BACKUP_ACTIONS]),
          ),
          and(deliveredBefore(CONTAINER_BACKUP_ANSWER_MILLISECONDS), inArray(jobs.action, CONTAINER_BACKUP_ACTIONS)),
          and(deliveredBefore(HOST_PACKAGE_ANSWER_MILLISECONDS), inArray(jobs.action, HOST_PACKAGE_ACTIONS)),
        ),
      )
      .returning()
      .all();
    for (const job of [...expired, ...unanswered].filter((candidate) => candidate.taskId !== null)) {
      this.finishWork(job, false, job.outcome ?? JOB_EXPIRED);
    }
    for (const job of [...expired, ...unanswered]) {
      this.announce(job, false);
    }
  }

  private announce(job: JobRow, succeeded: boolean) {
    this.progressOf.delete(job.id);
    this.live.publish({ kind: LIVE_EVENT.job, hostId: job.hostId, jobId: job.id });
    for (const listener of this.finishedListeners) {
      listener(job, succeeded);
    }
  }
}
