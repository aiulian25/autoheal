import { z } from "zod";
export const TREND = {
  interval: 5 * 60_000,
  cadence: 5_000,
  flush: 60_000,
  retention: 7 * 86_400_000,
  baselineWindow: 86_400_000,
  minimumSamples: 36,
  minimumBaselineBuckets: 24,
  recentBuckets: 3,
  series: 2048,
  rows: 200_000,
  evaluationBatch: 128,
  freshness: 120_000,
} as const;
export const TREND_METRICS = ["cpu", "memory", "io"] as const;
export type TrendMetric = (typeof TREND_METRICS)[number];
export const ANOMALY_TASK_LABEL = "anomaly";
export const anomalyFeedbackSchema = z
  .object({
    observedAt: z.number().int().nonnegative().safe(),
    assessment: z.enum(["useful", "expected", "false_positive"]),
  })
  .strict();
export type AnomalyFeedback = z.infer<typeof anomalyFeedbackSchema>;
export interface TrendPoint {
  at: number;
  identity: string;
  excluded: boolean;
  cpu: number | null;
  memory: number | null;
  io: number | null;
  cpuSamples: number;
  memorySamples: number;
  ioSamples: number;
}
export interface TrendBaseline {
  metric: TrendMetric;
  median: number;
  mad: number;
  threshold: number;
  observed: number;
  baselineBuckets: number;
  baselineSamples: number;
  recentSamples: number;
  since: number;
  observedAt: number;
  elevated: boolean;
  pattern: "elevated" | "rising";
}
export interface MetricAnomalyView {
  id: string;
  hostId: string;
  hostLabel: string;
  containerName: string | null;
  metric: TrendMetric;
  identity: string;
  state: "active" | "clear" | "unknown";
  observedAt: number;
  baseline: number;
  mad: number;
  threshold: number;
  observed: number;
  baselineBuckets: number;
  baselineSamples: number;
  recentSamples: number;
  pattern: "elevated" | "rising";
  feedback: AnomalyFeedback["assessment"] | null;
  feedbackAt: number | null;
  taskKey: string;
}
export interface MetricTrendView {
  hostId: string;
  containerName: string | null;
  interval: number;
  retention: number;
  status: "ready" | "learning" | "maintenance" | "stale" | "capacity" | "unavailable";
  lastSampleAt: number | null;
  identity: string | null;
  points: TrendPoint[];
  baselines: TrendBaseline[];
  anomalies: MetricAnomalyView[];
  health: { capacityLimited: boolean; unavailable: boolean; retainedSeries: number; retainedRows: number };
  explanation: string;
}
export const anomalyTaskKey = (series: string, metric: TrendMetric, identity: string) =>
  `anomaly|${series}|${metric}|${identity}`;
