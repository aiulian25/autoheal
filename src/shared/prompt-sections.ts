import type { ContainerUsageView, HostChangeView } from "./api.js";
import {
  BYTES_PER_GIBIBYTE,
  BYTES_PER_MEBIBYTE,
  EVIDENCE_TEXT,
  FLIGHT_RECORDER,
  HOST_CHANGE_TEXT,
  INCIDENT_MEMORY,
  METRICS_HISTORY_MILLISECONDS,
  METRICS_INTERVAL_MILLISECONDS,
  MILLISECONDS_PER_MINUTE,
  MILLISECONDS_PER_SECOND,
} from "./constants.js";
import { utcMinute } from "./time-zones.js";

/** One earlier incident of the same container, as the prompt tells it: facts and the owner's words only. */
export interface EarlierIncident {
  detectedAt: number;
  trigger: string;
  action: string | null;
  target: string | null;
  verdict: string | null;
  status: string;
  outcome: string | null;
  approvals: { choice: string; target: string | null; note: string | null; decidedBy: string }[];
}

const withTarget = (word: string, target: string | null) => (target === null ? word : `${word} ${target}`);

function earlierLines(incident: EarlierIncident): string[] {
  const action = incident.action === null ? EVIDENCE_TEXT.noDecision : withTarget(incident.action, incident.target);
  const outcome = (incident.outcome ?? incident.verdict ?? incident.status).slice(0, INCIDENT_MEMORY.outcomeCharacters);
  return [
    EVIDENCE_TEXT.earlier(utcMinute(incident.detectedAt), incident.trigger, action, outcome),
    ...incident.approvals.map((approval) =>
      EVIDENCE_TEXT.approval(approval.decidedBy, withTarget(approval.choice, approval.target), approval.note),
    ),
  ];
}

/** The container's earlier incidents for the prompt, newest first; null when it has none. */
export function renderEarlierIncidents(incidents: readonly EarlierIncident[]): string | null {
  if (incidents.length === 0) {
    return null;
  }
  return [EVIDENCE_TEXT.earlierHeading, ...incidents.flatMap(earlierLines)].join("\n");
}

/** At most `most` of the readings, evenly spread, the last always among them. */
export function sampledUsage(
  points: readonly ContainerUsageView[],
  most: number = FLIGHT_RECORDER.points,
): ContainerUsageView[] {
  const stride = Math.max(1, Math.ceil((points.length - 1) / (most - 1)));
  const kept = points.filter((_, index) => index % stride === 0);
  const last = points.at(-1);
  return last === undefined || kept.at(-1) === last ? kept : [...kept, last];
}

const memoryText = (bytes: number) =>
  bytes >= BYTES_PER_GIBIBYTE
    ? EVIDENCE_TEXT.gibibytes((bytes / BYTES_PER_GIBIBYTE).toFixed(2))
    : EVIDENCE_TEXT.mebibytes(Math.round(bytes / BYTES_PER_MEBIBYTE));
const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

function memoryLine(first: ContainerUsageView, last: ContainerUsageView, peakPercent: number): string {
  const [from, to] = [memoryText(first.memoryBytes), memoryText(last.memoryBytes)];
  if (last.memoryLimitBytes === null) {
    return EVIDENCE_TEXT.memoryWithoutLimit(from, to, peakPercent);
  }
  return EVIDENCE_TEXT.memoryWithLimit(from, to, memoryText(last.memoryLimitBytes), peakPercent);
}

function cpuLine(points: readonly ContainerUsageView[], cores: number | null): string {
  const shares = points.map((point) => point.cpuPercent);
  const average = Math.round(mean(shares));
  const peak = Math.round(Math.max(...shares));
  if (cores === null) {
    return EVIDENCE_TEXT.cpuWithoutLimit(average, peak);
  }
  return EVIDENCE_TEXT.cpuWithLimit(average, peak, cores);
}

/** What the failed container did in the half hour before Autoheal looked, as measured; null without two readings. */
export function renderUsage(points: readonly ContainerUsageView[]): string | null {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined || points.length < 2) {
    return null;
  }
  const peakMemory = Math.round(Math.max(...points.map((point) => point.memoryPercent)));
  const throttled = points.flatMap((point) => (point.throttledPercent === null ? [] : [point.throttledPercent]));
  const heldBack = throttled.length === 0 ? 0 : Math.round(mean(throttled));
  return [
    EVIDENCE_TEXT.usageHeading(
      METRICS_HISTORY_MILLISECONDS / MILLISECONDS_PER_MINUTE,
      METRICS_INTERVAL_MILLISECONDS / MILLISECONDS_PER_SECOND,
    ),
    memoryLine(first, last, peakMemory),
    cpuLine(points, last.cpuLimitCores),
    ...(heldBack > 0 ? [EVIDENCE_TEXT.throttled(heldBack)] : []),
  ].join("\n");
}

/** What changed on the host lately for the failed container, its neighbours and the host itself; null for nothing. */
export function renderChanges(changes: readonly HostChangeView[]): string | null {
  if (changes.length === 0) {
    return null;
  }
  const lines = changes.map((change) =>
    EVIDENCE_TEXT.change(
      utcMinute(change.at),
      change.containerName ?? EVIDENCE_TEXT.hostSubject,
      HOST_CHANGE_TEXT[change.kind](change.details),
    ),
  );
  return [EVIDENCE_TEXT.changesHeading, ...lines].join("\n");
}
