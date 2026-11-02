import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { API_ERRORS } from "../../shared/api.js";
import {
  AUDIT_ACTIONS,
  DETECTOR_KEYS,
  HOST_KIND,
  HOST_STATUS_ACTIVE,
  JOB_ACTION,
  JOB_STATUS,
  POWER_PHASE,
  POWER_SETTLED,
  TARGET_HOST,
} from "../../shared/constants.js";
import { describeError } from "../../shared/errors.js";
import { log } from "../../shared/log.js";
import {
  REBOOT_PLAN,
  REBOOT_PLAN_STATUS,
  REBOOT_PLAN_TEXT,
  REBOOT_STEP_STATUS,
  rebootPlanViewSchema,
  type RebootPlanBody,
  type RebootPlanPreview,
  type RebootPlanView,
  type RebootStep,
} from "../../shared/reboot-plans.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { ResourcePermissions } from "../auth/resource-permissions.js";
import type { DatabaseHandle } from "../database/connection.js";
import { hosts, jobs } from "../database/schema.js";
import { DomainError } from "../domain-error.js";
import type { HostRow } from "../hosts/hosts-service.js";
import type { HostPackagesService } from "../host-packages/host-packages-service.js";
import type { ProbeService } from "../probes/probe-service.js";
import type { PowerService } from "./power-service.js";
import { rebootPlans } from "./reboot-plans-schema.js";

const MILLISECONDS_PER_MINUTE = 60_000;
const OPEN_JOB_STATUSES = [JOB_STATUS.pending, JOB_STATUS.delivered];
const isOpen = ({ status }: RebootPlanView) =>
  status === REBOOT_PLAN_STATUS.running || status === REBOOT_PLAN_STATUS.paused;
const notEnded = ({ status }: RebootStep) =>
  status !== REBOOT_STEP_STATUS.done && status !== REBOOT_STEP_STATUS.cancelled;

const reasonOf = (error: unknown) =>
  error instanceof DomainError ? (REBOOT_PLAN_TEXT.jobRefusals[error.code] ?? error.code) : describeError(error);

export interface RebootPlanFinding {
  key: string;
  hostId: string;
  hostLabel: string;
  title: string;
  description: string;
}

export interface RebootPlanDependencies {
  databaseHandle: DatabaseHandle;
  audit: AuditLog;
  permissions: Pick<ResourcePermissions, "isAdmin">;
  // The same way in as the Reboot button: it refuses a host that cannot be asked, or that has a job still open.
  hostPackages: Pick<HostPackagesService, "request">;
  power: Pick<PowerService, "powerOf" | "rebootProgress" | "lastSeenOf">;
  probes: Pick<ProbeService, "evidence" | "nameOf">;
  rebootRequired: (hostId: string) => boolean | null;
  clock: () => number;
}

/**
 * Reboots across several hosts, one at a time, never leaving fewer healthy than the plan says. Every step is decided
 * from what is true now, and from the saved plan alone, so a restart carries on without asking any host twice.
 */
export class RebootPlansService {
  private readonly reportedUnreadable = new Set<string>();

  constructor(private readonly dependencies: RebootPlanDependencies) {}

  private get database() {
    return this.dependencies.databaseHandle.database;
  }

  private plans(): RebootPlanView[] {
    const rows = this.database.select().from(rebootPlans).orderBy(desc(rebootPlans.createdAt)).all();
    return rows.flatMap(({ id, stateJson }) => {
      const parsed = rebootPlanViewSchema.safeParse(JSON.parse(stateJson));
      if (parsed.success) return [parsed.data];
      // Nothing acts on a plan this version cannot read.
      if (!this.reportedUnreadable.has(id)) log(`Reboot plan ${id} could not be read: ${parsed.error.message}`);
      this.reportedUnreadable.add(id);
      return [];
    });
  }

  private save(plan: RebootPlanView) {
    plan.updatedAt = this.dependencies.clock();
    const stateJson = JSON.stringify(plan);
    this.database
      .insert(rebootPlans)
      .values({ id: plan.id, createdAt: plan.createdAt, updatedAt: plan.updatedAt, stateJson })
      .onConflictDoUpdate({ target: rebootPlans.id, set: { updatedAt: plan.updatedAt, stateJson } })
      .run();
  }

  list(): RebootPlanView[] {
    return this.plans().slice(0, REBOOT_PLAN.retained);
  }

  private hostRow(hostId: string): HostRow | undefined {
    return this.database.select().from(hosts).where(eq(hosts.id, hostId)).get();
  }

  // Null when the host is up, heard from just now, not on its way down, and has finished starting.
  private hostProblem(host: HostRow | undefined, label: string) {
    if (host === undefined || host.status !== HOST_STATUS_ACTIVE) return REBOOT_PLAN_TEXT.notActive(label);
    const seenAt = this.dependencies.power.lastSeenOf(host);
    const now = this.dependencies.clock();
    if (seenAt === null || now - seenAt > REBOOT_PLAN.freshMilliseconds) return REBOOT_PLAN_TEXT.notFresh(label);
    const phase = this.dependencies.power.powerOf(host)?.phase;
    if (phase !== undefined && !POWER_SETTLED.includes(phase)) return REBOOT_PLAN_TEXT.rebooting(label);
    if (phase === POWER_PHASE.off) return REBOOT_PLAN_TEXT.rebooting(label);
    if (host.docker && !host.eventStreamConnected) return REBOOT_PLAN_TEXT.stillStarting(label);
    return null;
  }

  private checksProblem(body: RebootPlanBody, since: number | null) {
    for (const probeId of body.probeIds) {
      const problem = this.dependencies.probes.evidence(probeId, since);
      if (problem !== null) return problem;
    }
    return null;
  }

  /** Why the next host may not go down now; null when it may. Asked fresh before every reboot. */
  private gateProblem(plan: Pick<RebootPlanView, "body" | "createdBy">, target: { hostId: string; hostLabel: string }) {
    const { body, createdBy } = plan;
    if (!this.dependencies.permissions.isAdmin(createdBy.userId)) return REBOOT_PLAN_TEXT.noLongerAllowed;
    const targetProblem = this.hostProblem(this.hostRow(target.hostId), target.hostLabel);
    if (targetProblem !== null) return targetProblem;
    const others = body.hostIds.filter((hostId) => hostId !== target.hostId);
    const healthy = others.filter((hostId) => this.hostProblem(this.hostRow(hostId), "") === null).length;
    if (healthy < body.minimumHealthy) {
      return REBOOT_PLAN_TEXT.tooFew(healthy, body.minimumHealthy, target.hostLabel);
    }
    return this.checksProblem(body, null);
  }

  // The control plane's own machine could not follow its own reboot, and a host with no boot id cannot show it is back.
  private eligibleHosts(body: RebootPlanBody) {
    return body.hostIds.map((hostId) => {
      const host = this.hostRow(hostId);
      const eligible = host?.status === HOST_STATUS_ACTIVE && host.kind !== HOST_KIND.local;
      if (!eligible) throw new DomainError(API_ERRORS.rebootPlanUnavailable);
      return host;
    });
  }

  preview(actor: Pick<Actor, "userId" | "username">, body: RebootPlanBody): RebootPlanPreview {
    const members = this.eligibleHosts(body);
    const first = members[0]!;
    return {
      hosts: members.map((host) => ({
        hostId: host.id,
        label: host.label,
        problem: this.hostProblem(host, host.label),
        rebootRequired: this.dependencies.rebootRequired(host.id),
        openJobs: this.database
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.hostId, host.id), inArray(jobs.status, OPEN_JOB_STATUSES)))
          .all().length,
      })),
      checks: body.probeIds.map((probeId) => ({
        probeId,
        name: this.dependencies.probes.nameOf(probeId) ?? probeId,
        problem: this.dependencies.probes.evidence(probeId, null),
      })),
      problem: this.gateProblem({ body, createdBy: actor }, { hostId: first.id, hostLabel: first.label }),
    };
  }

  /** Approves one plan as it stands: it never changes after this. */
  create(actor: Actor, body: RebootPlanBody): RebootPlanView {
    if (this.plans().some(isOpen)) throw new DomainError(API_ERRORS.rebootPlanBusy);
    const members = this.eligibleHosts(body);
    const now = this.dependencies.clock();
    const plan: RebootPlanView = {
      id: randomUUID(),
      body,
      status: REBOOT_PLAN_STATUS.running,
      createdBy: { userId: actor.userId, username: actor.username },
      createdAt: now,
      updatedAt: now,
      cancelAsked: false,
      reason: null,
      steps: members.map((host) => ({
        hostId: host.id,
        hostLabel: host.label,
        status: REBOOT_STEP_STATUS.waiting,
        jobId: null,
        followingSince: null,
        backAt: null,
        doneAt: null,
      })),
    };
    const startsLater = body.notBefore !== null && body.notBefore > now;
    const problem = startsLater ? null : this.gateProblem(plan, plan.steps[0]!);
    if (problem !== null) throw new DomainError(API_ERRORS.rebootPlanNotReady);
    this.save(plan);
    this.note(actor, AUDIT_ACTIONS.rebootPlanApproved, plan);
    this.tick();
    return this.planOf(plan.id);
  }

  private note(actor: Actor, action: Parameters<AuditLog["recordUserAction"]>[1], plan: RebootPlanView) {
    this.dependencies.audit.recordUserAction(
      actor,
      action,
      { kind: TARGET_HOST, id: plan.steps[0]!.hostId },
      { planId: plan.id, name: plan.body.name, hosts: plan.steps.map(({ hostLabel }) => hostLabel) },
    );
  }

  private planOf(planId: string) {
    const plan = this.plans().find(({ id }) => id === planId);
    if (plan === undefined) throw new DomainError(API_ERRORS.rebootPlanNotFound);
    return plan;
  }

  /** A person says to carry on: everything is asked fresh, and a reboot already asked is followed, never asked again. */
  resume(actor: Actor, planId: string): RebootPlanView {
    const plan = this.planOf(planId);
    if (plan.status !== REBOOT_PLAN_STATUS.paused) throw new DomainError(API_ERRORS.rebootPlanBusy);
    const now = this.dependencies.clock();
    for (const step of plan.steps) {
      if (step.status === REBOOT_STEP_STATUS.refused) {
        step.status = REBOOT_STEP_STATUS.waiting;
        step.jobId = null;
        step.followingSince = null;
      }
      if (step.status === REBOOT_STEP_STATUS.asked || step.status === REBOOT_STEP_STATUS.back) {
        step.followingSince = now;
      }
    }
    plan.status = REBOOT_PLAN_STATUS.running;
    plan.reason = null;
    this.save(plan);
    this.note(actor, AUDIT_ACTIONS.rebootPlanResumed, plan);
    this.tick();
    return this.planOf(planId);
  }

  /** Stops what has not begun. A reboot already asked of a host goes on, and stays followed until it is settled. */
  cancel(actor: Actor, planId: string): RebootPlanView {
    const plan = this.planOf(planId);
    if (!isOpen(plan)) throw new DomainError(API_ERRORS.rebootPlanBusy);
    plan.cancelAsked = true;
    for (const step of plan.steps) {
      if (step.status === REBOOT_STEP_STATUS.waiting || step.status === REBOOT_STEP_STATUS.refused) {
        step.status = REBOOT_STEP_STATUS.cancelled;
      }
    }
    plan.status = REBOOT_PLAN_STATUS.running;
    this.save(plan);
    this.note(actor, AUDIT_ACTIONS.rebootPlanCancelled, plan);
    this.tick();
    return this.planOf(planId);
  }

  /** One step of whichever plan is running. Nothing here is kept in memory, so a restart simply picks it up. */
  tick() {
    const plan = this.plans().find(({ status }) => status === REBOOT_PLAN_STATUS.running);
    if (plan === undefined) return;
    const step = plan.steps.find(notEnded);
    if (step === undefined) {
      this.finish(plan);
      return;
    }
    if (step.status === REBOOT_STEP_STATUS.waiting) this.tryToAsk(plan, step);
    else this.follow(plan, step);
  }

  private finish(plan: RebootPlanView) {
    plan.status = plan.cancelAsked ? REBOOT_PLAN_STATUS.cancelled : REBOOT_PLAN_STATUS.completed;
    this.save(plan);
  }

  // Cancelled, a problem has nobody left to wait for: it is said, and the plan ends.
  private stop(plan: RebootPlanView, reason: string) {
    plan.reason = reason.slice(0, REBOOT_PLAN.reasonCharacters);
    plan.status = plan.cancelAsked ? REBOOT_PLAN_STATUS.cancelled : REBOOT_PLAN_STATUS.paused;
    this.save(plan);
  }

  private tryToAsk(plan: RebootPlanView, step: RebootStep) {
    const now = this.dependencies.clock();
    const { notBefore, notAfter } = plan.body;
    if (notBefore !== null && now < notBefore) return;
    if (notAfter !== null && now > notAfter) {
      this.stop(plan, REBOOT_PLAN_TEXT.windowOver);
      return;
    }
    const problem = this.gateProblem(plan, step);
    if (problem !== null) {
      this.stop(plan, problem);
      return;
    }
    const { userId, username } = plan.createdBy;
    try {
      // The job and the plan's record of it are saved together, or a crash between them would ask the host twice.
      this.database.transaction(() => {
        // Asked by the plan on its approver's word, not by a request from anywhere.
        const actor = { userId, username, ip: "", requestId: plan.id };
        const author = { kind: "user", actor } as const;
        const job = this.dependencies.hostPackages.request(author, step.hostId, JOB_ACTION.reboot, []);
        step.status = REBOOT_STEP_STATUS.asked;
        step.jobId = job.id;
        step.followingSince = now;
        this.save(plan);
      });
    } catch (error) {
      step.status = REBOOT_STEP_STATUS.waiting;
      step.jobId = null;
      step.followingSince = null;
      this.stop(plan, REBOOT_PLAN_TEXT.couldNotAsk(step.hostLabel, reasonOf(error)));
    }
  }

  private follow(plan: RebootPlanView, step: RebootStep) {
    const now = this.dependencies.clock();
    const host = this.hostRow(step.hostId);
    const job =
      step.jobId === null ? undefined : this.database.select().from(jobs).where(eq(jobs.id, step.jobId)).get();
    if (host === undefined || job === undefined) {
      this.stop(plan, REBOOT_PLAN_TEXT.jobGone(step.hostLabel));
      return;
    }
    const { cameBack, refused } = this.dependencies.power.rebootProgress(job, host, now);
    if (refused) {
      step.status = REBOOT_STEP_STATUS.refused;
      this.stop(plan, REBOOT_PLAN_TEXT.refused(step.hostLabel, job.outcome));
      return;
    }
    if (cameBack) {
      step.status = REBOOT_STEP_STATUS.back;
      step.backAt ??= now;
      const ready =
        this.hostProblem(host, step.hostLabel) === null && this.checksProblem(plan.body, step.backAt) === null;
      if (ready) {
        step.status = REBOOT_STEP_STATUS.done;
        step.doneAt = now;
      }
      if (ready || now <= this.deadlineOf(plan, step)) {
        this.save(plan);
        return;
      }
    }
    if (now > this.deadlineOf(plan, step)) {
      this.stop(plan, REBOOT_PLAN_TEXT.notBack(step.hostLabel, plan.body.returnMinutes));
    }
  }

  private deadlineOf(plan: RebootPlanView, step: RebootStep) {
    return (step.followingSince ?? 0) + plan.body.returnMinutes * MILLISECONDS_PER_MINUTE;
  }

  /** After a database restore: its plans may be from before reboots that have since happened, so a person decides. */
  pauseAfterRestore() {
    for (const plan of this.plans().filter(({ status }) => status === REBOOT_PLAN_STATUS.running)) {
      plan.status = REBOOT_PLAN_STATUS.paused;
      plan.reason = REBOOT_PLAN_TEXT.restored;
      this.save(plan);
    }
  }

  findings(): RebootPlanFinding[] {
    return this.plans().flatMap((plan) => {
      if (plan.status !== REBOOT_PLAN_STATUS.paused) return [];
      const step = plan.steps.find(notEnded) ?? plan.steps[0]!;
      return [
        {
          key: `${DETECTOR_KEYS.rebootPlan}${plan.id}`,
          hostId: step.hostId,
          hostLabel: step.hostLabel,
          title: REBOOT_PLAN_TEXT.taskTitle(plan.body.name),
          description: REBOOT_PLAN_TEXT.taskDetails(plan.reason),
        },
      ];
    });
  }
}
