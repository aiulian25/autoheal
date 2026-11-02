import {
  CONTAINER_STATE_RUNNING,
  HOST_CHANGE,
  REPORT_LIMITS,
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

/** What changed on a host between its last report and this one: the host first, then its containers. */
export function changesBetween(
  previous: { containers: readonly ContainerSnapshot[]; health: HostHealth | null },
  next: Heartbeat,
): HostChange[] {
  const before = new Map(previous.containers.map((container) => [container.name, container]));
  const after = new Set(next.containers.map((container) => container.name));
  const appeared = next.containers
    .filter((container) => !before.has(container.name))
    .map((container) => ({
      kind: HOST_CHANGE.appeared,
      containerName: container.name,
      details: { image: container.image },
    }));
  const removed = previous.containers
    .filter((container) => !after.has(container.name))
    .map((container) => ({
      kind: HOST_CHANGE.removed,
      containerName: container.name,
      details: { image: container.image },
    }));
  const changed = next.containers.flatMap((container) => {
    const earlier = before.get(container.name);
    const change = earlier === undefined ? null : containerChange(earlier, container);
    return change === null ? [] : [change];
  });
  return [...hostChanges(previous.health, next.host), ...appeared, ...removed, ...changed].slice(
    0,
    REPORT_LIMITS.containers,
  );
}
