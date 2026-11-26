import {
  CONTAINER_STATE_RUNNING,
  HOST_CHANGE,
  REPORT_LIMITS,
  SELF_UPDATE,
  type HostChangeDetails,
  type HostChangeKind,
} from "../../shared/constants.js";
import type { ContainerSnapshot, Heartbeat, HostHealth } from "../../shared/protocol.js";

export interface HostChange {
  kind: HostChangeKind;
  containerName: string | null;
  details: HostChangeDetails;
}

const running = (container: ContainerSnapshot) => container.state === CONTAINER_STATE_RUNNING;
// Autoheal's own update helper, which older runners report and newer ones leave out: never one of the host's changes,
// least of all a removal read off the first report of the runner it just made.
const isHostContainer = (container: ContainerSnapshot) => container.name !== SELF_UPDATE.helperName;

// What happened to one container between two reports: the most telling change only.
function containerChange(before: ContainerSnapshot, after: ContainerSnapshot): HostChange | null {
  const change = (kind: HostChangeKind, details: HostChangeDetails = {}) => ({
    kind,
    containerName: after.name,
    details,
  });
  if (before.containerId !== after.containerId) {
    return change(HOST_CHANGE.recreated, { imageBefore: before.image, imageAfter: after.image });
  }
  if (after.restartCount > before.restartCount) {
    return change(HOST_CHANGE.restarted, { times: after.restartCount - before.restartCount });
  }
  if (running(before) && !running(after)) {
    return change(HOST_CHANGE.stopped, { exitCode: after.exitCode, oomKilled: after.oomKilled });
  }
  if (!running(before) && running(after)) {
    return change(HOST_CHANGE.started);
  }
  return null;
}

// Only what both reports say: a field an older runner leaves out, or a host it could not read, changes nothing.
function hostChanges(before: HostHealth | null, after: HostHealth | null): HostChange[] {
  if (before === null || after === null) {
    return [];
  }
  const changes: HostChange[] = [];
  const host = (kind: HostChangeKind, details: HostChangeDetails = {}) => ({ kind, containerName: null, details });
  if (before.bootId && after.bootId && before.bootId !== after.bootId) {
    changes.push(host(HOST_CHANGE.rebooted));
  }
  if (before.dockerVersion && after.dockerVersion && before.dockerVersion !== after.dockerVersion) {
    changes.push(host(HOST_CHANGE.dockerUpgraded, { before: before.dockerVersion, after: after.dockerVersion }));
  }
  if (before.kernel !== after.kernel) {
    changes.push(host(HOST_CHANGE.kernelChanged, { before: before.kernel, after: after.kernel }));
  }
  return changes;
}

/** A report as the detectors read it. */
export interface DetectorReport {
  containers: readonly ContainerSnapshot[];
  health: HostHealth | null;
  docker: boolean;
  eventStreamConnected: boolean;
}

// What the detectors read of a report that can differ from one report to the next. Figures that move every time
// (load, memory, disk bytes) are left to their regular look.
function detectorFacts(report: DetectorReport): string {
  const containers = [...report.containers]
    .sort((first, second) => first.name.localeCompare(second.name))
    .map((container) => [
      container.name,
      container.state,
      container.health,
      container.exitCode,
      container.oomKilled,
      container.restartCount,
      container.update?.status ?? null,
      container.update?.newerTag ?? null,
    ]);
  const health = report.health;
  const facts =
    health === null
      ? null
      : [
          health.rebootRequired,
          health.pendingUpdates,
          health.bootId ?? null,
          health.packages?.databaseChangedAt ?? null,
          health.packages?.kernelWaiting ?? null,
        ];
  return JSON.stringify([containers, facts, report.docker, report.eventStreamConnected]);
}

/** Whether a report changed anything the detectors read since the one before: then they look again at once. */
export const changedForDetectors = (previous: DetectorReport, next: DetectorReport) =>
  detectorFacts(previous) !== detectorFacts(next);

/** What changed on a host between its last report and this one: the host first, then its containers. */
export function changesBetween(
  previous: { containers: readonly ContainerSnapshot[]; health: HostHealth | null },
  next: Heartbeat,
): HostChange[] {
  const earlier = previous.containers.filter(isHostContainer);
  const later = next.containers.filter(isHostContainer);
  const before = new Map(earlier.map((container) => [container.name, container]));
  const after = new Set(later.map((container) => container.name));
  const appeared = later
    .filter((container) => !before.has(container.name))
    .map((container) => ({
      kind: HOST_CHANGE.appeared,
      containerName: container.name,
      details: { image: container.image },
    }));
  const removed = earlier
    .filter((container) => !after.has(container.name))
    .map((container) => ({
      kind: HOST_CHANGE.removed,
      containerName: container.name,
      details: { image: container.image },
    }));
  const changed = later.flatMap((container) => {
    const reported = before.get(container.name);
    const change = reported === undefined ? null : containerChange(reported, container);
    return change === null ? [] : [change];
  });
  return [...hostChanges(previous.health, next.host), ...appeared, ...removed, ...changed].slice(
    0,
    REPORT_LIMITS.containers,
  );
}
