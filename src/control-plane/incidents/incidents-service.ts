import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, lt, ne, type SQL } from "drizzle-orm";
import {
  API_ERRORS,
  type ApprovalView,
  type ContainerUsageView,
  type IncidentDetailView,
  type IncidentSummaryView,
  type TraceEventView,
} from "../../shared/api.js";
import {
  DECIDED_BY,
  INCIDENT_LIST_LIMIT,
  INCIDENT_MEMORY,
  INCIDENT_OUTCOME_LOST,
  INCIDENT_STATUS,
  TRACE,
  VERDICT_ESCALATED,
  VERDICT_SKIPPED,
  type IncidentStatus,
  type TraceKind,
} from "../../shared/constants.js";
import type { HandledIncident, IncidentSubmission, Outcome } from "../../shared/protocol.js";
import type { IncidentReport } from "../../shared/report.js";
import type { DatabaseHandle } from "../database/connection.js";
import { approvals, hosts, incidentEvents, incidentReports, incidents, users } from "../database/schema.js";
import { describeError } from "../../shared/errors.js";
import { log } from "../../shared/log.js";
import { DomainError } from "../domain-error.js";
import type { HostRow } from "../hosts/hosts-service.js";

export type IncidentRow = typeof incidents.$inferSelect;
export type IncidentChange = Partial<Omit<IncidentRow, "id" | "hostId" | "createdAt">>;

export interface IncidentFilters {
  hostId?: string;
  containerName?: string;
  status?: IncidentStatus;
  limit?: number;
}

const SETTLED_STATUSES: ReadonlySet<string> = new Set([
  INCIDENT_STATUS.approved,
  INCIDENT_STATUS.dismissed,
  INCIDENT_STATUS.cancelled,
  INCIDENT_STATUS.resolved,
]);

// The model's thinking is shown as reasoning of its own; its step in the trace keeps only the answer.
function withoutThinking(event: TraceEventView): TraceEventView {
  if (event.kind !== TRACE.modelAnswered) {
    return event;
  }
  const payload = { ...event.payload };
  delete payload.thinking;
  return { ...event, payload };
}

const summaryView = (incident: IncidentRow, hostLabel: string): IncidentSummaryView => ({
  id: incident.id,
  hostId: incident.hostId,
  hostLabel,
  containerName: incident.containerName,
  image: incident.image,
  trigger: incident.triggerEvent,
  status: incident.status,
  decidedBy: incident.decidedBy,
  action: incident.action,
  target: incident.target,
  verdict: incident.verdict,
  detectedAt: incident.detectedAt,
  updatedAt: incident.updatedAt,
});

/** Called with each new incident: its container's task opens or joins it. */
export type IncidentListener = (incident: IncidentRow, host: HostRow) => void;

/** Incidents and their trace: every step from the Docker event to the outcome, in order. */
export class IncidentsService {
  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly clock: () => number = Date.now,
    private readonly onCreated: IncidentListener = () => undefined,
  ) {}

  create(host: HostRow, submission: IncidentSubmission, status: IncidentStatus): IncidentRow {
    const { report, detectedAt } = submission;
    const now = this.clock();
    const created = this.databaseHandle.database.transaction((transaction) => {
      const incident = transaction
        .insert(incidents)
        .values({
          id: randomUUID(),
          hostId: host.id,
          containerName: report.containerName,
          image: report.image,
          triggerEvent: report.trigger,
          detectedAt,
          status,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      transaction
        .insert(incidentReports)
        .values({ incidentId: incident.id, reportJson: JSON.stringify(report) })
        .run();
      transaction
        .insert(incidentEvents)
        .values({
          incidentId: incident.id,
          kind: TRACE.reported,
          payloadJson: JSON.stringify({ host: host.label, trigger: report.trigger, detectedAt }),
          createdAt: now,
        })
        .run();
      return incident;
    });
    // Healing must not depend on task bookkeeping: a failure there is logged, the incident goes on.
    try {
      this.onCreated(created, host);
    } catch (error) {
      log(describeError(error));
    }
    return created;
  }

  addEvent(incidentId: string, kind: TraceKind, payload: Record<string, unknown> = {}) {
    this.databaseHandle.database
      .insert(incidentEvents)
      .values({ incidentId, kind, payloadJson: JSON.stringify(payload), createdAt: this.clock() })
      .run();
  }

  update(incidentId: string, change: IncidentChange): IncidentRow {
    const updated = this.databaseHandle.database
      .update(incidents)
      .set({ ...change, updatedAt: this.clock() })
      .where(eq(incidents.id, incidentId))
      .returning()
      .get();
    if (updated === undefined) {
      throw new DomainError(API_ERRORS.incidentNotFound);
    }
    return updated;
  }

  /**
   * What the runner did; anything that still needs a person waits for approval. A late or repeated
   * report never moves an incident backwards: once a person decided, or it was resolved or
   * cancelled, only the outcome text and the trace are updated.
   */
  recordOutcome(host: HostRow, incidentId: string, result: Outcome): IncidentRow {
    const incident = this.find(incidentId);
    if (incident.hostId !== host.id) {
      throw new DomainError(API_ERRORS.incidentNotFound);
    }
    this.addEvent(incidentId, TRACE.outcomeReported, { ...result });
    const settled = SETTLED_STATUSES.has(incident.status);
    const fromOutcome =
      result.verdict === VERDICT_ESCALATED ? INCIDENT_STATUS.awaitingApproval : INCIDENT_STATUS.resolved;
    return this.update(incidentId, {
      status: settled ? incident.status : fromOutcome,
      verdict: result.verdict,
      outcome: result.outcome,
    });
  }

  /**
   * Nothing is left to decide: the container is gone, or fine again. Only while it still waits for a person, so a
   * decision made meanwhile stands; null when it no longer waited.
   */
  settleUnneeded(incidentId: string, outcome: string): IncidentRow | null {
    const settled = this.databaseHandle.database
      .update(incidents)
      .set({ status: INCIDENT_STATUS.resolved, verdict: VERDICT_SKIPPED, outcome, updatedAt: this.clock() })
      .where(and(eq(incidents.id, incidentId), eq(incidents.status, INCIDENT_STATUS.awaitingApproval)))
      .returning()
      .get();
    if (settled === undefined) {
      return null;
    }
    this.addEvent(incidentId, TRACE.noLongerNeeded);
    return settled;
  }

  /** What the latest step of this kind in the incident's trace carried; null when it has none. */
  latestEvent(incidentId: string, kind: TraceKind): Record<string, unknown> | null {
    const event = this.databaseHandle.database
      .select({ payloadJson: incidentEvents.payloadJson })
      .from(incidentEvents)
      .where(and(eq(incidentEvents.incidentId, incidentId), eq(incidentEvents.kind, kind)))
      .orderBy(desc(incidentEvents.id))
      .get();
    return event === undefined ? null : (JSON.parse(event.payloadJson) as Record<string, unknown>);
  }

  /** Which of these kinds the incident's trace holds last; null when none. */
  latestKind(incidentId: string, kinds: readonly TraceKind[]): TraceKind | null {
    const event = this.databaseHandle.database
      .select({ kind: incidentEvents.kind })
      .from(incidentEvents)
      .where(and(eq(incidentEvents.incidentId, incidentId), inArray(incidentEvents.kind, [...kinds])))
      .orderBy(desc(incidentEvents.id))
      .get();
    return event === undefined ? null : (event.kind as TraceKind);
  }

  /** What each step of this kind carried since then, in any incident of the container on its host. */
  eventsSince(hostId: string, containerName: string, kind: TraceKind, since: number): Record<string, unknown>[] {
    return this.databaseHandle.database
      .select({ payloadJson: incidentEvents.payloadJson })
      .from(incidentEvents)
      .innerJoin(incidents, eq(incidents.id, incidentEvents.incidentId))
      .where(
        and(
          eq(incidents.hostId, hostId),
          eq(incidents.containerName, containerName),
          eq(incidentEvents.kind, kind),
          gte(incidentEvents.createdAt, since),
        ),
      )
      .all()
      .map((event) => JSON.parse(event.payloadJson) as Record<string, unknown>);
  }

  /** Incidents left mid-decision by a control-plane restart: the runner fell back on its own. */
  cancelInterrupted(): number {
    const stuck = this.databaseHandle.database
      .select({ id: incidents.id })
      .from(incidents)
      .where(eq(incidents.status, INCIDENT_STATUS.deciding))
      .all();
    for (const { id } of stuck) {
      this.addEvent(id, TRACE.controlPlaneRestarted);
      this.update(id, { status: INCIDENT_STATUS.cancelled });
    }
    return stuck.length;
  }

  /** The runner stopped waiting for this decision and handled the failure itself. */
  cancelAbandoned(incidentId: string) {
    this.addEvent(incidentId, TRACE.runnerGaveUp);
    this.update(incidentId, { status: INCIDENT_STATUS.cancelled });
  }

  /** Its runner will never say how the repair ended: a person decides, unless it clears by itself first. */
  askAfterLostOutcome(incidentId: string) {
    this.addEvent(incidentId, TRACE.outcomeLost);
    this.update(incidentId, { status: INCIDENT_STATUS.awaitingApproval, outcome: INCIDENT_OUTCOME_LOST });
  }

  /** An incident the runner handled alone while this control plane was unreachable. */
  recordHandled(host: HostRow, handled: HandledIncident): IncidentRow {
    const incident = this.create(host, handled, INCIDENT_STATUS.decided);
    this.addEvent(incident.id, TRACE.handledLocally, { ...handled.decision });
    this.update(incident.id, {
      decidedBy: DECIDED_BY.agentFallback,
      action: handled.decision.action,
      target: handled.decision.target,
      diagnosis: handled.decision.diagnosis,
    });
    return this.recordOutcome(host, incident.id, handled.result);
  }

  find(incidentId: string): IncidentRow {
    const incident = this.databaseHandle.database.select().from(incidents).where(eq(incidents.id, incidentId)).get();
    if (incident === undefined) {
      throw new DomainError(API_ERRORS.incidentNotFound);
    }
    return incident;
  }

  /** The same container's incidents on the same host before that moment, from the last month, newest first. */
  earlierRows(hostId: string, containerName: string, before: number): IncidentRow[] {
    return this.databaseHandle.database
      .select()
      .from(incidents)
      .where(
        and(
          eq(incidents.hostId, hostId),
          eq(incidents.containerName, containerName),
          lt(incidents.createdAt, before),
          gte(incidents.createdAt, before - INCIDENT_MEMORY.windowMilliseconds),
          ne(incidents.status, INCIDENT_STATUS.deciding),
        ),
      )
      .orderBy(desc(incidents.createdAt))
      .limit(INCIDENT_MEMORY.count)
      .all();
  }

  approvalsOf(incidentId: string): ApprovalView[] {
    return this.databaseHandle.database
      .select({ approval: approvals, username: users.username })
      .from(approvals)
      .innerJoin(users, eq(users.id, approvals.decidedBy))
      .where(eq(approvals.incidentId, incidentId))
      .orderBy(asc(approvals.decidedAt))
      .all()
      .map(({ approval, username }) => ({
        id: approval.id,
        choice: approval.choice,
        target: approval.target,
        note: approval.note,
        decidedBy: username,
        decidedAt: approval.decidedAt,
      }));
  }

  /** What the prompt carried besides the report, kept so a replay asks with the same. */
  saveEvidence(incidentId: string, sections: readonly string[]) {
    this.databaseHandle.database
      .update(incidentReports)
      .set({ evidenceJson: JSON.stringify(sections) })
      .where(eq(incidentReports.incidentId, incidentId))
      .run();
  }

  evidenceOf(incidentId: string): string[] {
    const row = this.databaseHandle.database
      .select({ evidenceJson: incidentReports.evidenceJson })
      .from(incidentReports)
      .where(eq(incidentReports.incidentId, incidentId))
      .get();
    const evidenceJson = row?.evidenceJson ?? null;
    return evidenceJson === null ? [] : (JSON.parse(evidenceJson) as string[]);
  }

  /** The failed container's last half hour, kept with the incident: it outlives the metrics' own half hour. */
  saveUsage(incidentId: string, points: readonly ContainerUsageView[]) {
    this.databaseHandle.database
      .update(incidentReports)
      .set({ usageJson: JSON.stringify(points) })
      .where(eq(incidentReports.incidentId, incidentId))
      .run();
  }

  usageOf(incidentId: string): ContainerUsageView[] {
    const row = this.databaseHandle.database
      .select({ usageJson: incidentReports.usageJson })
      .from(incidentReports)
      .where(eq(incidentReports.incidentId, incidentId))
      .get();
    const usageJson = row?.usageJson ?? null;
    return usageJson === null ? [] : (JSON.parse(usageJson) as ContainerUsageView[]);
  }

  reportOf(incidentId: string): IncidentReport | null {
    const row = this.databaseHandle.database
      .select()
      .from(incidentReports)
      .where(eq(incidentReports.incidentId, incidentId))
      .get();
    return row === undefined ? null : (JSON.parse(row.reportJson) as IncidentReport);
  }

  // The API's lists stop at INCIDENT_LIST_LIMIT; a container's timeline asks for more.
  list(filters: IncidentFilters = {}, most = INCIDENT_LIST_LIMIT): IncidentSummaryView[] {
    const conditions: SQL[] = [];
    if (filters.hostId !== undefined) {
      conditions.push(eq(incidents.hostId, filters.hostId));
    }
    if (filters.containerName !== undefined) {
      conditions.push(eq(incidents.containerName, filters.containerName));
    }
    if (filters.status !== undefined) {
      conditions.push(eq(incidents.status, filters.status));
    }
    return this.databaseHandle.database
      .select({ incident: incidents, hostLabel: hosts.label })
      .from(incidents)
      .innerJoin(hosts, eq(hosts.id, incidents.hostId))
      .where(and(...conditions))
      .orderBy(desc(incidents.createdAt))
      .limit(Math.min(filters.limit ?? most, most))
      .all()
      .map(({ incident, hostLabel }) => summaryView(incident, hostLabel));
  }

  detail(incidentId: string): IncidentDetailView {
    const database = this.databaseHandle.database;
    const row = database
      .select({ incident: incidents, hostLabel: hosts.label })
      .from(incidents)
      .innerJoin(hosts, eq(hosts.id, incidents.hostId))
      .where(eq(incidents.id, incidentId))
      .get();
    if (row === undefined) {
      throw new DomainError(API_ERRORS.incidentNotFound);
    }
    const report = this.reportOf(incidentId);
    const trace = database
      .select()
      .from(incidentEvents)
      .where(eq(incidentEvents.incidentId, incidentId))
      .orderBy(asc(incidentEvents.id))
      .all()
      .map((event) => ({
        id: event.id,
        kind: event.kind,
        payload: JSON.parse(event.payloadJson) as Record<string, unknown>,
        createdAt: event.createdAt,
      }));
    const thinking = trace.findLast((event) => event.kind === TRACE.modelAnswered)?.payload.thinking;
    return {
      ...summaryView(row.incident, row.hostLabel),
      diagnosis: row.incident.diagnosis,
      outcome: row.incident.outcome,
      promptHash: row.incident.promptHash,
      modelName: row.incident.modelName,
      modelDigest: row.incident.modelDigest,
      reasoning: typeof thinking === "string" ? thinking : null,
      report:
        report === null
          ? null
          : {
              stateSummary: report.stateSummary,
              healthOutputs: report.healthOutputs,
              knownContainers: report.knownContainers,
              protectedContainers: report.protectedContainers,
              logs: report.logs,
              composeProject: report.composeProject ?? null,
              neighbours: report.neighbours ?? [],
            },
      trace: trace.map(withoutThinking),
      approvals: this.approvalsOf(incidentId),
      earlier: this.earlierRows(row.incident.hostId, row.incident.containerName, row.incident.createdAt).map(
        (earlier) => summaryView(earlier, row.hostLabel),
      ),
      evidence: this.evidenceOf(incidentId),
      usage: this.usageOf(incidentId),
    };
  }
}
