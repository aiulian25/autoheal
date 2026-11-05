import type { AvailabilityGroupsService } from "../inventory/availability-groups-service.js";
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { API_ERRORS } from "../../shared/api.js";
import {
  AUDIT_ACTIONS,
  HOST_SILENT_AFTER_MILLISECONDS,
  HOST_STATUS_ACTIVE,
  JOB_ACTION,
  JOB_STATUS,
} from "../../shared/constants.js";
import { describeError } from "../../shared/errors.js";
import { log } from "../../shared/log.js";
import {
  canonicalRepository,
  rolloutCreateSchema,
  rolloutViewSchema,
  ROLLOUT_LIMITS,
  ROLLOUT_MESSAGES,
  ROLLOUT_REASONS,
  type RolloutCreate,
  type RolloutView,
} from "../../shared/rollouts.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { ResourcePermissions } from "../auth/resource-permissions.js";
import type { DatabaseHandle } from "../database/connection.js";
import { hosts, jobs } from "../database/schema.js";
import { DomainError } from "../domain-error.js";
import type { InventoryService } from "../inventory/inventory-service.js";
import type { TopologyService } from "../inventory/topology-service.js";
import type { JobsService } from "./jobs-service.js";
import { rollouts } from "./rollout-schema.js";
const active = (state: RolloutView) => ["updating", "observing", "ready"].includes(state.status);
type RolloutRow = typeof rollouts.$inferSelect;
type ReadResult = { plan: RolloutView } | { plan: null; problem: string };
// The plan a saved row holds, or why this version cannot read it: not JSON, or not a rollout it knows.
function planOf(row: RolloutRow): ReadResult {
  let state: unknown;
  try {
    state = JSON.parse(row.stateJson);
  } catch (error) {
    return { plan: null, problem: describeError(error) };
  }
  const parsed = rolloutViewSchema.safeParse(state);
  if (parsed.success) return { plan: parsed.data };
  const problem = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  return { plan: null, problem };
}
// What the page shows for a row this version cannot read. Nothing acts on it, rewrites it or deletes it.
const unreadable = (row: RolloutRow): RolloutView => ({
  id: row.id,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  createdBy: "",
  status: "inconclusive",
  targets: [],
  current: 0,
  observeMilliseconds: 0,
  observeStartedAt: null,
  lastSampleAt: null,
  samples: 0,
  serviceVerificationRequired: false,
  externalDataIsolated: true,
  reason: ROLLOUT_REASONS.unreadable,
  rollbackReadiness: "startup_only_then_manual",
});
/** Serial, immutable, stateless-only rollouts. Observation never promises a retained rollback point. */
export class RolloutService {
  private readonly reportedUnreadable = new Set<string>();
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly audit: AuditLog,
    private readonly permissions: Pick<ResourcePermissions, "isAdmin">,
    private readonly inventory: Pick<InventoryService, "containers">,
    private readonly topology: Pick<TopologyService, "view" | "consumeImpact">,
    private readonly jobsService: Pick<JobsService, "request" | "onFinished" | "rolloutDispatchAllowed">,
    private readonly maintenanceHeld: (hostId: string, name: string) => boolean,
    private readonly clock = Date.now,
    // What an application's replicas say about replacing this container; absent where no group is set up.
    private readonly availability?: Pick<AvailabilityGroupsService, "problemFor">,
  ) {
    jobsService.rolloutDispatchAllowed = (jobId) =>
      this.plans().some(
        (plan) => plan.status === "updating" && plan.targets[plan.current]?.jobId === jobId && this.actorAllowed(plan),
      );
    jobsService.onFinished((job, succeeded) => {
      if (!job.rolloutJson) return;
      const plan = this.plans().find((value) => value.targets[value.current]?.jobId === job.id);
      if (!plan || plan.status !== "updating") return;
      plan.status = succeeded ? "observing" : "failed";
      plan.reason = succeeded ? ROLLOUT_REASONS.awaitingReport : (job.outcome ?? ROLLOUT_REASONS.updateFailed);
      plan.updatedAt = this.clock();
      plan.observeStartedAt = null;
      plan.lastSampleAt = null;
      plan.samples = 0;
      this.save(plan);
    });
  }
  private get database() {
    return this.handle.database;
  }
  private requireAdmin(actor: Actor) {
    if (!this.permissions.isAdmin(actor.userId)) throw new DomainError(API_ERRORS.resourceForbidden);
  }
  private actorAllowed(plan: RolloutView) {
    try {
      return this.permissions.isAdmin(plan.createdBy);
    } catch {
      return false;
    }
  }
  private rows(): RolloutRow[] {
    return this.database.select().from(rollouts).orderBy(desc(rollouts.createdAt)).limit(ROLLOUT_LIMITS.retained).all();
  }
  // The plans this version can read, newest first: the only ones anything here acts on.
  /** The containers a rollout under way still has to replace: what an availability group counts as going down. */
  containersStillToReplace(): { hostId: string; containerName: string }[] {
    return this.plans()
      .filter(active)
      .flatMap((plan) =>
        plan.targets.slice(plan.current).map(({ hostId, containerName }) => ({ hostId, containerName })),
      );
  }

  private plans(): RolloutView[] {
    const plans: RolloutView[] = [];
    for (const row of this.rows()) {
      const read = planOf(row);
      if (read.plan === null) {
        this.reportUnreadable(row.id, read.problem);
        continue;
      }
      plans.push(read.plan);
    }
    return plans;
  }
  private reportUnreadable(id: string, problem: string) {
    if (this.reportedUnreadable.has(id)) return;
    this.reportedUnreadable.add(id);
    log(ROLLOUT_MESSAGES.unreadable(id, problem));
  }
  /** Every rollout for the page, newest first; one whose saved state cannot be read shows as inconclusive. */
  list(): RolloutView[] {
    return this.rows().map((row) => planOf(row).plan ?? unreadable(row));
  }
  private save(plan: RolloutView) {
    plan.updatedAt = this.clock();
    this.database
      .insert(rollouts)
      .values({ id: plan.id, createdAt: plan.createdAt, updatedAt: plan.updatedAt, stateJson: JSON.stringify(plan) })
      .onConflictDoUpdate({ target: rollouts.id, set: { updatedAt: plan.updatedAt, stateJson: JSON.stringify(plan) } })
      .run();
  }
  private requirePlan(id: string) {
    const plan = this.plans().find((value) => value.id === id);
    if (!plan) throw new DomainError(API_ERRORS.rolloutNotFound);
    return plan;
  }
  create(actor: Actor, session: string, body: RolloutCreate): RolloutView {
    this.requireAdmin(actor);
    const input = rolloutCreateSchema.parse(body);
    if (
      this.plans().some(
        (plan) =>
          active(plan) ||
          (plan.status === "held" &&
            plan.targets.some((target) => {
              if (!target.jobId) return false;
              const job = this.database.select().from(jobs).where(eq(jobs.id, target.jobId)).get();
              return job?.status === JOB_STATUS.pending || job?.status === JOB_STATUS.delivered;
            })),
      )
    )
      throw new DomainError(API_ERRORS.rolloutBusy);
    if (new Set(input.targets.map((target) => target.hostId)).size > ROLLOUT_LIMITS.hosts)
      throw new DomainError(API_ERRORS.invalidRequest);
    const now = this.clock();
    const targets = input.targets.map((target) => {
      const host = this.database.select().from(hosts).where(eq(hosts.id, target.hostId)).get();
      const graph = this.topology.view(target.hostId);
      const container = this.inventory
        .containers({ hostId: target.hostId })
        .find((value) => value.name === target.containerName);
      if (
        !host?.rollouts ||
        host.status !== HOST_STATUS_ACTIVE ||
        !graph.available ||
        graph.stale ||
        !graph.snapshot ||
        graph.snapshot.truncated ||
        graph.snapshot.notes.length ||
        !container?.containerId ||
        this.maintenanceHeld(target.hostId, target.containerName)
      )
        throw new DomainError(API_ERRORS.rolloutUnavailable);
      if (canonicalRepository(container.image) !== canonicalRepository(target.targetReference))
        throw new DomainError(API_ERRORS.rolloutGate);
      const review = this.topology.consumeImpact(
        session,
        target.hostId,
        target.containerName,
        JOB_ACTION.update,
        target.previewId,
      );
      const proof = review.answer.rolloutSafety;
      const members = review.answer.members.map((member) => member.name);
      if (members.length !== 1 || members[0] !== target.containerName) throw new DomainError(API_ERRORS.rolloutGate);
      if (
        !proof ||
        proof.writableData !== "none" ||
        !proof.platform ||
        !proof.sourceContainerId ||
        !proof.sourceContainerId.startsWith(container.containerId) ||
        review.answer.members.some((member) => member.protected) ||
        graph.snapshot.edges.some(
          (edge) => edge.kind === "shared_writable_data" && (members.includes(edge.from) || members.includes(edge.to)),
        )
      )
        throw new DomainError(API_ERRORS.rolloutGate);
      if (members.some((name) => this.maintenanceHeld(target.hostId, name)))
        throw new DomainError(API_ERRORS.maintenanceActive);
      // A canary is not an application's quorum: what the replicas of this container say is asked as well, about
      // this target and every target this rollout has still to replace.
      const availability = this.availability?.problemFor({
        containers: [{ hostId: target.hostId, containerName: target.containerName }],
      });
      if (availability !== null && availability !== undefined) throw new DomainError(API_ERRORS.availabilityGate);
      return {
        hostId: target.hostId,
        containerName: target.containerName,
        targetReference: target.targetReference,
        sourceContainerId: proof.sourceContainerId,
        platform: proof.platform,
        fingerprint: review.answer.fingerprint,
        members,
        jobId: null,
        replacementId: null,
        baselineRestarts: null,
      };
    });
    // One cohort cannot contain overlapping coordinator members on the same host.
    const memberships = targets.flatMap((target) => target.members.map((name) => `${target.hostId}/${name}`));
    if (new Set(memberships).size !== memberships.length) throw new DomainError(API_ERRORS.rolloutGate);
    const retained = this.plans();
    for (const old of retained.slice(ROLLOUT_LIMITS.retained - 1))
      this.database.delete(rollouts).where(eq(rollouts.id, old.id)).run();
    const plan: RolloutView = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      createdBy: actor.userId,
      status: "updating",
      targets,
      current: 0,
      observeMilliseconds: input.observeMinutes * 60_000,
      observeStartedAt: null,
      lastSampleAt: null,
      samples: 0,
      serviceVerificationRequired: input.serviceVerificationRequired,
      externalDataIsolated: true,
      reason: null,
      rollbackReadiness: "startup_only_then_manual",
    };
    this.save(plan);
    try {
      this.dispatch(plan, actor);
    } catch (error) {
      plan.status = "failed";
      plan.reason = ROLLOUT_REASONS.firstUpdateNotQueued;
      this.save(plan);
      throw error;
    }
    this.audit.recordUserAction(
      actor,
      AUDIT_ACTIONS.rolloutCreated,
      { kind: "rollout", id: plan.id },
      { targets: targets.length, externalDataIsolated: true },
    );
    return plan;
  }
  private dispatch(plan: RolloutView, actor: Actor) {
    this.requireAdmin(actor);
    const target = plan.targets[plan.current]!;
    if (this.maintenanceHeld(target.hostId, target.containerName)) throw new DomainError(API_ERRORS.maintenanceActive);
    const job = this.jobsService.request(
      { kind: "user", actor },
      target.hostId,
      target.containerName,
      JOB_ACTION.update,
      null,
      {
        expectedResourcesFingerprint: target.fingerprint,
        undoIfUnhealthy: true,
        rollout: {
          id: plan.id,
          targetReference: target.targetReference,
          expectedSourceContainerId: target.sourceContainerId,
          expectedPlatform: target.platform,
          requireStateless: true,
        },
      },
    );
    target.jobId = job.id;
    plan.status = "updating";
    plan.reason = null;
    plan.observeStartedAt = null;
    plan.samples = 0;
    plan.lastSampleAt = null;
    this.save(plan);
  }
  hold(actor: Actor, id: string) {
    this.requireAdmin(actor);
    const plan = this.requirePlan(id);
    if (!active(plan)) throw new DomainError(API_ERRORS.rolloutGate);
    plan.status = "held";
    plan.reason = ROLLOUT_REASONS.heldByAdministrator;
    this.save(plan);
    this.audit.recordUserAction(actor, AUDIT_ACTIONS.rolloutHeld, { kind: "rollout", id });
    return plan;
  }
  promote(actor: Actor, id: string, serviceVerified: boolean) {
    this.requireAdmin(actor);
    this.tick();
    const plan = this.requirePlan(id);
    if (plan.status !== "ready" || (plan.serviceVerificationRequired && !serviceVerified))
      throw new DomainError(API_ERRORS.rolloutGate);
    this.audit.recordUserAction(
      actor,
      AUDIT_ACTIONS.rolloutPromoted,
      { kind: "rollout", id },
      { cohort: plan.current, serviceVerified },
    );
    if (plan.current === plan.targets.length - 1) {
      plan.status = "completed";
      plan.reason = ROLLOUT_REASONS.completed;
      this.save(plan);
      return plan;
    }
    plan.current++;
    this.dispatch(plan, actor);
    return plan;
  }
  tick() {
    const now = this.clock();
    for (const plan of this.plans()) {
      if (!active(plan) && plan.status !== "held" && now - plan.updatedAt > ROLLOUT_LIMITS.retention) {
        this.database.delete(rollouts).where(eq(rollouts.id, plan.id)).run();
        continue;
      }
      if (!active(plan) || plan.status === "held") continue;
      if (!this.actorAllowed(plan)) {
        plan.status = "held";
        plan.reason = ROLLOUT_REASONS.requesterUnauthorized;
        this.save(plan);
        continue;
      }
      let priorProblem = false;
      for (const prior of plan.targets.slice(0, plan.current)) {
        const previousHost = this.database.select().from(hosts).where(eq(hosts.id, prior.hostId)).get();
        if (
          !previousHost ||
          previousHost.status !== HOST_STATUS_ACTIVE ||
          !previousHost.lastHeartbeatAt ||
          now < previousHost.lastHeartbeatAt ||
          now - previousHost.lastHeartbeatAt > HOST_SILENT_AFTER_MILLISECONDS
        ) {
          plan.status = "inconclusive";
          plan.reason = ROLLOUT_REASONS.earlierCohortStale;
          priorProblem = true;
          break;
        }
        const previous = this.inventory
          .containers({ hostId: prior.hostId })
          .find((value) => value.name === prior.containerName);
        if (
          !previous ||
          previous.containerId !== prior.replacementId ||
          previous.image !== prior.targetReference ||
          previous.state !== "running" ||
          !["healthy", "none"].includes(previous.health) ||
          previous.restartCount !== prior.baselineRestarts
        ) {
          plan.status = "failed";
          plan.reason = ROLLOUT_REASONS.earlierCohortChanged;
          priorProblem = true;
          break;
        }
      }
      if (priorProblem) {
        this.save(plan);
        continue;
      }
      const target = plan.targets[plan.current]!;
      const job = target.jobId ? this.database.select().from(jobs).where(eq(jobs.id, target.jobId)).get() : undefined;
      if (!job) {
        plan.status = "inconclusive";
        plan.reason = ROLLOUT_REASONS.jobUnavailable;
        this.save(plan);
        continue;
      }
      if (plan.status === "updating") {
        if ([JOB_STATUS.failed, JOB_STATUS.expired].includes(job.status as typeof JOB_STATUS.failed)) {
          plan.status = "failed";
          plan.reason = job.outcome ?? ROLLOUT_REASONS.updateIncomplete;
          this.save(plan);
        } else if (job.status === JOB_STATUS.succeeded) {
          plan.status = "observing";
          this.save(plan);
        }
        continue;
      }
      const host = this.database.select().from(hosts).where(eq(hosts.id, target.hostId)).get();
      if (
        !host ||
        host.status !== HOST_STATUS_ACTIVE ||
        !host.lastHeartbeatAt ||
        now < host.lastHeartbeatAt ||
        now - host.lastHeartbeatAt > HOST_SILENT_AFTER_MILLISECONDS
      ) {
        plan.status = "inconclusive";
        plan.reason = ROLLOUT_REASONS.observationUnavailable;
        this.save(plan);
        continue;
      }
      if (host.lastHeartbeatAt <= (job.completedAt ?? job.createdAt)) {
        if (now - (job.completedAt ?? job.createdAt) > HOST_SILENT_AFTER_MILLISECONDS) {
          plan.status = "inconclusive";
          plan.reason = ROLLOUT_REASONS.noFreshReport;
          this.save(plan);
        }
        continue;
      }
      const members = this.inventory
        .containers({ hostId: target.hostId })
        .filter((container) => target.members.includes(container.name));
      const container = members.find((value) => value.name === target.containerName);
      if (
        members.length !== target.members.length ||
        !container ||
        container.image !== target.targetReference ||
        target.sourceContainerId.startsWith(container.containerId) ||
        members.some((value) => value.state !== "running" || !["healthy", "none"].includes(value.health))
      ) {
        plan.status = "failed";
        plan.reason = ROLLOUT_REASONS.memberMismatch;
        this.save(plan);
        continue;
      }
      if (
        target.replacementId &&
        (container.containerId !== target.replacementId || container.restartCount !== (target.baselineRestarts ?? 0))
      ) {
        plan.status = "failed";
        plan.reason = ROLLOUT_REASONS.replacementChanged;
        this.save(plan);
        continue;
      }
      if (plan.observeStartedAt === null) {
        plan.observeStartedAt = now;
        target.replacementId = container.containerId;
        target.baselineRestarts = container.restartCount;
      }
      if (host.lastHeartbeatAt !== (plan.lastSampleAt ?? -1)) {
        plan.lastSampleAt = host.lastHeartbeatAt;
        plan.samples++;
      }
      if (now < plan.observeStartedAt) {
        plan.status = "inconclusive";
        plan.reason = ROLLOUT_REASONS.clockMovedBackwards;
      } else if (now - plan.observeStartedAt >= plan.observeMilliseconds && plan.samples >= 3) {
        plan.status = "ready";
        plan.reason = ROLLOUT_REASONS.observationPassed;
      } else if (now - plan.observeStartedAt > plan.observeMilliseconds + HOST_SILENT_AFTER_MILLISECONDS) {
        plan.status = "inconclusive";
        plan.reason = ROLLOUT_REASONS.insufficientReports;
      }
      this.save(plan);
    }
  }
}
