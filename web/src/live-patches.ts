import type { ContainerUsageView, ContainerView, HostMetricsView, HostView } from "../../src/shared/api.js";
import {
  CONTAINER_STATE_RUNNING,
  METRICS_HISTORY_MILLISECONDS,
  METRICS_HISTORY_POINTS,
} from "../../src/shared/constants.js";

// Hosts' new readings put straight into what the pages hold, instead of reading whole lists again every few seconds.
// Each gives undefined for what it would leave as it was, so nothing that did not change is told it did.

/** The hosts list with the latest readings of the hosts that sent some, the others as they were. */
export function withHostMetrics(
  hosts: HostView[] | undefined,
  readings: ReadonlyMap<string, HostMetricsView | null>,
): HostView[] | undefined {
  if (hosts === undefined || !hosts.some((host) => readings.has(host.id))) return undefined;
  return hosts.map((host) => {
    const metrics = readings.get(host.id);
    return metrics === undefined ? host : { ...host, metrics };
  });
}

/** A container list with the latest usage of the hosts that sent some: a container not running has none. */
export function withContainerUsage(
  list: ContainerView[] | undefined,
  usageByHost: ReadonlyMap<string, Readonly<Record<string, ContainerUsageView>>>,
): ContainerView[] | undefined {
  if (list === undefined || !list.some((container) => usageByHost.has(container.hostId))) return undefined;
  return list.map((container) => {
    const usage = usageByHost.get(container.hostId);
    if (usage === undefined) return container;
    // Its own entry only: a container may be named like anything every object has, "toString" among them.
    const reported = container.state === CONTAINER_STATE_RUNNING && Object.hasOwn(usage, container.name);
    return { ...container, usage: reported ? usage[container.name]! : null };
  });
}

/** A chart's points with a newer one at the end, none older than the window it shows; one not newer changes nothing. */
export function withHistoryPoint(
  points: HostMetricsView[] | undefined,
  point: HostMetricsView,
): HostMetricsView[] | undefined {
  const newest = points?.at(-1);
  if (points === undefined || (newest !== undefined && newest.at >= point.at)) return undefined;
  const kept = points.filter((known) => known.at >= point.at - METRICS_HISTORY_MILLISECONDS);
  return [...kept, point].slice(-METRICS_HISTORY_POINTS);
}
