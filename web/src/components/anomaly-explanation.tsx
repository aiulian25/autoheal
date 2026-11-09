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
import { wordsOf } from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { FULL_PERCENT, TEXT } from "../constants.js";
import { bytes, precisePercent, rate } from "../format.js";
import { TimeChart, type ChartReference } from "./charts.js";
import { ErrorNotice } from "./common.js";
const text = TEXT.trends;
const metricName = text.metrics;
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
      throw new Error(text.responseUnavailable);
    return view;
  },
  refetchInterval: TREND.flush,
  staleTime: TREND.flush,
});
export const trendReferences = (trend: MetricTrendView | undefined, metric: TrendMetric): ChartReference[] => {
  const baseline = trend?.status === "ready" ? trend.baselines.find((item) => item.metric === metric) : undefined;
  return baseline
    ? [
        { label: text.typical, value: baseline.median, from: baseline.since, tone: "violet" },
        { label: text.threshold, value: baseline.threshold, from: baseline.since, tone: "amber" },
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
        {text.unavailable}
      </p>
    );
  if (!trend) return null;
  return (
    <section className="stack" aria-label={text.label}>
      <p className="small muted">
        {trend.explanation} {text.status(trend.status)}
      </p>
      {trend.health.capacityLimited && (
        <p role="status" className="small muted">
          {text.capacityLimited}
        </p>
      )}
      <details>
        <summary>{text.history}</summary>
        <p className="small muted">{text.gaps}</p>
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
                {...(metric === "cpu" ? { ceiling: FULL_PERCENT } : {})}
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
    <section className="stack small" aria-label={text.observationLabel(metricName[view.metric])}>
      <p>
        {text.observed(format(view.observed), format(view.baseline), format(view.threshold))}{" "}
        {text.samples(view.baselineBuckets, view.baselineSamples, view.recentSamples)} {text.comparedAt}{" "}
        <time dateTime={new Date(view.observedAt).toISOString()}>{new Date(view.observedAt).toLocaleString()}</time>
        {TEXT.sentenceEnd} {text.state(view.state)}
      </p>
      <p className="muted">{text.notADiagnosis}</p>
      {view.feedback && (
        <p role="status">
          {text.lastReview(wordsOf(view.feedback))}
          {view.feedbackAt ? text.reviewedAt(new Date(view.feedbackAt).toLocaleString()) : ""}
          {TEXT.sentenceEnd}
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
              {text.assessments[assessment]}
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
