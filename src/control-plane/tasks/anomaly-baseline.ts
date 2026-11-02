import { TREND, type TrendBaseline, type TrendMetric, type TrendPoint } from "../../shared/metric-trends.js";
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2;
};
const floors: Record<TrendMetric, number> = { cpu: 15, memory: 64 * 1024 ** 2, io: 1024 ** 2 };
const relative: Record<TrendMetric, number> = { cpu: 0.5, memory: 0.2, io: 1 };
/** Robust observed-data comparison; missing/maintenance buckets and single spikes never imply a fault. */
export function baselineOf(points: readonly TrendPoint[], metric: TrendMetric, now: number): TrendBaseline | null {
  const current = Math.floor(now / TREND.interval) * TREND.interval;
  const byTime = new Map(points.map((point) => [point.at, point]));
  const valid = (point: TrendPoint | undefined): point is TrendPoint =>
    point !== undefined &&
    !point.excluded &&
    point[metric] !== null &&
    point[`${metric}Samples`] >= TREND.minimumSamples;
  const recent = Array.from({ length: TREND.recentBuckets }, (_, index) =>
    byTime.get(current - (TREND.recentBuckets - index) * TREND.interval),
  );
  if (!recent.every(valid)) return null;
  const training = points.filter(
    (point) => point.at >= current - TREND.baselineWindow && point.at < recent[0]!.at && valid(point),
  );
  if (training.length < TREND.minimumBaselineBuckets) return null;
  const typical = median(training.map((point) => point[metric]!));
  const mad = median(training.map((point) => Math.abs(point[metric]! - typical)));
  const threshold = typical + Math.max(floors[metric], typical * relative[metric], 6 * 1.4826 * mad);
  const values = recent.map((point) => point[metric]!);
  return {
    metric,
    median: typical,
    mad,
    threshold,
    observed: median(values),
    baselineBuckets: training.length,
    baselineSamples: training.reduce((sum, point) => sum + point[`${metric}Samples`], 0),
    recentSamples: recent.reduce((sum, point) => sum + point[`${metric}Samples`], 0),
    since: training[0]!.at,
    observedAt: recent.at(-1)!.at + TREND.interval,
    elevated: values.every((value) => value > threshold),
    pattern:
      metric === "memory" &&
      values[0]! < values[1]! &&
      values[1]! < values[2]! &&
      values[2]! - values[0]! >= floors.memory / 2
        ? "rising"
        : "elevated",
  };
}
