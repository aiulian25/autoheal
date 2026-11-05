import {
  FINISHED_APPLICATION_BACKUP_RUN_STATUSES,
  SPENT_APPLICATION_BACKUP_ARTIFACT_STATUS,
} from "../../shared/application-backups.js";
import {
  ACTOR_SYSTEM,
  AUDIT_ACTIONS,
  CLOSED_TASK_STATUSES,
  INCIDENT_STATUS,
  JOB_STATUS,
  REPLAY_FINISHED,
  RETENTION_MILLISECONDS,
  RETENTION_SWEEP_BATCH_ROWS,
  SYSTEM_ACTOR_LABEL,
  UPDATE_RUN_STATUS,
  WORK_ITEM_STATUS,
} from "../../shared/constants.js";
import { DATA_KIND, type DataKind, type DataView } from "../../shared/api.js";
import { REBOOT_PLAN_STATUS } from "../../shared/reboot-plans.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "./connection.js";

const listed = (values: readonly string[]) => JSON.stringify(values);
const ENDED_INCIDENTS = listed([INCIDENT_STATUS.resolved, INCIDENT_STATUS.dismissed, INCIDENT_STATUS.cancelled]);
const FINISHED_JOBS = listed([JOB_STATUS.succeeded, JOB_STATUS.failed, JOB_STATUS.expired]);
const FINISHED_UPDATE_RUNS = listed([UPDATE_RUN_STATUS.finished, UPDATE_RUN_STATUS.stopped]);
const OPEN_WORK = listed([WORK_ITEM_STATUS.pending, WORK_ITEM_STATUS.delivered]);
const CLOSED_TASKS = listed(CLOSED_TASK_STATUSES);
const FINISHED_BACKUP_RUNS = listed(FINISHED_APPLICATION_BACKUP_RUN_STATUSES);
const SETTLED_REBOOT_PLANS = listed([REBOOT_PLAN_STATUS.completed, REBOOT_PLAN_STATUS.cancelled]);
// A JSON array parameter read as a set of values.
const EACH = "(SELECT value FROM json_each(?))";

/** One kind of record: which rows outlived their window, and the deletes that remove a batch of them, in order. */
interface Expiry {
  name: DataKind;
  table: string;
  window: number;
  // Selects the expired rows' ids. Its parameters: what `parameters` gives for the cutoff, then the batch size.
  select: string;
  parameters: (cutoff: number) => unknown[];
  // Each is run with the batch's ids as a JSON array.
  deletes: readonly string[];
}

// A record another one names is removed after it: tasks and replays before the incidents they name.
const EXPIRIES: readonly Expiry[] = [
  {
    name: DATA_KIND.runnerResults,
    table: "runner_results",
    window: RETENTION_MILLISECONDS.runnerResults,
    select: "SELECT id FROM runner_results WHERE created_at < ? LIMIT ?",
    parameters: (cutoff) => [cutoff],
    deletes: [`DELETE FROM runner_results WHERE id IN ${EACH}`],
  },
  {
    name: DATA_KIND.updateRuns,
    table: "update_runs",
    window: RETENTION_MILLISECONDS.updateRuns,
    select: `SELECT id FROM update_runs WHERE updated_at < ? AND status IN ${EACH} LIMIT ?`,
    parameters: (cutoff) => [cutoff, FINISHED_UPDATE_RUNS],
    deletes: [`DELETE FROM update_runs WHERE id IN ${EACH}`],
  },
  {
    name: DATA_KIND.jobs,
    table: "jobs",
    window: RETENTION_MILLISECONDS.jobs,
    // A running update run or a rollout, held ones included, still points at its job.
    select: `SELECT id FROM jobs WHERE COALESCE(completed_at, created_at) < ? AND status IN ${EACH}
      AND NOT EXISTS (SELECT 1 FROM update_runs WHERE update_runs.current_job_id = jobs.id)
      AND NOT EXISTS (
        SELECT 1 FROM rollouts,
          json_each(CASE WHEN json_valid(rollouts.state_json) THEN rollouts.state_json ELSE '{}' END, '$.targets') AS target
        WHERE json_extract(target.value, '$.jobId') = jobs.id
      )
      LIMIT ?`,
    parameters: (cutoff) => [cutoff, FINISHED_JOBS],
    deletes: [`DELETE FROM jobs WHERE id IN ${EACH}`],
  },
  {
    name: DATA_KIND.replayRuns,
    table: "replay_runs",
    window: RETENTION_MILLISECONDS.replayRuns,
    select: "SELECT id FROM replay_runs WHERE COALESCE(finished_at, created_at) < ? AND status = ? LIMIT ?",
    parameters: (cutoff) => [cutoff, REPLAY_FINISHED],
    deletes: [`DELETE FROM replay_runs WHERE id IN ${EACH}`],
  },
  {
    name: DATA_KIND.tasks,
    table: "tasks",
    window: RETENTION_MILLISECONDS.closedTasks,
    // The newest number always stays, so a new task never gets an old one's number. A closed parent stays
    // while a subtask of it is open or recent.
    select: `SELECT id FROM tasks WHERE COALESCE(closed_at, updated_at) < ? AND status IN ${EACH}
      AND number < (SELECT MAX(number) FROM tasks)
      AND NOT EXISTS (
        SELECT 1 FROM tasks AS child WHERE child.parent_id = tasks.id
          AND (child.status NOT IN ${EACH} OR COALESCE(child.closed_at, child.updated_at) >= ?)
      )
      LIMIT ?`,
    parameters: (cutoff) => [cutoff, CLOSED_TASKS, CLOSED_TASKS, cutoff],
    deletes: [`DELETE FROM tasks WHERE id IN ${EACH}`],
  },
  {
    name: DATA_KIND.incidents,
    table: "incidents",
    window: RETENTION_MILLISECONDS.endedIncidents,
    // Its approved actions and their approvals go with it; a kept task or replay result keeps it.
    select: `SELECT id FROM incidents WHERE updated_at < ? AND status IN ${EACH}
      AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.incident_id = incidents.id)
      AND NOT EXISTS (SELECT 1 FROM replay_results WHERE replay_results.incident_id = incidents.id)
      AND NOT EXISTS (
        SELECT 1 FROM work_items WHERE work_items.incident_id = incidents.id AND work_items.status IN ${EACH}
      )
      LIMIT ?`,
    parameters: (cutoff) => [cutoff, ENDED_INCIDENTS, OPEN_WORK],
    deletes: [
      `DELETE FROM work_items WHERE incident_id IN ${EACH}`,
      `DELETE FROM approvals WHERE incident_id IN ${EACH}`,
      `DELETE FROM incidents WHERE id IN ${EACH}`,
    ],
  },
  {
    name: DATA_KIND.applicationBackupArtifacts,
    table: "application_backup_artifacts",
    window: RETENTION_MILLISECONDS.applicationBackupRuns,
    // Only an artifact whose files and key clean-up already removed, once every run that names it has ended long ago.
    select: `SELECT id FROM application_backup_artifacts AS artifact
      WHERE artifact.created_at < ? AND artifact.status = ? AND artifact.key_ciphertext = ''
        AND artifact.retained_by_run_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM application_backup_runs AS run
          WHERE (run.artifact_id = artifact.id OR run.safety_artifact_id = artifact.id)
            AND (run.status NOT IN ${EACH} OR COALESCE(run.finished_at, run.created_at) >= ?)
        )
      LIMIT ?`,
    parameters: (cutoff) => [cutoff, SPENT_APPLICATION_BACKUP_ARTIFACT_STATUS, FINISHED_BACKUP_RUNS, cutoff],
    deletes: [`DELETE FROM application_backup_artifacts WHERE id IN ${EACH}`],
  },
  {
    name: DATA_KIND.applicationBackupRuns,
    table: "application_backup_runs",
    window: RETENTION_MILLISECONDS.applicationBackupRuns,
    // A kept artifact keeps the run that made it.
    select: `SELECT id FROM application_backup_runs AS run
      WHERE COALESCE(run.finished_at, run.created_at) < ? AND run.status IN ${EACH}
        AND NOT EXISTS (
          SELECT 1 FROM application_backup_artifacts AS artifact
          WHERE artifact.capture_run_id = run.id OR artifact.retained_by_run_id = run.id
        )
      LIMIT ?`,
    parameters: (cutoff) => [cutoff, FINISHED_BACKUP_RUNS],
    deletes: [`DELETE FROM application_backup_runs WHERE id IN ${EACH}`],
  },
  {
    name: DATA_KIND.rebootPlans,
    table: "reboot_plans",
    window: RETENTION_MILLISECONDS.rebootPlans,
    // Only plans that are over. One still running or paused stays, and so does one whose saved form cannot be read,
    // which may be a reboot nobody has accounted for; a plan whose job is still here keeps its own record too.
    select: `SELECT id FROM reboot_plans
      WHERE updated_at < ? AND status IN ${EACH}
        AND NOT EXISTS (
          SELECT 1 FROM jobs, json_each(json_extract(reboot_plans.state_json, '$.steps'))
          WHERE jobs.id = json_extract(json_each.value, '$.jobId')
        )
      LIMIT ?`,
    parameters: (cutoff) => [cutoff, SETTLED_REBOOT_PLANS],
    deletes: [`DELETE FROM reboot_plans WHERE id IN ${EACH}`],
  },
];

export type RetentionCounts = Record<string, number>;

/**
 * Removes finished records once they outlive their window, in bounded batches so no transaction grows large.
 * What a kept record still names stays: an open task's incident, a rollout's job, a kept artifact's backup run.
 * The audit log stays whole: its triggers refuse deletes, and only adds the sweep's own entry.
 */
export class RetentionSweep {
  // The latest sweep since the control plane started; the first runs at start.
  private last: DataView["lastSweep"] = null;

  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly auditLog: AuditLog,
    private readonly clock: () => number = Date.now,
  ) {}

  sweep(): RetentionCounts {
    const now = this.clock();
    const removed: RetentionCounts = Object.fromEntries(
      EXPIRIES.map((expiry) => [expiry.name, this.expire(expiry, now - expiry.window)]),
    );
    const total = Object.values(removed).reduce((sum, count) => sum + count, 0);
    this.last = { at: now, removed: total };
    if (total > 0) {
      this.auditLog.record({
        actorKind: ACTOR_SYSTEM,
        actorLabel: SYSTEM_ACTOR_LABEL,
        action: AUDIT_ACTIONS.retentionSwept,
        details: { removed },
      });
    }
    return removed;
  }

  /** What the database holds: its size, each swept table's rows and how long a finished one is kept, the last sweep. */
  view(): DataView {
    const sqlite = this.databaseHandle.sqlite;
    const rowsIn = (table: string) =>
      (sqlite.prepare(`SELECT count(*) AS rows FROM ${table}`).get() as { rows: number }).rows;
    const pages = sqlite.pragma("page_count", { simple: true }) as number;
    const pageBytes = sqlite.pragma("page_size", { simple: true }) as number;
    return {
      bytes: pages * pageBytes,
      kinds: [
        ...EXPIRIES.map(({ name, table, window }) => ({ kind: name, rows: rowsIn(table), keptMilliseconds: window })),
        { kind: DATA_KIND.auditEvents, rows: rowsIn("audit_events"), keptMilliseconds: null },
      ],
      lastSweep: this.last,
    };
  }

  // ponytail: batches run back to back on the event loop; yield between them if a first sweep of a years-old
  // database ever holds requests up noticeably.
  private expire(expiry: Expiry, cutoff: number): number {
    const sqlite = this.databaseHandle.sqlite;
    const select = sqlite.prepare(expiry.select);
    const deletes = expiry.deletes.map((statement) => sqlite.prepare(statement));
    let removed = 0;
    for (;;) {
      const rows = select.all(...expiry.parameters(cutoff), RETENTION_SWEEP_BATCH_ROWS) as { id: string }[];
      const ids = JSON.stringify(rows.map((row) => row.id));
      sqlite.transaction(() => deletes.forEach((statement) => statement.run(ids)))();
      removed += rows.length;
      if (rows.length < RETENTION_SWEEP_BATCH_ROWS) {
        return removed;
      }
    }
  }
}
