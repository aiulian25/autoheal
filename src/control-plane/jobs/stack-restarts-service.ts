import { randomUUID } from "node:crypto";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { API_ERRORS, type ApiErrorCode, type StackRestartView } from "../../shared/api.js";
import {
  AUDIT_ACTIONS,
  JOB_ACTION,
  JOB_EXPIRED,
  JOB_STATUS,
  STACK_RESTARTS_KEPT,
  STACK_RESTART_INTERRUPTED,
  TARGET_HOST,
  UPDATE_RUN_STATUS,
} from "../../shared/constants.js";
import type { TopologySnapshot } from "../../shared/topology.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { ResourcePermissions } from "../auth/resource-permissions.js";
import type { DatabaseHandle } from "../database/connection.js";
import { jobs, stackRestarts } from "../database/schema.js";
import { DomainError } from "../domain-error.js";
import type { InventoryService } from "../inventory/inventory-service.js";
import type { TopologyService } from "../inventory/topology-service.js";
import type { JobsService } from "./jobs-service.js";

type Edge = TopologySnapshot["edges"][number];

// The links that say a container needs another up first; a shared project or shared data says nothing of order.
const ORDERING_KINDS: ReadonlySet<Edge["kind"]> = new Set(["declared_dependency", "network_namespace"]);

/** A stack's containers in the order they restart: each after the ones it depends on, the rest by name. */
export function restartOrder(names: readonly string[], edges: readonly Edge[]): string[] {
  const needs = new Map(names.map((name) => [name, new Set<string>()]));
  for (const edge of edges) {
    if (ORDERING_KINDS.has(edge.kind) && needs.has(edge.to)) needs.get(edge.from)?.add(edge.to);
  }
  const order: string[] = [];
  const left = [...needs.keys()].sort((first, second) => first.localeCompare(second));
  while (left.length > 0) {
    // Containers that wait for each other in a loop have no right order: the first by name breaks the loop.
    const next = left.find((name) => [...needs.get(name)!].every((need) => order.includes(need))) ?? left[0]!;
    order.push(next);
    left.splice(left.indexOf(next), 1);
  }
  return order;
}

export interface StackRestartsDependencies {
  auditLog: AuditLog;
  databaseHandle: DatabaseHandle;
  jobs: Pick<JobsService, "request" | "onFinished">;
  inventory: Pick<InventoryService, "containers">;
  topology: Pick<TopologyService, "view">;
  permissions: Pick<ResourcePermissions, "requireJob">;
  clock: () => number;
}

type StackRestartRow = typeof stackRestarts.$inferSelect;

const namesSchema = z.array(z.string());
const actorSchema = z.object({
  userId: z.string(),
  username: z.string(),
  ip: z.string(),
  requestId: z.string(),
}) satisfies z.ZodType<Actor>;
const WAITING: ReadonlySet<string> = new Set([JOB_STATUS.pending, JOB_STATUS.delivered]);

const viewOf = (row: StackRestartRow): StackRestartView => ({
  hostId: row.hostId,
  stack: row.stack,
  names: namesSchema.parse(JSON.parse(row.namesJson)),
  status: row.status,
  current: row.current,
  done: namesSchema.parse(JSON.parse(row.doneJson)),
  failed: row.failed,
  outcome: row.outcome,
  refusal: row.refusal as ApiErrorCode | null,
});

/**
 * A Compose stack's containers on one host restarted one at a time, each after the ones it depends on, as an
 * update run applies images: the next is asked for once the one before has restarted, and the first that
 * fails stops the rest. Each is the person's own restart job, so their grants are checked for each. The plan
 * is kept as its jobs are, so a control plane that restarts carries on from it; moving on is one transaction,
 * with the check that the job is still the one waited on, so no container is asked for twice.
 */
export class StackRestartsService {
  constructor(private readonly dependencies: StackRestartsDependencies) {
    dependencies.jobs.onFinished((job, succeeded) => this.jobFinished(job.id, succeeded, job.outcome));
    this.reconcile();
  }

  private get database() {
    return this.dependencies.databaseHandle.database;
  }

  start(actor: Actor, hostId: string, stack: string): StackRestartView {
    if (this.latestRow(hostId)?.status === UPDATE_RUN_STATUS.running) {
      throw new DomainError(API_ERRORS.stackRestartBusy);
    }
    const members = this.dependencies.inventory
      .containers({ hostId })
      .filter((container) => container.composeProject === stack && container.handsOff === null)
      .map((container) => container.name);
    if (members.length === 0) {
      throw new DomainError(API_ERRORS.stackNotFound);
    }
    // All of them before the first goes: a stack the person may not restart whole is not restarted in part.
    for (const name of members) {
      this.dependencies.permissions.requireJob(actor.userId, hostId, name, JOB_ACTION.restart);
    }
    const names = restartOrder(members, this.dependencies.topology.view(hostId).snapshot?.edges ?? []);
    const now = this.dependencies.clock();
    const restart = this.database.transaction(() => {
      const started = this.database
        .insert(stackRestarts)
        .values({
          id: randomUUID(),
          hostId,
          stack,
          namesJson: JSON.stringify(names),
          status: UPDATE_RUN_STATUS.running,
          current: names[0]!,
          doneJson: JSON.stringify([]),
          currentJobId: this.restartJob(actor, hostId, names[0]!),
          actorJson: JSON.stringify(actor),
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      this.keepLatest(hostId);
      return started;
    });
    this.dependencies.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.stackRestartStarted,
      { kind: TARGET_HOST, id: hostId },
      { stack, names },
    );
    return viewOf(restart);
  }

  /** The host's latest stack restart, going or ended; null before its first. */
  latest(hostId: string): StackRestartView | null {
    const row = this.latestRow(hostId);
    return row === undefined ? null : viewOf(row);
  }

  private latestRow(hostId: string) {
    return this.database
      .select()
      .from(stackRestarts)
      .where(eq(stackRestarts.hostId, hostId))
      .orderBy(desc(stackRestarts.createdAt), desc(sql`rowid`))
      .limit(1)
      .get();
  }

  private keepLatest(hostId: string) {
    const kept = this.database
      .select({ id: stackRestarts.id })
      .from(stackRestarts)
      .where(eq(stackRestarts.hostId, hostId))
      .orderBy(desc(stackRestarts.createdAt), desc(sql`rowid`))
      .limit(STACK_RESTARTS_KEPT);
    this.database
      .delete(stackRestarts)
      .where(and(eq(stackRestarts.hostId, hostId), notInArray(stackRestarts.id, kept)))
      .run();
  }

  /** At the start: what a job did while nobody was left to hear of it, and a plan whose job is gone. */
  private reconcile() {
    const running = this.database
      .select()
      .from(stackRestarts)
      .where(eq(stackRestarts.status, UPDATE_RUN_STATUS.running))
      .all();
    for (const restart of running) {
      const job =
        restart.currentJobId === null
          ? undefined
          : this.database.select().from(jobs).where(eq(jobs.id, restart.currentJobId)).get();
      if (job === undefined) {
        this.stop(restart, restart.current ?? "", { outcome: STACK_RESTART_INTERRUPTED });
      } else if (!WAITING.has(job.status)) {
        this.jobFinished(job.id, job.status === JOB_STATUS.succeeded, job.outcome ?? JOB_EXPIRED);
      }
    }
  }

  private restartJob(actor: Actor, hostId: string, name: string): string {
    return this.dependencies.jobs.request({ kind: "user", actor }, hostId, name, JOB_ACTION.restart, null).id;
  }

  private jobFinished(jobId: string, succeeded: boolean, outcome: string | null) {
    this.database.transaction(() => {
      const restart = this.database
        .select()
        .from(stackRestarts)
        .where(and(eq(stackRestarts.status, UPDATE_RUN_STATUS.running), eq(stackRestarts.currentJobId, jobId)))
        .get();
      if (restart === undefined) {
        return;
      }
      if (!succeeded) {
        this.stop(restart, restart.current!, { outcome });
        return;
      }
      this.moveOn(restart);
    });
  }

  private moveOn(restart: StackRestartRow) {
    const done = [...namesSchema.parse(JSON.parse(restart.doneJson)), restart.current!];
    const next = namesSchema.parse(JSON.parse(restart.namesJson))[done.length];
    const update = { doneJson: JSON.stringify(done), updatedAt: this.dependencies.clock() };
    if (next === undefined) {
      this.write(restart, { ...update, status: UPDATE_RUN_STATUS.finished, current: null, currentJobId: null });
      return;
    }
    try {
      const actor = actorSchema.parse(JSON.parse(restart.actorJson));
      const currentJobId = this.restartJob(actor, restart.hostId, next);
      this.write(restart, { ...update, current: next, currentJobId });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      this.write(restart, { doneJson: update.doneJson });
      this.stop(restart, next, { refusal: error.code });
    }
  }

  private stop(restart: StackRestartRow, name: string, why: { outcome?: string | null; refusal?: ApiErrorCode }) {
    this.write(restart, {
      status: UPDATE_RUN_STATUS.stopped,
      current: null,
      currentJobId: null,
      failed: name,
      outcome: why.outcome ?? null,
      refusal: why.refusal ?? null,
      updatedAt: this.dependencies.clock(),
    });
  }

  private write(restart: StackRestartRow, fields: Partial<typeof stackRestarts.$inferInsert>) {
    this.database.update(stackRestarts).set(fields).where(eq(stackRestarts.id, restart.id)).run();
  }
}
