import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import {
  API_ROUTES,
  apiPath,
  type HostHealthView,
  type HostMetricsView,
  type HostView,
} from "../../../src/shared/api.js";
import { DETECTOR_THRESHOLDS, PERCENT, POWER_PHASE, RUNNER_GPU_COMMAND } from "../../../src/shared/constants.js";
import type { MetricTrendView } from "../../../src/shared/metric-trends.js";
import { trendQuery, trendReferences, TrendHistory } from "../components/anomaly-explanation.js";
import { api } from "../api-client.js";
import { powerAway } from "./host-power.js";
import { Dial, TimeChart, type ChartSeries, type DialProps, type Tone } from "../components/charts.js";
import { CopyButton, ErrorNotice, Loading } from "../components/common.js";
import { DISK_FULL_DANGER_PERCENT, INVENTORY_REFRESH_MILLISECONDS, TEXT, POWER_TEXT } from "../constants.js";
import {
  bytes,
  celsius,
  gigahertz,
  linkSpeed,
  loadAverage,
  percentOf,
  precisePercent,
  rate,
  watts,
} from "../format.js";
import {
  shareDial,
  orMissing,
  type HostMemory,
  type FileSystem,
  type HostDisk,
  diskUsedPercent,
  rateDial,
  type HostNetwork,
  networkCeiling,
  fullestDisk,
} from "./host-dial-values.js";

type Gpu = HostMetricsView["gpus"][number];
const GPU_CHART_TONES = ["violet", "blue", "green", "amber"] as const;

interface Fact {
  label: string;
  value: string;
  // A mount path reads better in the code font; a disk filling up is coloured as its dial would be.
  mono?: boolean;
  tone?: Tone;
  // The first of another kind of fact, with a line above it: what the drives do, after how full they are.
  startsGroup?: boolean;
}

interface StatCardProps {
  title: string;
  tag: string | null;
  tagMono?: boolean;
  dial: Omit<DialProps, "label">;
  facts: Fact[];
  // Something on it is about to go wrong: the card's edge says so too.
  alert?: boolean;
}

const factClass = (fact: Fact, mono: boolean) =>
  [mono && "mono", fact.tone !== undefined && `tone-${fact.tone}`, fact.startsGroup === true && "group-start"]
    .filter(Boolean)
    .join(" ") || undefined;

function StatCard({ title, tag, tagMono = false, dial, facts, alert = false }: StatCardProps) {
  return (
    <section className={alert ? "card stat-card alert" : "card stat-card"}>
      <header className="stat-card-header">
        <h3>{title}</h3>
        {tag !== null && (
          <span className={tagMono ? "chip mono" : "chip"} title={tag}>
            {tag}
          </span>
        )}
      </header>
      <Dial label={title} {...dial} />
      {facts.length > 0 && (
        <dl className="stat-facts">
          {facts.map((fact) => (
            <Fragment key={fact.label}>
              <dt className={factClass(fact, fact.mono === true)} title={fact.label}>
                {fact.label}
              </dt>
              <dd className={factClass(fact, false)}>{fact.value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </section>
  );
}

function StatCards({ cards }: { cards: StatCardProps[] }) {
  return (
    <div className="stat-grid">
      {cards.map((card, index) => (
        <StatCard key={`${card.title}-${index}`} {...card} />
      ))}
    </div>
  );
}

// --- one host ------------------------------------------------------------------------------------

// "310 / 885 GB" where both share a unit: the cards are narrow.
function shortPartOf(part: string, whole: string) {
  const [partNumber, partUnit] = part.split(" ");
  const sameUnit = partUnit === whole.split(" ")[1];
  return TEXT.metrics.shortPartOf(sameUnit ? (partNumber ?? part) : part, whole);
}

function cpuCard(cpu: HostMetricsView["cpu"], health: HostHealthView | null): StatCardProps {
  return {
    title: TEXT.metrics.cpu,
    tag: health === null ? null : TEXT.metrics.threads(health.cpuCount),
    dial: shareDial(cpu.busyPercent, TEXT.metrics.busy, "violet"),
    facts: [
      { label: TEXT.metrics.clock, value: orMissing(cpu.frequencyMegahertz, gigahertz) },
      { label: TEXT.metrics.temperatureShort, value: orMissing(cpu.temperatureCelsius, celsius) },
      { label: TEXT.metrics.ioWait, value: precisePercent(cpu.ioWaitPercent) },
      { label: TEXT.metrics.load, value: orMissing(health?.loadAverage[0] ?? null, loadAverage) },
    ],
  };
}

function gpuCard(gpu: Gpu): StatCardProps {
  return {
    title: TEXT.metrics.gpu,
    tag: gpu.name,
    dial: shareDial(gpu.utilizationPercent, gpu.clockShare ? TEXT.metrics.ofTopClock : TEXT.metrics.busy, "violet"),
    facts: [
      // Not every driver says how much of its memory a card uses.
      ...(gpu.memoryTotalBytes > 0
        ? [
            {
              label: TEXT.metrics.videoMemory,
              value: TEXT.metrics.partOf(bytes(gpu.memoryUsedBytes), bytes(gpu.memoryTotalBytes)),
            },
          ]
        : []),
      { label: TEXT.metrics.power, value: orMissing(gpu.powerWatts, watts) },
      { label: TEXT.metrics.temperatureShort, value: orMissing(gpu.temperatureCelsius, celsius) },
    ],
  };
}

function memoryCard(memory: HostMemory): StatCardProps {
  const swap =
    memory.swapTotalBytes === 0 ? TEXT.none : shortPartOf(bytes(memory.swapUsedBytes), bytes(memory.swapTotalBytes));
  return {
    title: TEXT.metrics.memory,
    tag: bytes(memory.totalBytes),
    dial: shareDial(percentOf(memory.usedBytes, memory.totalBytes), TEXT.metrics.used, "green"),
    facts: [
      { label: TEXT.metrics.usedMemory, value: bytes(memory.usedBytes) },
      { label: TEXT.metrics.cache, value: bytes(memory.cacheBytes) },
      { label: TEXT.metrics.swap, value: swap },
    ],
  };
}

// Almost full is amber, as the tasks count it; red once the disk is about to stop taking writes.
function diskTone(percent: number): Tone | undefined {
  if (percent >= DISK_FULL_DANGER_PERCENT) {
    return "danger";
  }
  return percent >= DETECTOR_THRESHOLDS.diskPercent ? "warning" : undefined;
}

// How full the disks are, the fullest on the dial, with what the drives read and write beside it.
function disksCard(disks: readonly FileSystem[], fullest: FileSystem, io: HostDisk | null): StatCardProps {
  const throughput =
    io === null
      ? []
      : [
          { label: TEXT.metrics.read, value: rate(io.readBytesPerSecond), startsGroup: true },
          { label: TEXT.metrics.write, value: rate(io.writeBytesPerSecond) },
        ];
  return {
    title: TEXT.metrics.disks,
    tag: fullest.path,
    tagMono: true,
    dial: shareDial(diskUsedPercent(fullest), TEXT.metrics.used, "violet"),
    facts: [
      ...disks.map((disk) => ({
        label: disk.path,
        value: shortPartOf(bytes(disk.usedBytes), bytes(disk.usedBytes + disk.availableBytes)),
        mono: true,
        tone: diskTone(diskUsedPercent(disk)),
      })),
      ...throughput,
    ],
    alert: diskUsedPercent(fullest) >= DISK_FULL_DANGER_PERCENT,
  };
}

function diskCard(disk: HostDisk): StatCardProps {
  return {
    title: TEXT.metrics.disk,
    tag: disk.devices.join(", ") || null,
    dial: rateDial(disk.readBytesPerSecond + disk.writeBytesPerSecond, TEXT.metrics.readAndWrite, "violet"),
    facts: [
      { label: TEXT.metrics.read, value: rate(disk.readBytesPerSecond) },
      { label: TEXT.metrics.write, value: rate(disk.writeBytesPerSecond) },
    ],
  };
}

function networkCard(network: HostNetwork): StatCardProps {
  const cards = network.interfaces.map((card) =>
    card.speedMegabitsPerSecond === null
      ? card.name
      : `${card.name}${TEXT.separator}${linkSpeed(card.speedMegabitsPerSecond)}`,
  );
  return {
    title: TEXT.metrics.network,
    tag: cards.join(", ") || null,
    dial: rateDial(
      network.receiveBytesPerSecond + network.transmitBytesPerSecond,
      TEXT.metrics.inAndOut,
      "violet",
      networkCeiling(network),
    ),
    facts: [
      { label: TEXT.metrics.received, value: rate(network.receiveBytesPerSecond) },
      { label: TEXT.metrics.sent, value: rate(network.transmitBytesPerSecond) },
      { label: TEXT.metrics.dropped, value: String(network.droppedPackets) },
    ],
  };
}

// Usage when the host's filesystem is mounted; otherwise only what the drives read and write.
function diskCards(metrics: HostMetricsView, health: HostHealthView | null): StatCardProps[] {
  const fullest = fullestDisk(health);
  if (health !== null && fullest !== undefined) {
    return [disksCard(health.disks, fullest, metrics.disk)];
  }
  return metrics.disk === null ? [] : [diskCard(metrics.disk)];
}

function hostCards(metrics: HostMetricsView, health: HostHealthView | null): StatCardProps[] {
  const network = metrics.network === null ? [] : [networkCard(metrics.network)];
  return [
    cpuCard(metrics.cpu, health),
    ...metrics.gpus.map(gpuCard),
    memoryCard(metrics.memory),
    ...diskCards(metrics, health),
    ...network,
  ];
}

function HostCharts({ points, trend }: { points: HostMetricsView[]; trend?: MetricTrendView }) {
  const times = points.map((point) => point.at);
  const values = (measure: (point: HostMetricsView) => number | null) => points.map(measure);
  const latestGpus = points.at(-1)?.gpus ?? [];
  const gpu: ChartSeries[] = latestGpus.map((card, index) => ({
    label: latestGpus.length > 1 ? card.name : TEXT.metrics.utilization,
    tone: GPU_CHART_TONES[index % GPU_CHART_TONES.length]!,
    values: values((point) => point.gpus[index]?.utilizationPercent ?? null),
  }));
  return (
    <div className="chart-grid">
      <TimeChart
        title={TEXT.metrics.cpu}
        references={trendReferences(trend, "cpu")}
        times={times}
        ceiling={PERCENT}
        format={precisePercent}
        series={[
          ...(trendReferences(trend, "cpu").length
            ? [{ label: "Total busy", tone: "green" as const, values: values((point) => point.cpu.busyPercent) }]
            : []),
          { label: TEXT.metrics.user, tone: "blue", values: values((point) => point.cpu.userPercent) },
          { label: TEXT.metrics.system, tone: "violet", values: values((point) => point.cpu.systemPercent) },
          { label: TEXT.metrics.ioWait, tone: "amber", values: values((point) => point.cpu.ioWaitPercent) },
        ]}
      />
      <TimeChart
        title={TEXT.metrics.memory}
        references={trendReferences(trend, "memory")}
        times={times}
        ceiling={points.at(-1)?.memory.totalBytes}
        format={bytes}
        series={[
          { label: TEXT.metrics.usedMemory, tone: "green", values: values((point) => point.memory.usedBytes) },
          { label: TEXT.metrics.cache, tone: "blue", values: values((point) => point.memory.cacheBytes) },
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
                  values: values((point) =>
                    point.disk === null ? null : point.disk.readBytesPerSecond + point.disk.writeBytesPerSecond,
                  ),
                },
              ]
            : []),
          {
            label: TEXT.metrics.read,
            tone: "amber",
            values: values((point) => point.disk?.readBytesPerSecond ?? null),
          },
          {
            label: TEXT.metrics.write,
            tone: "blue",
            values: values((point) => point.disk?.writeBytesPerSecond ?? null),
          },
        ]}
      />
      <TimeChart
        title={TEXT.metrics.network}
        times={times}
        format={rate}
        series={[
          {
            label: TEXT.metrics.received,
            tone: "blue",
            values: values((point) => point.network?.receiveBytesPerSecond ?? null),
          },
          {
            label: TEXT.metrics.sent,
            tone: "green",
            values: values((point) => point.network?.transmitBytesPerSecond ?? null),
          },
        ]}
      />
      {gpu.length > 0 && (
        <TimeChart title={TEXT.metrics.gpu} times={times} ceiling={PERCENT} format={precisePercent} series={gpu} />
      )}
    </div>
  );
}

/** A host's dials (CPU, GPUs, memory, disks, network) and its last half hour as charts: the host in one place. */
/** An NVIDIA card the host's runner was not given: one paste where its compose file is gives it, for reading only. */
function GpuNotGiven() {
  return (
    <details className="small muted">
      <summary>{TEXT.metrics.gpuNotGiven}</summary>
      <p>{TEXT.metrics.gpuGive}</p>
      <pre className="log">{RUNNER_GPU_COMMAND}</pre>
      <CopyButton text={RUNNER_GPU_COMMAND} />
    </details>
  );
}

/** The host's dials: what it uses right now. */
export function HostDials({ host }: { host: HostView }) {
  const away = powerAway(host.power);
  return (
    <section className={away ? "section stack power-away" : "section stack"}>
      {away && (
        <p className="power-away-note">
          <span className="power-away-pulse" aria-hidden />
          {host.power?.phase === POWER_PHASE.off
            ? POWER_TEXT.away.off(host.label)
            : POWER_TEXT.away.offline(host.label)}
        </p>
      )}
      {host.metrics === null ? (
        <p className="muted">{TEXT.metrics.waiting}</p>
      ) : (
        <StatCards cards={hostCards(host.metrics, host.health)} />
      )}
      {host.health !== null && host.health.disks.length === 0 && (
        <p className="muted small">{TEXT.hosts.hostRootHint}</p>
      )}
      {host.health?.gpuNotGiven === true && <GpuNotGiven />}
    </section>
  );
}

/** The host's last half hour, in charts. */
/** The last half hour as charts, under the dials, folded away: read only while it is open. */
export function HostHistory({ host }: { host: HostView }) {
  const [open, setOpen] = useState(false);
  const trend = useQuery({ ...trendQuery(host.id, null), enabled: open });
  const history = useQuery({
    queryKey: ["host-metrics", host.id],
    queryFn: () => api<HostMetricsView[]>("GET", apiPath(API_ROUTES.hostMetrics, { hostId: host.id })),
    refetchInterval: INVENTORY_REFRESH_MILLISECONDS,
    enabled: open,
  });
  const points = history.data ?? [];
  const nothingYet = history.isSuccess && points.length === 0;
  const olderThanAsked = history.isError && points.length > 0;
  return (
    <details className="fold stats-history" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <h2>{TEXT.metrics.statsHistory}</h2>
      </summary>
      {open && (
        <div className="stack">
          <p className="small muted">{TEXT.metrics.history}</p>
          {history.isPending && <Loading />}
          {points.length > 0 && <HostCharts points={points} trend={trend.data} />}
          {nothingYet && (
            <p className="small muted" role="status">
              {TEXT.metrics.noReadings}
            </p>
          )}
          <ErrorNotice error={history.error} />
          {olderThanAsked && (
            <p className="small muted" role="status">
              {TEXT.metrics.oldReadings}
            </p>
          )}
          {history.isError && (
            <div className="card-actions">
              <button type="button" onClick={() => history.refetch()} disabled={history.isFetching}>
                {TEXT.metrics.readAgain}
              </button>
            </div>
          )}
          <TrendHistory trend={trend.data} error={trend.error} />
        </div>
      )}
    </details>
  );
}
