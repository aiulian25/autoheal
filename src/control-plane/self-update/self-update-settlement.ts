import {
  ACTOR_SYSTEM,
  AUDIT_ACTIONS,
  JOB_CANCELLED_BY_SELF_UPDATE_ROLLBACK,
  SYSTEM_ACTOR_LABEL,
  TARGET_AUTOHEAL,
} from "../../shared/constants.js";
import type { AuditLog } from "../audit/audit-log.js";
import { settleDispatchedWork } from "../backups/settle-dispatched-work.js";
import type { DatabaseHandle } from "../database/connection.js";
import { outcomeIn, type SelfUpdateOutcomeFile } from "./self-update-outcome.js";

/** What the settlement closed, or null where this database was not put back by an update. */
export interface SelfUpdateSettlement {
  cancelledIncidents: number;
}

/**
 * An update of Autoheal that could not hold puts the database back to before it began. The version that ran in the
 * meantime had runners, the API and its workers going: it may have dispatched actions the hosts carried out, and
 * taken their answers, and all of that went back with the file. Nothing here can tell which, so every action still
 * open is closed rather than handed out again, and the audit log says so.
 *
 * Runs once, before anything can deliver work, and only for a record that says the file was put back.
 */
export function settleSelfUpdateRollback(
  databaseHandle: DatabaseHandle,
  outcomes: SelfUpdateOutcomeFile,
  auditLog: AuditLog,
  now: number,
): SelfUpdateSettlement | null {
  const stored = outcomeIn(outcomes.read());
  if (stored === null || !stored.dataRestored || stored.settled) {
    return null;
  }
  const { audited, settled, recovery, dataRestored, ...outcome } = stored;
  const cancelledIncidents = databaseHandle.database.transaction(() =>
    settleDispatchedWork(databaseHandle, now, JOB_CANCELLED_BY_SELF_UPDATE_ROLLBACK),
  );
  auditLog.record({
    actorKind: ACTOR_SYSTEM,
    actorLabel: SYSTEM_ACTOR_LABEL,
    action: AUDIT_ACTIONS.selfUpdateRollbackSettled,
    targetKind: TARGET_AUTOHEAL,
    details: { status: outcome.status, from: outcome.from, to: outcome.to, cancelledIncidents },
  });
  // Only once: a later start finds the work already settled, whatever else it does with the record.
  outcomes.write({ ...outcome, recovery, dataRestored }, { audited, settled: true });
  return { cancelledIncidents };
}
