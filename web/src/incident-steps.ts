// An incident as a line of steps, from noticed to done: what the board's panel and the incident page show.

import type { IncidentDetailView, TraceEventView } from "../../src/shared/api.js";
import {
  INCIDENT_STATUS,
  REPAIRS,
  TRACE,
  VERDICT_ESCALATED,
  wordsOf,
  type Repair,
} from "../../src/shared/constants.js";
import { TEXT } from "./constants.js";
import { actionText } from "./format.js";

export const STEP_STATE = { done: "done", current: "current", todo: "todo" } as const;
export type StepState = (typeof STEP_STATE)[keyof typeof STEP_STATE];

export interface IncidentStep {
  name: string;
  at: number | null;
  detail: string;
  state: StepState;
}

type Draft = Omit<IncidentStep, "state">;

export const REPAIR_STATE = {
  looking: "looking",
  underWay: "under_way",
  held: "held",
  failed: "failed",
  reported: "reported",
  skipped: "skipped",
} as const;
export type RepairState = (typeof REPAIR_STATE)[keyof typeof REPAIR_STATE];

/** Ollama's repair of a container given to it, as the incident's trace kept it. */
export interface RepairView {
  state: RepairState;
  repair: Repair | null;
  offered: Repair[];
  findings: string;
  cause: string;
  steps: string[];
  thinking: string | null;
  // What the runner said of the repair, or why none was tried.
  outcome: string | null;
  // When it ended; null while Ollama works on it.
  at: number | null;
  // Who handed the incident to Ollama; null where its container's own answer gave it.
  handedBy: string | null;
}

const OPEN_STATUSES: readonly string[] = [
  INCIDENT_STATUS.deciding,
  INCIDENT_STATUS.decided,
  INCIDENT_STATUS.awaitingApproval,
  INCIDENT_STATUS.approved,
];
const SETTLED_STATUSES: readonly string[] = [
  INCIDENT_STATUS.resolved,
  INCIDENT_STATUS.dismissed,
  INCIDENT_STATUS.cancelled,
];

const firstOf = (trace: readonly TraceEventView[], kinds: readonly string[]) =>
  trace.find((event) => kinds.includes(event.kind)) ?? null;

const latestOf = (trace: readonly TraceEventView[], kind: string) =>
  trace.findLast((event) => event.kind === kind) ?? null;

const textOf = (value: unknown) => (typeof value === "string" ? value : "");
const repairsIn = (value: unknown): Repair[] =>
  Array.isArray(value) ? REPAIRS.filter((repair) => value.includes(repair)) : [];

function repairState(
  planned: TraceEventView | null,
  finished: TraceEventView | null,
  skipped: TraceEventView | null,
): RepairState {
  if (finished !== null) {
    return finished.payload.succeeded === true ? REPAIR_STATE.held : REPAIR_STATE.failed;
  }
  if (planned !== null) {
    return typeof planned.payload.jobId === "string" ? REPAIR_STATE.underWay : REPAIR_STATE.reported;
  }
  return skipped === null ? REPAIR_STATE.looking : REPAIR_STATE.skipped;
}

/** Null when the incident's container was not given to Ollama, or its ask never got an answer. */
export function repairOf(incident: IncidentDetailView): RepairView | null {
  const started = latestOf(incident.trace, TRACE.repairStarted);
  // Only the latest attempt counts, handed over again after one that failed: what came since it started.
  const since = started?.id ?? 0;
  const sinceStart = (kind: string) => {
    const event = latestOf(incident.trace, kind);
    return event !== null && event.id > since ? event : null;
  };
  const planned = sinceStart(TRACE.repairPlanned);
  const finished = sinceStart(TRACE.repairFinished);
  const skipped = sinceStart(TRACE.repairSkipped);
  const looking = started !== null && incident.status === INCIDENT_STATUS.approved;
  if (planned === null && skipped === null && !looking) {
    return null;
  }
  const state = repairState(planned, finished, skipped);
  const plan = planned?.payload ?? {};
  const ended = finished ?? (state === REPAIR_STATE.reported ? planned : skipped);
  return {
    state,
    repair: repairsIn([plan.repair])[0] ?? null,
    offered: repairsIn(started?.payload.offered),
    findings: textOf(plan.findings),
    cause: textOf(plan.cause),
    steps: Array.isArray(plan.steps) ? plan.steps.map(textOf) : [],
    thinking: textOf(plan.thinking) || null,
    outcome: textOf(finished?.payload.outcome ?? skipped?.payload.reason) || null,
    at: ended?.createdAt ?? null,
    handedBy: textOf(latestOf(incident.trace, TRACE.dispatched)?.payload.by) || null,
  };
}

// While Ollama repairs it, or once its repair held, nobody has had to decide.
const LEFT_TO_OLLAMA: ReadonlySet<RepairState> = new Set([
  REPAIR_STATE.looking,
  REPAIR_STATE.underWay,
  REPAIR_STATE.held,
]);

function decisionDetail(incident: IncidentDetailView, decided: TraceEventView | null): string {
  if (decided?.kind === TRACE.modelFailed) {
    return TEXT.steps.ollamaFailed;
  }
  return incident.action === null ? "" : actionText(incident.action, incident.target);
}

// What Autoheal's own action came to then; a person's choice, and what it came to, have steps of their own.
function actedDetail(incident: IncidentDetailView, acted: TraceEventView): string {
  const verdict = acted.payload.verdict;
  return wordsOf(typeof verdict === "string" ? verdict : (incident.verdict ?? ""));
}

// Escalated incidents get a step for the person's decision; the others never wait for one.
function wasEscalated(incident: IncidentDetailView, repair: RepairView | null): boolean {
  const leftToOllama = repair !== null && LEFT_TO_OLLAMA.has(repair.state);
  const escalated = incident.status === INCIDENT_STATUS.awaitingApproval || incident.verdict === VERDICT_ESCALATED;
  return (
    incident.approvals.length > 0 ||
    firstOf(incident.trace, [TRACE.noLongerNeeded]) !== null ||
    (escalated && !leftToOllama)
  );
}

const repairStep = (repair: RepairView): Draft => ({
  name: TEXT.steps.repair,
  at: repair.at,
  detail: TEXT.steps.repairStates[repair.state],
});

function personStep(incident: IncidentDetailView): Draft {
  const approval = incident.approvals.at(-1);
  const unneeded = firstOf(incident.trace, [TRACE.noLongerNeeded]);
  if (approval === undefined && unneeded !== null) {
    return { name: TEXT.steps.yourDecision, at: unneeded.createdAt, detail: TEXT.steps.notNeeded };
  }
  if (approval === undefined) {
    return { name: TEXT.steps.yourDecision, at: null, detail: TEXT.steps.waiting };
  }
  return {
    name: TEXT.steps.yourDecision,
    at: approval.decidedAt,
    detail: TEXT.steps.decidedBy(wordsOf(approval.choice), approval.decidedBy),
  };
}

/** Each step is done once it happened; while the incident is open, the first one missing is current. */
export function incidentSteps(incident: IncidentDetailView): IncidentStep[] {
  const decided = firstOf(incident.trace, [TRACE.decided, TRACE.handledLocally, TRACE.modelFailed]);
  const acted = firstOf(incident.trace, [TRACE.outcomeReported, TRACE.workCompleted]);
  const settled = SETTLED_STATUSES.includes(incident.status);
  const repair = repairOf(incident);
  const drafts: Draft[] = [
    { name: TEXT.steps.noticed, at: incident.detectedAt, detail: TEXT.incident.triggers[incident.trigger] },
    { name: TEXT.steps.decided, at: decided?.createdAt ?? null, detail: decisionDetail(incident, decided) },
    {
      name: TEXT.steps.acted,
      at: acted?.createdAt ?? null,
      detail: acted === null ? "" : actedDetail(incident, acted),
    },
    ...(repair === null ? [] : [repairStep(repair)]),
    ...(wasEscalated(incident, repair) ? [personStep(incident)] : []),
    { name: TEXT.steps.done, at: settled ? incident.updatedAt : null, detail: settled ? wordsOf(incident.status) : "" },
  ];
  const open = OPEN_STATUSES.includes(incident.status);
  const currentIndex = open ? drafts.findIndex((draft) => draft.at === null) : -1;
  return drafts.map((draft, index) => {
    if (draft.at !== null) {
      return { ...draft, state: STEP_STATE.done };
    }
    return { ...draft, state: index === currentIndex ? STEP_STATE.current : STEP_STATE.todo };
  });
}
