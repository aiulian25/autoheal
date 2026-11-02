import { randomUUID } from "node:crypto";
import { and, eq, inArray, lte } from "drizzle-orm";
import { API_ERRORS, type ApprovalView } from "../../shared/api.js";
import {
  ACTION_RESTART,
  APPROVAL_DISMISS,
  APPROVAL_EXPIRY_MILLISECONDS,
  AUDIT_ACTIONS,
  HOST_STATUS_ACTIVE,
  INCIDENT_STATUS,
  TARGET_INCIDENT,
  TRACE,
  VERDICT_ESCALATED,
  WORK_ITEM_STATUS,
  type ApprovalChoice,
} from "../../shared/constants.js";
import type { Outcome, WorkItem } from "../../shared/protocol.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { approvals, hosts, incidents, users, workItems } from "../database/schema.js";
import { DomainError } from "../domain-error.js";
import type { HostRow } from "../hosts/hosts-service.js";
import type { IncidentsService } from "../incidents/incidents-service.js";

export interface ApprovalRequest {
  choice: ApprovalChoice;
  target?: string | undefined;
  note?: string | undefined;
}

const OPEN_WORK = [WORK_ITEM_STATUS.pending, WORK_ITEM_STATUS.delivered];

/**
 * A person settles an escalation with a choice from the same menu the model has. Approved
 * actions become work for the host, which re-checks them and runs them once, or not at all
 * if they expire first.
 */
export class ApprovalsService {
  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly incidents: IncidentsService,
    private readonly auditLog: AuditLog,
    private readonly clock: () => number = Date.now,
  ) {}

  decide(actor: Actor, incidentId: string, request: ApprovalRequest): ApprovalView {
    const incident = this.incidents.find(incidentId);
    this.requireActiveHost(incident.hostId);
    const target = this.targetFor(incidentId, incident.containerName, request);
    const now = this.clock();
    const approval = this.databaseHandle.database.transaction((transaction) => {
      const current = transaction
        .select({ status: incidents.status })
        .from(incidents)
        .where(eq(incidents.id, incidentId))
        .get();
      if (current?.status !== INCIDENT_STATUS.awaitingApproval) {
        throw new DomainError(API_ERRORS.notAwaitingApproval);
      }
      const inserted = transaction
        .insert(approvals)
        .values({
          id: randomUUID(),
          incidentId,
          decidedBy: actor.userId,
          choice: request.choice,
          target,
          note: request.note ?? null,
          decidedAt: now,
        })
        .returning()
        .get();
      if (request.choice !== APPROVAL_DISMISS) {
        transaction
          .insert(workItems)
          .values({
            id: randomUUID(),
            hostId: incident.hostId,
            incidentId,
            approvalId: inserted.id,
            action: request.choice,
            target: target!,
            status: WORK_ITEM_STATUS.pending,
            createdAt: now,
            expiresAt: now + APPROVAL_EXPIRY_MILLISECONDS,
          })
          .run();
      }
      const status = request.choice === APPROVAL_DISMISS ? INCIDENT_STATUS.dismissed : INCIDENT_STATUS.approved;
      transaction.update(incidents).set({ status, updatedAt: now }).where(eq(incidents.id, incidentId)).run();
      return inserted;
    });
    this.incidents.addEvent(incidentId, TRACE.approvalDecided, { choice: request.choice, target, by: actor.username });
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.approvalDecided,
      { kind: TARGET_INCIDENT, id: incidentId },
      {
        choice: request.choice,
        target,
      },
    );
    return {
      id: approval.id,
      choice: approval.choice,
      target: approval.target,
      note: approval.note,
      decidedBy: actor.username,
      decidedAt: approval.decidedAt,
    };
  }

  /** Approved actions for this host, each delivered once; stale ones expire instead. */
  takeWork(host: HostRow): WorkItem[] {
    this.expireStaleWork();
    const now = this.clock();
    const database = this.databaseHandle.database;
    const pending = database
      .select({ item: workItems, containerName: incidents.containerName, approvedBy: users.username })
      .from(workItems)
      .innerJoin(incidents, eq(incidents.id, workItems.incidentId))
      .innerJoin(approvals, eq(approvals.id, workItems.approvalId))
      .innerJoin(users, eq(users.id, approvals.decidedBy))
      .where(and(eq(workItems.hostId, host.id), eq(workItems.status, WORK_ITEM_STATUS.pending)))
      .all();
    for (const { item } of pending) {
      database
        .update(workItems)
        .set({ status: WORK_ITEM_STATUS.delivered, deliveredAt: now })
        .where(eq(workItems.id, item.id))
        .run();
      this.incidents.addEvent(item.incidentId, TRACE.workDelivered, { workItemId: item.id });
    }
    return pending.map(({ item, containerName, approvedBy }) => ({
      id: item.id,
      incidentId: item.incidentId,
      containerName,
      action: item.action,
      target: item.target,
      approvedBy,
      expiresAt: item.expiresAt,
    }));
  }

  completeWork(host: HostRow, workItemId: string, result: Outcome) {
    const database = this.databaseHandle.database;
    const item = database.select().from(workItems).where(eq(workItems.id, workItemId)).get();
    const awaitingLateResult = item?.deliveredAt != null && item.status === WORK_ITEM_STATUS.expired;
    if (
      item === undefined ||
      item.hostId !== host.id ||
      (item.status !== WORK_ITEM_STATUS.delivered && !awaitingLateResult)
    ) {
      throw new DomainError(API_ERRORS.workItemNotFound);
    }
    database
      .update(workItems)
      .set({ status: WORK_ITEM_STATUS.done, completedAt: this.clock(), resultJson: JSON.stringify(result) })
      .where(eq(workItems.id, workItemId))
      .run();
    this.incidents.addEvent(item.incidentId, TRACE.workCompleted, { workItemId, ...result });
    // A late report is evidence for its original action, not permission to overwrite a newer approval.
    const superseded =
      awaitingLateResult &&
      database
        .select()
        .from(workItems)
        .where(eq(workItems.incidentId, item.incidentId))
        .all()
        .some((other) => other.id !== item.id && other.createdAt >= item.createdAt);
    if (superseded) return;
    this.incidents.update(item.incidentId, {
      status: result.verdict === VERDICT_ESCALATED ? INCIDENT_STATUS.awaitingApproval : INCIDENT_STATUS.resolved,
      verdict: result.verdict,
      outcome: result.outcome,
    });
  }

  // Work for a revoked host would never be collected; a person would approve into the void.
  private requireActiveHost(hostId: string) {
    const host = this.databaseHandle.database
      .select({ status: hosts.status })
      .from(hosts)
      .where(eq(hosts.id, hostId))
      .get();
    if (host?.status !== HOST_STATUS_ACTIVE) {
      throw new DomainError(API_ERRORS.hostRevoked);
    }
  }

  private targetFor(incidentId: string, containerName: string, request: ApprovalRequest): string | null {
    if (request.choice === APPROVAL_DISMISS) {
      return null;
    }
    if (request.choice === ACTION_RESTART) {
      return containerName;
    }
    const report = this.incidents.reportOf(incidentId);
    const target = request.target ?? "";
    const isKnown = report?.knownContainers.includes(target) ?? false;
    const isProtected = report?.protectedContainers.includes(target) ?? true;
    if (!isKnown || isProtected) {
      throw new DomainError(API_ERRORS.invalidTarget);
    }
    return target;
  }

  /** Expired approvals hand the incident back to a person: the moment they approved has passed. */
  private expireStaleWork() {
    const now = this.clock();
    const database = this.databaseHandle.database;
    const stale = database
      .select()
      .from(workItems)
      .where(and(inArray(workItems.status, OPEN_WORK), lte(workItems.expiresAt, now)))
      .all();
    for (const item of stale) {
      database.update(workItems).set({ status: WORK_ITEM_STATUS.expired }).where(eq(workItems.id, item.id)).run();
      this.incidents.addEvent(item.incidentId, TRACE.workExpired, { workItemId: item.id });
      this.incidents.update(item.incidentId, { status: INCIDENT_STATUS.awaitingApproval });
    }
  }
}
