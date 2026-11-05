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
  clock?: () => number;
}

const AUTOHEAL: TaskAuthor = { kind: "agent", agent: AGENT_AUTOHEAL };
const storedNames = z.array(z.string().min(1).max(REPORT_LIMITS.nameCharacters));
const fingerprintsOf = (run: UpdateRunRow): Record<string, string> =>
  run.expectedResourcesJson === null
    ? {}
    : z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)).parse(JSON.parse(run.expectedResourcesJson));
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
    expectedResources?: Readonly<Record<string, string>>,
  ): UpdateRunView {
    const ordered = [...new Set(names)];
    if (this.runningOn(hostId) !== undefined) {
      throw new DomainError(API_ERRORS.updateRunBusy);
    }
    this.requireWaiting(hostId, ordered);
    // Sent before the run is kept: a host that can't take it says so to the person asking.
    const first = this.request({ kind: "user", actor }, hostId, ordered[0]!, expectedResources?.[ordered[0]!]);
    const now = this.clock();
    const run = this.database
      .insert(updateRuns)
      .values({
        id: randomUUID(),
        hostId,
        namesJson: JSON.stringify(ordered),
        expectedResourcesJson: expectedResources === undefined ? null : JSON.stringify(expectedResources),
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
    this.next({ ...run, doneCount: run.doneCount + 1 });
  }

  // Asks for the next one, or ends the run when none is left.
  private next(run: UpdateRunRow) {
    const name = namesOf(run)[run.doneCount];
    if (name === undefined) {
      this.end(run, UPDATE_RUN_STATUS.finished);
      return;
    }
    try {
      const jobId = this.request(AUTOHEAL, run.hostId, name, fingerprintsOf(run)[name]);
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
