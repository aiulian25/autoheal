import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath } from "../../../src/shared/api.js";
import { TREND, type MetricTrendView, type MetricAnomalyView } from "../../../src/shared/metric-trends.js";
import { AnomalyExplanation, TrendHistory, trendChartData, trendReferences } from "./anomaly-explanation.js";
import { TimeChart } from "./charts.js";
let client: QueryClient | undefined;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
});
const now = Date.UTC(2026, 9, 27);
const trend: MetricTrendView = {
  hostId: "lab",
  containerName: null,
  interval: TREND.interval,
  retention: TREND.retention,
  status: "ready",
  lastSampleAt: now,
  identity: "current",
  points: [],
  baselines: [
    {
      metric: "cpu",
      median: 10,
      mad: 1,
      threshold: 25,
      observed: 60,
      baselineBuckets: 24,
      baselineSamples: 1440,
      recentSamples: 180,
      since: now - 27 * TREND.interval,
      observedAt: now,
      elevated: true,
      pattern: "elevated",
    },
  ],
  anomalies: [],
  health: { capacityLimited: false, unavailable: false, retainedRows: 27, retainedSeries: 1 },
  explanation: "Learning from observed samples; no recovery action.",
};
const view: MetricAnomalyView = {
  id: "review",
  hostId: "lab",
  hostLabel: "Lab",
  containerName: null,
  metric: "cpu",
  identity: "current",
  state: "active",
  observedAt: now,
  baseline: 10,
  mad: 1,
  threshold: 25,
  observed: 60,
  baselineBuckets: 24,
  baselineSamples: 1440,
  recentSamples: 180,
  pattern: "elevated",
  feedback: null,
  feedbackAt: null,
  taskKey: "anomaly|series|cpu|current",
};
it("draws labeled typical/threshold overlays without inventing an out-of-scale percentage", () => {
  render(
    <TimeChart
      title="CPU"
      times={[now - 1, now]}
      series={[{ label: "busy", tone: "blue", values: [10, 60] }]}
      format={String}
      ceiling={100}
      references={[...trendReferences(trend, "cpu"), { label: "Out of range", value: 130 }]}
    />,
  );
  expect(screen.getAllByText(/Learned typical/)[0]).toBeTruthy();
  expect(screen.getAllByText(/Observation threshold/)[0]).toBeTruthy();
  expect(screen.queryByText("Out of range")).toBeNull();
  expect(document.querySelectorAll("line[stroke-dasharray]")).toHaveLength(2);
});
it("shows gaps for missing, maintenance, older incarnations and sparse buckets", () => {
  const base = {
    identity: "current",
    excluded: false,
    cpu: 10,
    memory: 100,
    io: 100,
    cpuSamples: 60,
    memorySamples: 60,
    ioSamples: 60,
  };
  const data = trendChartData(
    {
      ...trend,
      points: [
        { ...base, at: 0 },
        { ...base, at: 2 * TREND.interval, excluded: true },
        { ...base, at: 3 * TREND.interval, identity: "old" },
        { ...base, at: 4 * TREND.interval, cpuSamples: 2 },
        { ...base, at: 5 * TREND.interval },
      ],
    },
    "cpu",
  );
  expect(data.values).toEqual([10, null, null, null, null, 10]);
  render(
    <TrendHistory
      trend={{ ...trend, status: "capacity", health: { ...trend.health, capacityLimited: true } }}
      error={null}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain("fleet limit");
});
it("shows sample evidence and auditable feedback without offering an automatic action", async () => {
  let assessment: string | null = null;
  const fetch = vi.fn(async (path: string, options: RequestInit) => {
    if (path.startsWith(`${API_ROUTES.metricAnomalies}?`))
      return new Response(JSON.stringify([{ ...view, feedback: assessment, feedbackAt: assessment ? now : null }]), {
        status: 200,
      });
    if (path === apiPath(API_ROUTES.metricAnomalyFeedback, { anomalyId: view.id })) {
      assessment = JSON.parse(options.body as string).assessment;
      return new Response(JSON.stringify({ assessment, recordedAt: now }), { status: 200 });
    }
    throw Error(path);
  });
  vi.stubGlobal("fetch", fetch);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AnomalyExplanation hostId="lab" admin />
    </QueryClientProvider>,
  );
  expect(await screen.findByText(/1440 samples/)).toBeTruthy();
  expect(screen.getByText(/No automatic recovery/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "False positive" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("false positive"));
  const posts = fetch.mock.calls.filter(([, options]) => options.method === "POST");
  expect(posts).toHaveLength(1);
  expect(JSON.parse(posts[0]![1].body as string)).toEqual({ assessment: "false_positive", observedAt: now });
});
it("keeps observational evidence readable to viewers without feedback controls", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify([view]), { status: 200 })),
  );
  client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <AnomalyExplanation hostId="lab" admin={false} />
    </QueryClientProvider>,
  );
  await screen.findByText(/1440 samples/);
  expect(screen.queryByRole("button")).toBeNull();
});
