import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_ROUTES, apiPath } from "../../../src/shared/api.js";
import {
  TREND,
  TREND_METRICS,
  type MetricTrendView,
  type MetricAnomalyView,
  type TrendMetric,
  type AnomalyFeedback,
} from "../../../src/shared/metric-trends.js";
import { api } from "../api-client.js";
import { bytes, precisePercent, rate } from "../format.js";
import { TimeChart, type ChartReference } from "./charts.js";
import { ErrorNotice } from "./common.js";
const metricName = { cpu: "CPU use", memory: "Memory use", io: "Disk traffic" };
const formatOf = { cpu: precisePercent, memory: bytes, io: rate };
export const trendQuery = (hostId: string, containerName: string | null) => ({
  queryKey: ["metric-trends", hostId, containerName],
  queryFn: async () => {
    const view = await api<MetricTrendView>(
      "GET",
      containerName === null
        ? apiPath(API_ROUTES.hostTrends, { hostId })
        : apiPath(API_ROUTES.containerTrends, { hostId, containerName }),
    );
    // Older or mismatched servers must leave live charts usable while showing trends unavailable.
    if (
      !view ||
      view.hostId !== hostId ||
      view.containerName !== containerName ||
      !Array.isArray(view.points) ||
      !Array.isArray(view.baselines) ||
      typeof view.health?.capacityLimited !== "boolean"
    )
      throw new Error("Retained trend response unavailable.");
    return view;
  },
  refetchInterval: TREND.flush,
  staleTime: TREND.flush,
});
export const trendReferences = (trend: MetricTrendView | undefined, metric: TrendMetric): ChartReference[] => {
  const baseline = trend?.status === "ready" ? trend.baselines.find((item) => item.metric === metric) : undefined;
  return baseline
    ? [
        { label: "Learned typical", value: baseline.median, from: baseline.since, tone: "violet" },
        { label: "Observation threshold", value: baseline.threshold, from: baseline.since, tone: "amber" },
      ]
    : [];
};
/** Coarse history is explicitly gapped across absent, excluded, sparse, or changed-identity buckets. */
export function trendChartData(trend: MetricTrendView, metric: TrendMetric) {
  const points = new Map(trend.points.map((point) => [point.at, point]));
  const last = trend.points.at(-1)?.at ?? 0;
  const first = trend.points[0]?.at ?? last;
  const times = Array.from(
    {
      length: Math.min(
        Math.ceil(TREND.retention / TREND.interval) + 1,
        Math.floor((last - first) / trend.interval) + 1,
      ),
    },
    (_, index) => first + index * trend.interval,
  );
  return {
    times,
    values: times.map((at) => {
      const point = points.get(at);
      return !point ||
        point.excluded ||
        point.identity !== trend.identity ||
        point[`${metric}Samples`] < TREND.minimumSamples
        ? null
        : point[metric];
    }),
  };
}
export function TrendHistory({ trend, error }: { trend: MetricTrendView | undefined; error: Error | null }) {
  if (error)
    return (
      <p role="status" className="small muted">
        Retained trends are unavailable. Live readings continue.
      </p>
    );
  if (!trend) return null;
  return (
    <section className="stack" aria-label="Learned resource trends">
      <p className="small muted">
        {trend.explanation} Status: {trend.status}. History is kept for up to seven days; pressure may shorten it.
      </p>
      {trend.health.capacityLimited && (
        <p role="status" className="small muted">
          Trend storage reached its fleet limit. Some history may be unavailable; no missing samples are treated as
          zero.
        </p>
      )}
      <details>
        <summary>Retained five-minute history</summary>
        <p className="small muted">
          Only the current application or host incarnation is joined. Gaps mean missing, sparse, maintenance, or
          older-incarnation data.
        </p>
        <div className="chart-grid">
          {TREND_METRICS.map((metric) => {
            const data = trendChartData(trend, metric);
            return (
              <TimeChart
                key={metric}
                title={metricName[metric]}
                times={data.times}
                series={[
                  { label: metricName[metric], tone: metric === "memory" ? "green" : "blue", values: data.values },
                ]}
                format={formatOf[metric]}
                references={trendReferences(trend, metric)}
                {...(metric === "cpu" ? { ceiling: 100 } : {})}
              />
            );
          })}
        </div>
      </details>
    </section>
  );
}
function Observation({ view, admin }: { view: MetricAnomalyView; admin: boolean }) {
  const client = useQueryClient();
  const feedback = useMutation({
    mutationFn: (assessment: AnomalyFeedback["assessment"]) =>
      api("POST", apiPath(API_ROUTES.metricAnomalyFeedback, { anomalyId: view.id }), {
        assessment,
        observedAt: view.observedAt,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["metric-anomalies", view.hostId, view.containerName] }),
  });
  const format = formatOf[view.metric];
  return (
    <section className="stack small" aria-label={`${metricName[view.metric]} observation`}>
      <p>
        Observed {format(view.observed)}; learned typical {format(view.baseline)}, threshold {format(view.threshold)}.{" "}
        {view.baselineBuckets} baseline buckets ({view.baselineSamples} samples), {view.recentSamples} recent samples.
        Compared at{" "}
        <time dateTime={new Date(view.observedAt).toISOString()}>{new Date(view.observedAt).toLocaleString()}</time>.
        State: {view.state}.
      </p>
      <p className="muted">
        This is an observation for review, not a diagnosis. No automatic recovery is triggered. Maintenance and missing
        samples are excluded.
      </p>
      {view.feedback && (
        <p role="status">
          Last review: {view.feedback.replaceAll("_", " ")}
          {view.feedbackAt ? ` at ${new Date(view.feedbackAt).toLocaleString()}` : ""}.
        </p>
      )}
      {admin && (
        <div className="card-actions">
          {(["useful", "expected", "false_positive"] as const).map((assessment) => (
            <button
              key={assessment}
              className="quiet"
              type="button"
              disabled={feedback.isPending}
              onClick={() => feedback.mutate(assessment)}
            >
              {assessment === "false_positive" ? "False positive" : assessment === "useful" ? "Useful" : "Expected"}
            </button>
          ))}
        </div>
      )}
      <ErrorNotice error={feedback.error} />
    </section>
  );
}
export function AnomalyExplanation({
  hostId,
  containerName = null,
  metric,
  admin,
}: {
  hostId: string;
  containerName?: string | null;
  metric?: TrendMetric;
  admin: boolean;
}) {
  const query = useQuery({
    queryKey: ["metric-anomalies", hostId, containerName],
    queryFn: () =>
      api<MetricAnomalyView[]>(
        "GET",
        `${API_ROUTES.metricAnomalies}?${new URLSearchParams({ hostId, ...(containerName === null ? {} : { containerName }) })}`,
      ),
    refetchInterval: TREND.flush,
  });
  return (
    <div className="stack">
      <ErrorNotice error={query.error} />
      {query.data
        ?.filter((view) => metric === undefined || view.metric === metric)
        .map((view) => (
          <Observation key={view.id} view={view} admin={admin} />
        ))}
    </div>
  );
}
