import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { type ContainerUsageView, type ContainerView } from "../../../src/shared/api.js";
import { CONTAINER_STATE_RUNNING, PERCENT } from "../../../src/shared/constants.js";
import type { MetricTrendView } from "../../../src/shared/metric-trends.js";
import { trendQuery, trendReferences, TrendHistory } from "../components/anomaly-explanation.js";
import { TimeChart } from "../components/charts.js";
import { ContainerActions, hasParked } from "../components/container-actions.js";
import { ContainerDetailTabs, type DetailTab } from "../components/container-details.js";
import { Icon } from "../components/icons.js";
import { TEXT } from "../constants.js";
import { bytes, precisePercent, rate } from "../format.js";
import { rateDial, orMissing } from "./host-dial-values.js";

// --- one container -------------------------------------------------------------------------------

export function ContainerCharts({ points, trend }: { points: ContainerUsageView[]; trend?: MetricTrendView }) {
  const times = points.map((point) => point.at);
  const values = (measure: (point: ContainerUsageView) => number | null) => points.map(measure);
  return (
    <div className="chart-grid">
      <TimeChart
        title={TEXT.metrics.cpu}
        references={trendReferences(trend, "cpu")}
        times={times}
        ceiling={PERCENT}
        format={precisePercent}
        series={[
          { label: TEXT.metrics.cpu, tone: "blue", values: values((point) => point.cpuPercent) },
          { label: TEXT.metrics.throttling, tone: "danger", values: values((point) => point.throttledPercent) },
        ]}
      />
      <TimeChart
        title={TEXT.metrics.memory}
        references={trendReferences(trend, "memory")}
        times={times}
        ceiling={points.at(-1)?.memoryLimitBytes ?? undefined}
        format={bytes}
        series={[
          { label: TEXT.metrics.usedMemory, tone: "green", values: values((point) => point.memoryBytes) },
          { label: TEXT.metrics.cache, tone: "blue", values: values((point) => point.cacheBytes) },
        ]}
      />
      <TimeChart
        title={TEXT.metrics.network}
        times={times}
        format={rate}
        series={[
          { label: TEXT.metrics.received, tone: "blue", values: values((point) => point.receiveBytesPerSecond) },
          { label: TEXT.metrics.sent, tone: "green", values: values((point) => point.transmitBytesPerSecond) },
        ]}
      />
      <TimeChart
        title={TEXT.metrics.disk}
        references={trendReferences(trend, "io")}
        times={times}
        format={rate}
        series={[
          ...(trendReferences(trend, "io").length
            ? [
                {
                  label: "Total disk traffic",
                  tone: "violet" as const,
                  values: values((point) => point.readBytesPerSecond + point.writeBytesPerSecond),
                },
              ]
            : []),
          { label: TEXT.metrics.read, tone: "amber", values: values((point) => point.readBytesPerSecond) },
          { label: TEXT.metrics.write, tone: "blue", values: values((point) => point.writeBytesPerSecond) },
        ]}
      />
    </div>
  );
}

/** One container's actions, dials and last half hour, opened under its row in a container list. */
const MINI_RING = { size: 24, center: 12, radius: 10, turn: 62.83 } as const;

// The smallest a gauge can be and still say what it says: a ring, its figure and what that is, on one line.
function MiniGauge({
  share,
  tone,
  figure,
  label,
}: {
  share: number | null;
  tone?: string;
  figure: string;
  label: string;
}) {
  return (
    <div className="mini-gauge">
      {share !== null && (
        <svg
          className={`mini-ring tone-${tone}`}
          viewBox={`0 0 ${MINI_RING.size} ${MINI_RING.size}`}
          aria-hidden="true"
        >
          <circle className="mini-ring-track" cx={MINI_RING.center} cy={MINI_RING.center} r={MINI_RING.radius} />
          <circle
            className="mini-ring-arc"
            cx={MINI_RING.center}
            cy={MINI_RING.center}
            r={MINI_RING.radius}
            strokeDasharray={`${Math.min(share, 1) * MINI_RING.turn} ${MINI_RING.turn}`}
          />
        </svg>
      )}
      <strong>{figure}</strong>
      <span className="muted" title={label}>
        {label}
      </span>
    </div>
  );
}

function MiniGauges({ usage }: { usage: ContainerUsageView }) {
  const metrics = TEXT.metrics;
  const memoryLabel =
    usage.memoryLimitBytes === null ? metrics.memoryNoLimit : metrics.memoryOfLimit(bytes(usage.memoryLimitBytes));
  const cpuLabel = usage.cpuLimitCores === null ? metrics.cpuNoLimit : metrics.cpuOfLimit(String(usage.cpuLimitCores));
  const diskRate = usage.readBytesPerSecond + usage.writeBytesPerSecond;
  const networkRate = (usage.receiveBytesPerSecond ?? 0) + (usage.transmitBytesPerSecond ?? 0);
  return (
    <div className="mini-gauges">
      <MiniGauge
        share={usage.cpuPercent / PERCENT}
        tone="violet"
        figure={precisePercent(usage.cpuPercent)}
        label={cpuLabel}
      />
      <MiniGauge
        share={usage.memoryPercent / PERCENT}
        tone="green"
        figure={bytes(usage.memoryBytes)}
        label={memoryLabel}
      />
      <MiniGauge
        share={rateDial(diskRate, metrics.readAndWrite, "violet").fraction}
        tone="violet"
        figure={rate(diskRate)}
        label={metrics.diskShort}
      />
      <MiniGauge
        share={rateDial(networkRate, metrics.inAndOut, "violet").fraction}
        tone="violet"
        figure={rate(networkRate)}
        label={metrics.networkShort}
      />
      <MiniGauge share={null} figure={orMissing(usage.processes, String)} label={metrics.processCount} />
    </div>
  );
}

// A tab to open from outside, say the logs button on its row; the count tells a second press from the first.
export interface InspectorTabRequest {
  tab: DetailTab;
  count: number;
}

export function ContainerInspector({
  container,
  siblings,
  canAct,
  arrived,
  tools,
  tabRequest,
}: {
  container: ContainerView;
  // The other containers on its host: one of them may be its old self, kept aside by an update.
  siblings: readonly ContainerView[];
  canAct: boolean;
  // Opened by a link, from an incident say: brought into view, which a click on its row never needs.
  arrived: boolean;
  // Besides what it can be asked, what its row opens: its shell and settings, where this page has them.
  tools?: (files: ReactNode) => ReactNode;
  tabRequest?: InspectorTabRequest | null;
}) {
  const section = useRef<HTMLElement>(null);
  const [tab, setTab] = useState<DetailTab>(tabRequest?.tab ?? "overview");
  useEffect(() => {
    if (tabRequest != null) setTab(tabRequest.tab);
  }, [tabRequest]);
  useEffect(() => {
    if (arrived) {
      section.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [arrived]);
  const trend = useQuery(trendQuery(container.hostId, container.name));
  const filesButton = (
    <button type="button" onClick={() => setTab("files")}>
      <Icon name="folder" />
      {TEXT.containerDetails.files}
    </button>
  );
  const running = container.state === CONTAINER_STATE_RUNNING;
  const idle = running ? TEXT.metrics.waitingForContainer : TEXT.metrics.notRunning;
  return (
    <section ref={section} className="stack container-panel" aria-label={container.name}>
      <ContainerActions
        container={container}
        parked={hasParked(container, siblings)}
        canAct={canAct}
        tools={tools === undefined ? filesButton : tools(filesButton)}
      />
      {container.usage === null ? <p className="muted small">{idle}</p> : <MiniGauges usage={container.usage} />}
      <ContainerDetailTabs
        container={container}
        tab={tab}
        onTab={setTab}
        trend={<TrendHistory trend={trend.data} error={trend.error} />}
      />
    </section>
  );
}
