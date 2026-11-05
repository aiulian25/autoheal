import { eq, inArray, sql } from "drizzle-orm";
import { APPLICATION_BACKUP_FAILURE } from "../../shared/application-backups.js";
import {
  INCIDENT_STATUS,
  JOB_STATUS,
  REPLAY_FINISHED,
  REPLAY_RUNNING,
  STACK_RESTART_INTERRUPTED,
  TRACE,
  UPDATE_RUN_STATUS,
  WORK_ITEM_STATUS,
} from "../../shared/constants.js";
import type { DatabaseHandle } from "../database/connection.js";
import {
  incidentEvents,
  incidents,
  jobs,
  replayRuns,
  stackRestarts,
  tasks,
  updateRuns,
  workItems,
} from "../database/schema.js";

const STALE_INCIDENT_STATUSES = [INCIDENT_STATUS.deciding, INCIDENT_STATUS.awaitingApproval, INCIDENT_STATUS.approved];
const OPEN_WORK = [WORK_ITEM_STATUS.pending, WORK_ITEM_STATUS.delivered];
const OPEN_JOBS = [JOB_STATUS.pending, JOB_STATUS.delivered];

/**
 * What a database put back from an earlier copy says is still in hand, settled: the hosts went on working while that
 * copy aged, so an action still open here may already have run there, and its answer may be gone with the rows that
 * held it. Every one is closed with `jobOutcome` rather than handed out again, and the runs that would ask for more
 * are stopped. Returns how many incidents were cancelled.
 *
 * Shared by the two ways a database goes back: restoring a backup, and a self-update that could not hold.
 */
export function settleDispatchedWork(databaseHandle: DatabaseHandle, now: number, jobOutcome: string): number {
  const database = databaseHandle.database;
  database
    .update(workItems)
    .set({ status: WORK_ITEM_STATUS.cancelled })
    .where(inArray(workItems.status, OPEN_WORK))
    .run();
  database
    .update(jobs)
    .set({ status: JOB_STATUS.expired, completedAt: now, outcome: jobOutcome })
    .where(inArray(jobs.status, OPEN_JOBS))
    .run();
  database.update(jobs).set({ installPayload: null }).run();
  // Restored approvals/schedules describe an older world. Never replay them into live volumes.
  const sqlite = databaseHandle.sqlite;
  const reconciliation = JSON.stringify({
    restoreReconciliationRequired: true,
    message:
      "Database restored. Review live Docker state and retained application artifacts before requesting fresh work.",
  });
  // Files may be newer than this database snapshot. Pin artifacts for uncertain work before cancellation,
  // so the normal failed-upload cleanup cannot destroy their independently retained recovery keys.
  sqlite
    .prepare(
      "UPDATE application_backup_artifacts AS artifact SET retained_by_run_id=COALESCE(retained_by_run_id,(SELECT work.id FROM application_backup_runs work WHERE work.status IN ('queued','running','recovery-required') AND (work.id=artifact.capture_run_id OR work.artifact_id=artifact.id OR work.safety_artifact_id=artifact.id) ORDER BY work.created_at LIMIT 1)) WHERE EXISTS (SELECT 1 FROM application_backup_runs work WHERE work.status IN ('queued','running','recovery-required') AND (work.id=artifact.capture_run_id OR work.artifact_id=artifact.id OR work.safety_artifact_id=artifact.id))",
    )
    .run();
  sqlite
    .prepare(
      "UPDATE application_backup_runs SET status='failed',failure=?,finished_at=?,progress_json=? WHERE status='queued'",
    )
    .run(APPLICATION_BACKUP_FAILURE.databaseRestored, now, reconciliation);
  sqlite
    .prepare("UPDATE application_backup_runs SET status='recovery-required',progress_json=? WHERE status='running'")
    .run(reconciliation);
  sqlite
    .prepare(
      "UPDATE rollouts SET state_json=json_set(state_json,'$.status','held','$.reason',?,'$.updatedAt',?),updated_at=? WHERE json_valid(state_json) AND json_extract(state_json,'$.status') IN ('updating','observing','ready')",
    )
    .run(
      "Database restored. Hold retained rollout state until a fresh plan is reviewed; no later cohort may run.",
      now,
      now,
    );
  database.update(tasks).set({ checkedOutBy: null, checkedOutAt: null }).run();
  database
    .update(updateRuns)
    .set({ status: UPDATE_RUN_STATUS.stopped, updatedAt: now })
    .where(eq(updateRuns.status, UPDATE_RUN_STATUS.running))
    .run();
  // Its jobs were just cancelled, and what it asked of the host may have happened or not. Never carried on.
  database
    .update(stackRestarts)
    .set({
      status: UPDATE_RUN_STATUS.stopped,
      failed: sql`${stackRestarts.current}`,
      current: null,
      currentJobId: null,
      outcome: STACK_RESTART_INTERRUPTED,
      updatedAt: now,
    })
    .where(eq(stackRestarts.status, UPDATE_RUN_STATUS.running))
    .run();
  database
    .update(replayRuns)
    .set({ status: REPLAY_FINISHED, finishedAt: now })
    .where(eq(replayRuns.status, REPLAY_RUNNING))
    .run();
  const stale = database
    .select({ id: incidents.id })
    .from(incidents)
    .where(inArray(incidents.status, STALE_INCIDENT_STATUSES))
    .all();
  if (stale.length > 0) {
    const ids = stale.map((incident) => incident.id);
    database
      .update(incidents)
      .set({ status: INCIDENT_STATUS.cancelled, updatedAt: now })
      .where(inArray(incidents.id, ids))
      .run();
    database
      .insert(incidentEvents)
      .values(ids.map((incidentId) => ({ incidentId, kind: TRACE.cancelledByRestore, createdAt: now })))
      .run();
  }
  return stale.length;
}
