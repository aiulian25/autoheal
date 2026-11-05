import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { API_ERRORS, hasUpdate, type UpdateRunView } from "../../shared/api.js";
import {
  AGENT_AUTOHEAL,
  AUDIT_ACTIONS,
  JOB_ACTION,
  REPORT_LIMITS,
  TARGET_HOST,
  UPDATE_RUN_STATUS,
  type UpdateRunStatus,
} from "../../shared/constants.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { jobs, updateRuns } from "../database/schema.js";
import { DomainError } from "../domain-error.js";
import type { InventoryService } from "../inventory/inventory-service.js";
import type { TopologyService } from "../inventory/topology-service.js";
import { updateTaskKey } from "../tasks/detectors.js";
import type { TaskAuthor, TasksService } from "../tasks/tasks-service.js";
import type { JobsService } from "./jobs-service.js";

type UpdateRunRow = typeof updateRuns.$inferSelect;

export interface UpdateRunsDependencies {
  databaseHandle: DatabaseHandle;
  auditLog: AuditLog;
  jobs: Pick<JobsService, "request" | "onFinished">;
  inventory: Pick<InventoryService, "containers">;
  tasks: Pick<TasksService, "openFor">;
  // A fresh review of what updating a container touches; absent where no host can give one.
  topology?: Pick<TopologyService, "refresh">;
  clock?: () => number;
}

/** What a person reviewed before a container's update: its fingerprint, and the containers it touches by name. */
export interface ReviewedUpdate {
  fingerprint: string;
  members: readonly string[];
}

const AUTOHEAL: TaskAuthor = { kind: "agent", agent: AGENT_AUTOHEAL };
const storedNames = z.array(z.string().min(1).max(REPORT_LIMITS.nameCharacters));
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
// Runs kept before reviews named their members hold the fingerprint alone.
const storedReview = z.union([
  fingerprint.transform((value): ReviewedUpdate => ({ fingerprint: value, members: [] })),
  z.object({ fingerprint, members: storedNames }),
]);
const reviewsOf = (run: UpdateRunRow): Record<string, ReviewedUpdate> =>
  run.expectedResourcesJson === null
    ? {}
    : z.record(z.string(), storedReview).parse(JSON.parse(run.expectedResourcesJson));
const sameNames = (first: readonly string[], second: readonly string[]) =>
  JSON.stringify([...first].sort()) === JSON.stringify([...second].sort());
const namesOf = (run: UpdateRunRow) => storedNames.parse(JSON.parse(run.namesJson));

/**
 * Several containers' new images on one host, applied one at a time in the order a person gave them.
 * Each waits for the one before it to come back healthy; the first that does not stops the run, and the
 * ones after it wait for a person. The person asks for the first; Autoheal asks for each next one.
 */
export class UpdateRunsService {
  private readonly clock: () => number;

  constructor(private readonly dependencies: UpdateRunsDependencies) {
    this.clock = dependencies.clock ?? Date.now;
    dependencies.jobs.onFinished((job, succeeded) => this.jobFinished(job.id, succeeded));
  }

  private get database() {
    return this.dependencies.databaseHandle.database;
  }

  start(
    actor: Actor,
    hostId: string,
    names: readonly string[],
    reviews?: Readonly<Record<string, ReviewedUpdate>>,
  ): UpdateRunView {
    const ordered = [...new Set(names)];
    if (this.runningOn(hostId) !== undefined) {
      throw new DomainError(API_ERRORS.updateRunBusy);
    }
    this.requireWaiting(hostId, ordered);
    // Sent before the run is kept: a host that can't take it says so to the person asking.
    const first = this.request({ kind: "user", actor }, hostId, ordered[0]!, reviews?.[ordered[0]!]?.fingerprint);
    const now = this.clock();
    const run = this.database
      .insert(updateRuns)
      .values({
        id: randomUUID(),
        hostId,
        namesJson: JSON.stringify(ordered),
        expectedResourcesJson: reviews === undefined ? null : JSON.stringify(reviews),
        status: UPDATE_RUN_STATUS.running,
        doneCount: 0,
        currentJobId: first,
        requestedByUserId: actor.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    this.dependencies.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.updateRunStarted,
      { kind: TARGET_HOST, id: hostId },
      { names: ordered },
    );
    return this.view(run);
  }

  /** The host's newest run, going or ended; null before its first. */
  latest(hostId: string): UpdateRunView | null {
    const run = this.database
      .select()
      .from(updateRuns)
      .where(eq(updateRuns.hostId, hostId))
      .orderBy(desc(updateRuns.createdAt))
      .limit(1)
      .get();
    return run === undefined ? null : this.view(run);
  }

  private jobFinished(jobId: string, succeeded: boolean) {
    const run = this.database
      .select()
      .from(updateRuns)
      .where(and(eq(updateRuns.currentJobId, jobId), eq(updateRuns.status, UPDATE_RUN_STATUS.running)))
      .get();
    if (run === undefined) {
      return;
    }
    if (!succeeded) {
      this.end(run, UPDATE_RUN_STATUS.stopped, jobId);
      return;
    }
    void this.next({ ...run, doneCount: run.doneCount + 1 }).catch(() => this.end(run, UPDATE_RUN_STATUS.stopped));
  }

  /**
   * The fingerprint the next update must still match. The containers before it in this run were replaced by it, so
   * the review a person made names containers that are now new instances: a fresh review that touches the very same
   * containers, by name, stands in for it. One that touches others, or that the host cannot give, keeps the first,
   * and the update refuses as before.
   */
  private async fingerprintFor(run: UpdateRunRow, name: string): Promise<string | undefined> {
    const reviewed = reviewsOf(run)[name];
    const topology = this.dependencies.topology;
    if (reviewed === undefined || reviewed.members.length === 0 || topology === undefined) return reviewed?.fingerprint;
    const fresh = await topology.refresh(run.hostId, name);
    const stillTheSame =
      fresh !== null &&
      fresh.refusals.length === 0 &&
      sameNames(
        fresh.members.map((member) => member.name),
        reviewed.members,
      );
    return stillTheSame ? fresh.fingerprint : reviewed.fingerprint;
  }

  // Asks for the next one, or ends the run when none is left.
  private async next(run: UpdateRunRow) {
    const name = namesOf(run)[run.doneCount];
    if (name === undefined) {
      this.end(run, UPDATE_RUN_STATUS.finished);
      return;
    }
    const expected = await this.fingerprintFor(run, name);
    try {
      const jobId = this.request(AUTOHEAL, run.hostId, name, expected);
      this.database
        .update(updateRuns)
        .set({ doneCount: run.doneCount, currentJobId: jobId, updatedAt: this.clock() })
        .where(eq(updateRuns.id, run.id))
        .run();
    } catch (error) {
      // Gone, kept aside, or its label turned updates off since it was ticked: it waits with the rest.
      if (!(error instanceof DomainError)) {
        throw error;
      }
      this.end(run, UPDATE_RUN_STATUS.stopped);
    }
  }

  // The update closes the container's update task when it comes back healthy.
  private request(author: TaskAuthor, hostId: string, name: string, expectedResourcesFingerprint?: string): string {
    const task = this.dependencies.tasks.openFor(updateTaskKey(hostId, name));
    return this.dependencies.jobs.request(
      author,
      hostId,
      name,
      JOB_ACTION.update,
      task?.id ?? null,
      expectedResourcesFingerprint ? { expectedResourcesFingerprint } : {},
    ).id;
  }

  // A run that stopped keeps the job that stopped it, so the page can say what happened; a finished one keeps none.
  private end(run: UpdateRunRow, status: UpdateRunStatus, stoppedBy: string | null = null) {
    this.database
      .update(updateRuns)
      .set({ status, doneCount: run.doneCount, currentJobId: stoppedBy, updatedAt: this.clock() })
      .where(eq(updateRuns.id, run.id))
      .run();
  }

  private runningOn(hostId: string): UpdateRunRow | undefined {
    return this.database
      .select()
      .from(updateRuns)
      .where(and(eq(updateRuns.hostId, hostId), eq(updateRuns.status, UPDATE_RUN_STATUS.running)))
      .get();
  }

  // Each one must be on the host with a new image waiting that someone may apply.
  private requireWaiting(hostId: string, names: readonly string[]) {
    if (names.length === 0) {
      throw new DomainError(API_ERRORS.noUpdate);
    }
    const containers = new Map(
      this.dependencies.inventory.containers({ hostId }).map((container) => [container.name, container]),
    );
    for (const name of names) {
      const container = containers.get(name);
      if (container === undefined) {
        throw new DomainError(API_ERRORS.containerNotFound);
      }
      if (container.handsOff !== null) {
        throw new DomainError(API_ERRORS.handsOff);
      }
      if (!hasUpdate(container)) {
        throw new DomainError(API_ERRORS.noUpdate);
      }
    }
  }

  // The words its runner gave for the job that stopped the run, so the page says what happened rather than a guess.
  private outcomeOf(jobId: string | null): string | null {
    if (jobId === null) return null;
    const job = this.database.select({ outcome: jobs.outcome }).from(jobs).where(eq(jobs.id, jobId)).get();
    return job?.outcome ?? null;
  }

  private view(run: UpdateRunRow): UpdateRunView {
    const names = namesOf(run);
    const waitingOn = names[run.doneCount] ?? null;
    return {
      id: run.id,
      hostId: run.hostId,
      names,
      status: run.status,
      current: run.status === UPDATE_RUN_STATUS.running ? waitingOn : null,
      done: names.slice(0, run.doneCount),
      failed: run.status === UPDATE_RUN_STATUS.stopped ? waitingOn : null,
      failedOutcome: run.status === UPDATE_RUN_STATUS.stopped ? this.outcomeOf(run.currentJobId) : null,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }
}
