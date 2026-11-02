import type { AssigneeChoice, ResourceAdviceView } from "../../shared/api.js";
import {
  DETECTOR_KEYS,
  DETECTOR_KEY_SEPARATOR,
  HOST_STATUS_ACTIVE,
  RESOURCE_ADVICE,
  RESOURCE_ADVICE_TEXT,
  TASK_PRIORITY,
  TASK_RESOURCE,
  TASK_SOURCE,
  TRIGGER_OOM,
} from "../../shared/constants.js";
import type { DatabaseHandle } from "../database/connection.js";
import type { MetricsStore } from "../inventory/metrics-store.js";
import type { DetectedProblem, Detection } from "./detectors.js";

// A container's five-minute memory means within the window, maintenance left out.
const MEMORY_MEANS = `
SELECT metric_rollups.memory AS memory FROM metric_rollups
JOIN metric_series ON metric_series.id = metric_rollups.series_id
WHERE metric_series.host_id = @hostId AND metric_series.container_name = @containerName
  AND metric_rollups.excluded = 0 AND metric_rollups.memory IS NOT NULL AND metric_rollups.at >= @since`;

// How often each container of an active host ran out of memory within the window.
const OOM_KILLS = `
SELECT incidents.host_id AS hostId, hosts.label AS hostLabel, incidents.container_name AS containerName,
  count(*) AS kills
FROM incidents JOIN hosts ON hosts.id = incidents.host_id
WHERE incidents.trigger_event = @oom AND incidents.detected_at >= @since AND hosts.status = @active
GROUP BY incidents.host_id, incidents.container_name`;

interface Kills {
  hostId: string;
  hostLabel: string;
  containerName: string;
  kills: number;
}

const oomLoopKey = (hostId: string, containerName: string) =>
  [DETECTOR_KEYS.oomLoop, hostId, containerName].join(DETECTOR_KEY_SEPARATOR);
const OOM_LOOP_PREFIX = `${DETECTOR_KEYS.oomLoop}${DETECTOR_KEY_SEPARATOR}`;

/** A limit with room above what the container used: the p99 of its five-minute means, with headroom, rounded up. */
export function memoryAdvice(means: readonly number[]): ResourceAdviceView["memory"] {
  if (means.length < RESOURCE_ADVICE.minimumBuckets) {
    return null;
  }
  const sorted = [...means].sort((first, second) => first - second);
  const percentileBytes = sorted[Math.ceil(RESOURCE_ADVICE.percentile * sorted.length) - 1]!;
  const rounding = RESOURCE_ADVICE.roundingBytes;
  const suggestedBytes = Math.ceil((percentileBytes * RESOURCE_ADVICE.headroom) / rounding) * rounding;
  return { percentileBytes, suggestedBytes, buckets: sorted.length };
}

/**
 * What a container's memory readings suggest for its limit, and a task for a person when it keeps running out of
 * memory. It only advises: the limit is set where the container is defined.
 */
export class ResourceAdvisor {
  private readonly clock: () => number;

  constructor(
    private readonly dependencies: {
      databaseHandle: DatabaseHandle;
      metricsStore: Pick<MetricsStore, "latestContainers">;
      owner: () => AssigneeChoice | null;
      clock?: () => number;
    },
  ) {
    this.clock = dependencies.clock ?? Date.now;
  }

  advice(hostId: string, containerName: string): ResourceAdviceView {
    const since = this.clock() - RESOURCE_ADVICE.windowMilliseconds;
    const means = this.dependencies.databaseHandle.sqlite
      .prepare(MEMORY_MEANS)
      .all({ hostId, containerName, since }) as { memory: number }[];
    const usage = this.dependencies.metricsStore.latestContainers(hostId).get(containerName);
    const kills = this.kills().find((row) => row.hostId === hostId && row.containerName === containerName);
    return {
      memory: memoryAdvice(means.map((row) => row.memory)),
      ...(usage === undefined ? {} : { limitBytes: usage.memoryLimitBytes }),
      oomKills: kills?.kills ?? 0,
    };
  }

  /** A task for each container that ran out of memory three times within the window; it closes once it has not. */
  detect(): Detection {
    const owner = this.dependencies.owner();
    const problems = this.kills()
      .filter((row) => row.kills >= RESOURCE_ADVICE.oomKills)
      .map((row): DetectedProblem => {
        const advice = RESOURCE_ADVICE_TEXT.advice(this.advice(row.hostId, row.containerName).memory);
        return {
          key: oomLoopKey(row.hostId, row.containerName),
          title: RESOURCE_ADVICE_TEXT.taskTitle(row.containerName, row.kills, row.hostLabel),
          description: RESOURCE_ADVICE_TEXT.taskDetails(advice),
          source: TASK_SOURCE.detector,
          priority: TASK_PRIORITY.high,
          hostId: row.hostId,
          resource: { kind: TASK_RESOURCE.container, id: row.containerName, label: row.containerName },
          labels: [],
          assignee: owner,
          graceMilliseconds: 0,
        };
      });
    return { problems, judges: (key) => key.startsWith(OOM_LOOP_PREFIX) };
  }

  private kills(): Kills[] {
    return this.dependencies.databaseHandle.sqlite.prepare(OOM_KILLS).all({
      oom: TRIGGER_OOM,
      since: this.clock() - RESOURCE_ADVICE.windowMilliseconds,
      active: HOST_STATUS_ACTIVE,
    }) as Kills[];
  }
}
