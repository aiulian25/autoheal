import type { AssigneeChoice } from "../../shared/api.js";
import { TASK_PRIORITY, TASK_RESOURCE, TASK_SOURCE, sizeText } from "../../shared/constants.js";
import { ANOMALY_TASK_LABEL, type MetricAnomalyView } from "../../shared/metric-trends.js";
import type { MetricRollups } from "../inventory/metric-rollups.js";
import type { DetectedProblem, Detection } from "./detectors.js";

export function anomalyFinding(observation: MetricAnomalyView, owner: AssigneeChoice | null): DetectedProblem {
  const subject = observation.containerName ?? observation.hostLabel;
  const metric = { cpu: "CPU use", memory: "memory use", io: "disk traffic" }[observation.metric];
  const format = (value: number) =>
    observation.metric === "cpu"
      ? `${value.toFixed(1)}%`
      : observation.metric === "io"
        ? `${sizeText(value)}/s`
        : sizeText(value);
  return {
    key: observation.taskKey,
    title: `${subject}: unusually ${observation.pattern === "rising" ? "rising" : "high"} ${metric}`,
    description: `Observed ${metric} was ${format(observation.observed)}, compared with a learned typical ${format(observation.baseline)} and observation threshold ${format(observation.threshold)}. It stayed above the learned range for three consecutive five-minute buckets. The baseline uses ${observation.baselineBuckets} buckets (${observation.baselineSamples} samples); the recent period contains ${observation.recentSamples} samples. Maintenance and missing data are excluded. This is an observation for a person to review, not a diagnosis or permission to restart anything. Review the trend and record whether this was useful, expected, or a false positive.`,
    source: TASK_SOURCE.detector,
    priority: TASK_PRIORITY.medium,
    hostId: observation.hostId,
    resource:
      observation.containerName === null
        ? { kind: TASK_RESOURCE.host, id: observation.hostId, label: observation.hostLabel }
        : { kind: TASK_RESOURCE.container, id: observation.containerName, label: observation.containerName },
    labels: [ANOMALY_TASK_LABEL, `${ANOMALY_TASK_LABEL}-${observation.metric}`],
    assignee: owner,
    graceMilliseconds: 0,
  };
}

/** Observation only: no action dispatcher, model, or Docker transport is available here. */
export class AnomalyDetector {
  constructor(
    private readonly dependencies: {
      rollups: Pick<MetricRollups, "evaluate" | "allObservations" | "judges">;
      owner: () => AssigneeChoice | null;
    },
  ) {}
  detect(): Detection {
    try {
      this.dependencies.rollups.evaluate();
      const owner = this.dependencies.owner();
      return {
        problems: this.dependencies.rollups
          .allObservations()
          .filter((item) => item.state === "active")
          .map((item) => anomalyFinding(item, owner)),
        judges: (key) => this.dependencies.rollups.judges(key),
      };
    } catch {
      return { problems: [], judges: () => false };
    }
  }
}
