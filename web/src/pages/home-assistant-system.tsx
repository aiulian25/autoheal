import { useId } from "react";
import { Link } from "react-router";
import type { HomeAssistantSummaryView, HomeAssistantSystemView, HomeAssistantView } from "../../../src/shared/api.js";
import { MILLISECONDS_PER_SECOND } from "../../../src/shared/constants.js";
import { GaugeFigure, type Gauge } from "../components/charts.js";
import { TimeAgo } from "../components/common.js";
import { PATHS, TEXT } from "../constants.js";
import { bytesOf, celsius, duration, loadAverage, shortTimeAgo, wholeNumber } from "../format.js";
import { rateDial, shareDial } from "./host-stats.js";
import { FactList, LoadAverages, type Fact } from "./host-system.js";

const text = TEXT.homeAssistant.box;
const isPresent = <Value,>(value: Value | null): value is Value => value !== null;
const sizeText = (size: HomeAssistantSystemView["memory"]) =>
  size === null ? null : bytesOf(size.usedBytes, size.totalBytes);

/** What needs a look at home, as Attention counts it: Zigbee devices in trouble, safety devices, watched systems. */
export const homeAssistantProblems = (home: HomeAssistantSummaryView) =>
  home.zigbee.unavailable +
  home.zigbee.lowBattery +
  home.zigbee.weakLink +
  home.safety.problems +
  home.watched.problems;

function cpuDetail(system: HomeAssistantSystemView): string | null {
  const parts = [
    system.loadAverage === null ? null : text.load(loadAverage(system.loadAverage[0])),
    system.temperatureCelsius === null ? null : celsius(system.temperatureCelsius),
  ].filter(isPresent);
  return parts.length === 0 ? null : parts.join(TEXT.separator);
}

// Its traffic when System Monitor's network sensors are on; when they are there but off, the dial says so.
function networkGauge(system: HomeAssistantSystemView): Gauge | null {
  if (system.network !== null) {
    const { name, receiveBytesPerSecond, transmitBytesPerSecond } = system.network;
    const dial = rateDial(receiveBytesPerSecond + transmitBytesPerSecond, TEXT.metrics.inAndOut, "violet");
    return { label: TEXT.metrics.network, detail: name, mono: false, dial };
  }
  if (!system.networkOff) {
    return null;
  }
  const dial = { fraction: 0, value: TEXT.none, unit: "", tone: "violet" as const, rate: false };
  return { label: TEXT.metrics.network, detail: text.networkOff, mono: false, dial };
}

/** The box's dials, as a host's: a figure it has no sensor for is left out. */
export function homeAssistantGauges(system: HomeAssistantSystemView): Gauge[] {
  const gauges: (Gauge | null)[] = [
    system.cpuPercent === null
      ? null
      : {
          label: TEXT.metrics.cpu,
          detail: cpuDetail(system),
          mono: false,
          dial: shareDial(system.cpuPercent, TEXT.metrics.busy, "violet"),
        },
    system.memoryPercent === null
      ? null
      : {
          label: TEXT.metrics.memory,
          detail: sizeText(system.memory),
          mono: false,
          dial: shareDial(system.memoryPercent, TEXT.metrics.used, "green"),
        },
    system.diskPercent === null
      ? null
      : {
          label: TEXT.metrics.disk,
          detail: text.rootDisk,
          mono: true,
          dial: shareDial(system.diskPercent, TEXT.metrics.used, "violet"),
        },
    networkGauge(system),
  ];
  return gauges.filter(isPresent);
}

function aboutBox(system: HomeAssistantSystemView, version: string | null): string {
  return [
    system.operatingSystem === null ? null : text.operatingSystem(system.operatingSystem),
    version === null ? null : text.core(version),
    system.reportedAt === null ? null : TEXT.hosts.reported(shortTimeAgo(system.reportedAt)),
  ]
    .filter(isPresent)
    .join(TEXT.separator);
}

function ConnectionBadge({ connected }: { connected: boolean }) {
  return (
    <span className={connected ? "badge good" : "badge danger"}>
      <span className="status-dot" />
      {connected ? text.online : text.offline}
    </span>
  );
}

function Gauges({ system }: { system: HomeAssistantSystemView }) {
  const gauges = homeAssistantGauges(system);
  if (gauges.length === 0) {
    return <p className="host-card-empty muted">{text.noMonitor}</p>;
  }
  return (
    <div className="gauges">
      {gauges.map((gauge) => (
        <GaugeFigure key={gauge.label} gauge={gauge} />
      ))}
    </div>
  );
}

/** Home Assistant beside the hosts on Fleet: its box's dials, what it counts, and its page a click away. */
export function HomeAssistantFleetCard({ home }: { home: HomeAssistantSummaryView }) {
  const titleId = useId();
  const problems = homeAssistantProblems(home);
  const updates = home.system.updates.length;
  return (
    <article className="card host-card" aria-labelledby={titleId}>
      <header className="host-card-head">
        <h2 id={titleId}>{text.name}</h2>
        <ConnectionBadge connected={home.connected} />
      </header>
      <p className="host-card-about">{aboutBox(home.system, home.version)}</p>
      <Gauges system={home.system} />
      <footer className="host-card-foot">
        <span>{text.entities(wholeNumber(home.entities))}</span>
        {home.unavailableEntities > 0 && <span>{text.unavailable(wholeNumber(home.unavailableEntities))}</span>}
        {updates > 0 && <span>{TEXT.hosts.updates(updates)}</span>}
        {problems > 0 && <span className="text-danger">{TEXT.hosts.problems(problems)}</span>}
        <Link className="push" to={PATHS.homeAssistant} aria-label={text.openLabel}>
          {TEXT.hosts.open}
        </Link>
      </footer>
    </article>
  );
}

/** Where an update says what changed, after what it is; nothing when it does not say. */
export function ReleaseNotes({ link }: { link: string | null }) {
  if (link === null) {
    return null;
  }
  return (
    <>
      {TEXT.separator}
      <a href={link} target="_blank" rel="noopener noreferrer">
        {TEXT.updates.releaseNotes}
      </a>
    </>
  );
}

function UpdatesWaiting({ system }: { system: HomeAssistantSystemView }) {
  if (system.updates.length === 0) {
    return <span className="muted">{text.noUpdates}</span>;
  }
  return (
    <span className="stack">
      {system.updates.map((update) => (
        <span key={update.title}>
          {text.update(update.title, update.installed, update.latest)}
          <ReleaseNotes link={update.releaseUrl} />
        </span>
      ))}
    </span>
  );
}

function factsOf(view: HomeAssistantView, now: number): [Fact[], Fact[]] {
  const { system } = view;
  const orNone = <Value,>(value: Value | null, shown: (value: Value) => string) =>
    value === null ? TEXT.none : shown(value);
  const left = [
    { label: text.facts.core, value: view.status.version ?? TEXT.none },
    { label: text.facts.operatingSystem, value: orNone(system.operatingSystem, text.operatingSystem) },
    { label: text.facts.supervisor, value: system.supervisor ?? TEXT.none },
    { label: text.facts.updates, value: <UpdatesWaiting system={system} /> },
  ];
  const entities = `${text.entities(wholeNumber(view.entities))}${TEXT.separator}${text.unavailable(wholeNumber(view.unavailableEntities))}`;
  const right = [
    {
      label: text.facts.uptime,
      value: orNone(system.bootedAt, (bootedAt) => duration((now - bootedAt) / MILLISECONDS_PER_SECOND)),
    },
    {
      label: text.facts.load,
      value: system.loadAverage === null ? TEXT.none : <LoadAverages averages={system.loadAverage} />,
    },
    { label: text.facts.temperature, value: orNone(system.temperatureCelsius, celsius) },
    { label: text.facts.memory, value: sizeText(system.memory) ?? TEXT.none },
    { label: text.facts.disk, value: sizeText(system.disk) ?? TEXT.none },
    { label: text.facts.entities, value: entities },
    { label: text.facts.lastReport, value: <TimeAgo timestamp={system.reportedAt} /> },
  ];
  return [left, right];
}

/** Home Assistant's own box at the top of its page: the dials, its versions, what waits, how long it has run. */
export function HomeAssistantSystem({ view, now = Date.now() }: { view: HomeAssistantView; now?: number }) {
  const titleId = useId();
  const [left, right] = factsOf(view, now);
  return (
    <section className="card host-system" aria-labelledby={titleId}>
      <h2 id={titleId}>{text.title}</h2>
      <Gauges system={view.system} />
      {view.system.networkOff && <p className="muted small box-hint">{text.networkOffHint}</p>}
      <div className="system-columns">
        <FactList facts={left} />
        <FactList facts={right} />
      </div>
    </section>
  );
}
