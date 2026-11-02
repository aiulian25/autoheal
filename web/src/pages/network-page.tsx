import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { API_ROUTES, apiPath } from "../../../src/shared/api.js";
import { sizeText } from "../../../src/shared/constants.js";
import {
  CHECK_RESULT,
  INTERNET_STATE_WORDS,
  SPEED_SOURCE,
  type InternetState,
  type NetworkDeviceDetailView,
  type NetworkDeviceView,
  type NetworkFirewallView,
  type NetworkInternetView,
  type NetworkMapView,
  type NetworkOverviewView,
  type NetworkReportView,
  type SpeedTestView,
} from "../../../src/shared/network.js";
import { api } from "../api-client.js";
import { ErrorNotice, Loading, PageHeader, TimeAgo } from "../components/common.js";
import { PATHS, SETTINGS_SECTIONS, TEXT } from "../constants.js";
import { networkOverviewQuery } from "../queries.js";
import { NetworkMap } from "./network-map.js";

const text = TEXT.network;
const TABS = ["overview", "devices", "map", "internet", "firewall", "reports"] as const;
type Tab = (typeof TABS)[number];
const PERIODS = ["day", "week", "month"] as const;
const REFRESH_MILLISECONDS = 30_000;
const ASKING_REFRESH_MILLISECONDS = 3_000;
const INTERNET_QUERY_KEY = ["network-internet"];
const PERCENT = 100;
const MINIMUM_BAR_PERCENT = 1;
const FULL_SCALE_ROOM = 1.15;

function Stat({
  title,
  value,
  line,
  tone,
  onOpen,
}: {
  title: string;
  value: string;
  line: string;
  tone: "good" | "warning" | "";
  onOpen: () => void;
}) {
  return (
    <button type="button" className={`network-stat ${tone}`} onClick={onOpen}>
      <span className="small muted">{title}</span>
      <strong>{value}</strong>
      <span className="small muted">{line}</span>
    </button>
  );
}

const toneOf = (bad: boolean) => (bad ? "warning" : "good");

function Overview({ view, onOpen }: { view: NetworkOverviewView; onOpen: (tab: Tab) => void }) {
  const { internet, contract } = view;
  const largest = Math.max(1, ...view.top.map(({ bytes }) => bytes));
  return (
    <div className="stack">
      {view.problem !== null && (
        <p className="notice warning" role="alert">
          {text.cannotRead(view.problem)}{" "}
          <Link to={`${PATHS.settings}#${SETTINGS_SECTIONS.connections}`}>{text.checkConnection}</Link>
        </p>
      )}
      {view.learning && <p className="small muted">{text.learning}</p>}
      <div className="network-stats">
        <Stat
          title={text.stats.internet}
          value={internet.upPercent === null ? text.unknown : `${internet.upPercent.toFixed(2)}%`}
          line={text.stats.internetLine(internet.outages, internet.downMinutes)}
          tone={internet.outages > 0 ? "warning" : "good"}
          onOpen={() => onOpen("internet")}
        />
        <Stat
          title={text.stats.contract}
          value={contract.contract === null ? text.notSet : text.stats.contractValue(contract.downMet, contract.fair)}
          line={contract.contract === null ? text.stats.contractUnset : text.stats.contractLine(contract.contract)}
          tone={contract.contract !== null && contract.downMet === contract.fair ? "good" : "warning"}
          onOpen={() => onOpen("internet")}
        />
        <Stat
          title={text.stats.newDevices}
          value={String(view.newDevices)}
          line={text.stats.newLine}
          tone={toneOf(view.newDevices > 0)}
          onOpen={() => onOpen("devices")}
        />
        <Stat
          title={text.stats.dropping}
          value={String(view.oftenDropping.length)}
          line={view.oftenDropping.slice(0, 2).join(", ") || text.stats.noneDropping}
          tone={toneOf(view.oftenDropping.length > 0)}
          onOpen={() => onOpen("devices")}
        />
        <Stat
          title={text.stats.firewall}
          value={view.exposureWaiting ? text.stats.firewallChanged : text.stats.firewallSame}
          line={text.stats.firewallLine}
          tone={toneOf(view.exposureWaiting)}
          onOpen={() => onOpen("firewall")}
        />
        <Stat
          title={text.stats.updates}
          value={String(view.updates.length)}
          line={view.updates.join(", ") || text.stats.noUpdates}
          tone={toneOf(view.updates.length > 0)}
          onOpen={() => onOpen("devices")}
        />
      </div>
      <section className="card">
        <h3>{text.usingMost}</h3>
        {view.top.length === 0 && <p className="muted">{text.nothingYet}</p>}
        {view.top.map(({ name, bytes, unusual }) => (
          <div key={name} className="network-bar-row">
            <strong>{name}</strong>
            <span className="network-bar">
              <i
                className={unusual ? "warning" : undefined}
                style={{ width: `${Math.max(MINIMUM_BAR_PERCENT, (bytes / largest) * PERCENT)}%` }}
              />
            </span>
            <span>{sizeText(bytes)}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

function DeviceDetail({ mac, onClose }: { mac: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const key = ["network-device", mac];
  const detail = useQuery({
    queryKey: key,
    queryFn: () => api<NetworkDeviceDetailView>("GET", apiPath(API_ROUTES.networkDevice, { mac })),
    refetchInterval: (query) =>
      query.state.data?.run.status === "running" ? ASKING_REFRESH_MILLISECONDS : REFRESH_MILLISECONDS,
  });
  const refresh = () => void queryClient.invalidateQueries();
  const change = useMutation({
    mutationFn: (body: object) => api("PUT", apiPath(API_ROUTES.networkDevice, { mac }), body),
    onSuccess: refresh,
  });
  const ask = useMutation({
    mutationFn: () => api("POST", API_ROUTES.networkAsk, { mac }),
    onSuccess: refresh,
  });
  const view = detail.data;
  if (view === undefined) return detail.error ? <ErrorNotice error={detail.error} /> : <Loading />;
  const { device, run } = view;
  const askAboutName = () => {
    const name = window.prompt(text.device.namePrompt, device.name);
    if (name !== null) change.mutate({ givenName: name });
  };
  return (
    <section className="network-detail" aria-label={device.name}>
      <header className="row spread">
        <strong>{device.name}</strong>
        <button type="button" className="quiet" onClick={onClose}>
          {text.close}
        </button>
      </header>
      <p className="small muted">{text.device.facts(device)}</p>
      <p className="small">{text.device.dropped(view.dropTimes.length)}</p>
      {view.dropTimes.length > 0 && (
        <p className="small muted">
          {view.dropTimes
            .slice(-5)
            .map((at) => new Date(at).toLocaleString())
            .join(TEXT.separator)}
        </p>
      )}
      {view.talks.length > 0 && (
        <ul className="small">
          {view.talks.slice(0, 8).map(({ other, port, lines, blocked }) => (
            <li key={`${other}:${port}:${blocked}`}>{text.device.talk(other, port, lines, blocked)}</li>
          ))}
        </ul>
      )}
      {run.status === "running" && <p className="small muted">{text.thinking}</p>}
      {run.status === "failed" && <p className="notice warning small">{text.askFailed(run.error)}</p>}
      {run.status === "done" && (
        <div className="network-answer">
          <span className="small muted">{text.answeredBy(run.server)}</span>
          <p>{run.text}</p>
        </div>
      )}
      <div className="row">
        <button type="button" disabled={run.status === "running"} onClick={() => ask.mutate()}>
          {run.status === "idle" ? text.device.ask : text.device.askAgain}
        </button>
        {!device.known && (
          <button type="button" className="primary" onClick={() => change.mutate({ known: true })}>
            {text.device.known}
          </button>
        )}
        <button type="button" onClick={askAboutName}>
          {text.device.name}
        </button>
        <button type="button" onClick={() => change.mutate({ muted: !device.muted })}>
          {device.muted ? text.device.unmute : text.device.mute}
        </button>
      </div>
      {!device.known && <p className="small muted">{text.device.notMine}</p>}
      <ErrorNotice error={change.error ?? ask.error} />
    </section>
  );
}

const DEVICE_FILTERS = {
  all: () => true,
  new: (device: NetworkDeviceView) => !device.known,
  dropping: (device: NetworkDeviceView) => device.oftenDrops,
  unusual: (device: NetworkDeviceView) => device.unusual,
  offline: (device: NetworkDeviceView) => !device.online,
};
type DeviceFilter = keyof typeof DEVICE_FILTERS;
const DEVICE_FILTER_NAMES = Object.keys(DEVICE_FILTERS) as DeviceFilter[];

function DeviceTags({ device }: { device: NetworkDeviceView }) {
  return (
    <>
      {!device.known && <span className="badge good">{text.device.tagNew}</span>}
      {device.unusual && <span className="badge warning">{text.device.tagUnusual}</span>}
      {device.oftenDrops && <span className="badge warning">{text.device.tagDrops}</span>}
      {device.privateAddress && <span className="badge neutral">{text.device.tagPrivate}</span>}
      {device.muted && <span className="badge neutral">{text.device.tagMuted}</span>}
    </>
  );
}

function Devices() {
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>("day");
  const [filter, setFilter] = useState<DeviceFilter>("all");
  const [opened, setOpened] = useState<string | null>(null);
  const devices = useQuery({
    queryKey: ["network-devices", period],
    queryFn: () => api<NetworkDeviceView[]>("GET", `${API_ROUTES.networkDevices}?period=${period}`),
    refetchInterval: REFRESH_MILLISECONDS,
  });
  const list = devices.data ?? [];
  const shown = list.filter(DEVICE_FILTERS[filter]);
  const largest = Math.max(1, ...list.map(({ periodBytes }) => periodBytes));
  return (
    <div className="stack">
      <div className="row spread">
        <div className="show-chips" role="group" aria-label={text.device.filterLabel}>
          {DEVICE_FILTER_NAMES.map((name) => (
            <button
              key={name}
              type="button"
              className={name === filter ? "chip-button active" : "chip-button"}
              aria-pressed={name === filter}
              onClick={() => setFilter(name)}
            >
              {text.device.filters[name]} <span className="tab-count">{list.filter(DEVICE_FILTERS[name]).length}</span>
            </button>
          ))}
        </div>
        <div className="show-chips" role="group" aria-label={text.device.periodLabel}>
          {PERIODS.map((name) => (
            <button
              key={name}
              type="button"
              className={name === period ? "chip-button active" : "chip-button"}
              aria-pressed={name === period}
              onClick={() => setPeriod(name)}
            >
              {text.device.periods[name]}
            </button>
          ))}
        </div>
      </div>
      {devices.data === undefined && !devices.error && <Loading />}
      <ErrorNotice error={devices.error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{text.device.columns.device}</th>
              <th>{text.device.columns.network}</th>
              <th>{text.device.columns.used}</th>
              <th>{text.device.columns.usual}</th>
              <th>{text.device.columns.drops}</th>
              <th>{text.device.columns.now}</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && devices.data !== undefined && (
              <tr>
                <td colSpan={6} className="muted">
                  {text.nothingYet}
                </td>
              </tr>
            )}
            {shown.flatMap((device) => [
              <tr key={device.mac}>
                <td>
                  <span className="row">
                    <button
                      type="button"
                      className="link"
                      aria-expanded={opened === device.mac}
                      onClick={() => setOpened(opened === device.mac ? null : device.mac)}
                    >
                      {device.name}
                    </button>
                    <DeviceTags device={device} />
                  </span>
                </td>
                <td className="muted">{device.network ?? TEXT.none}</td>
                <td>
                  <span className="network-bar-cell">
                    <span>{sizeText(device.periodBytes)}</span>
                    <span className="network-bar">
                      <i
                        className={device.unusual ? "warning" : undefined}
                        style={{ width: `${Math.max(MINIMUM_BAR_PERCENT, (device.periodBytes / largest) * PERCENT)}%` }}
                      />
                    </span>
                  </span>
                </td>
                <td className="muted">
                  {device.usualBytes === null ? text.device.learning : sizeText(device.usualBytes)}
                </td>
                <td>{device.drops}</td>
                <td className={device.online ? "text-good" : "muted"}>
                  {device.online ? text.device.online : <TimeAgo timestamp={device.lastSeen} />}
                </td>
              </tr>,
              ...(opened === device.mac
                ? [
                    <tr key={`${device.mac}-open`}>
                      <td colSpan={6}>
                        <DeviceDetail mac={device.mac} onClose={() => setOpened(null)} />
                      </td>
                    </tr>,
                  ]
                : []),
            ])}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function speedBarClass({ fair, source }: SpeedTestView) {
  if (!fair) return "speed-bar unfair";
  return source === SPEED_SOURCE.router ? "speed-bar" : "speed-bar own";
}

function SpeedChart({ view }: { view: NetworkInternetView }) {
  const { tests, contract } = view;
  const top = Math.max(1, contract?.downMbps ?? 0, ...tests.map(({ downMbps }) => downMbps)) * FULL_SCALE_ROOM;
  return (
    <div className="speed-chart" role="img" aria-label={text.internet.chartLabel}>
      {contract !== null && (
        <span className="speed-line" style={{ bottom: `${(contract.downMbps / top) * PERCENT}%` }}>
          <em>{text.internet.contractLine(contract.downMbps)}</em>
        </span>
      )}
      {tests.map((test) => (
        <span
          key={test.at}
          className={speedBarClass(test)}
          title={text.internet.barTitle(test.downMbps, new Date(test.at).toLocaleString(), test.fair)}
          style={{ height: `${(test.downMbps / top) * PERCENT}%` }}
        />
      ))}
    </div>
  );
}

function Internet() {
  const queryClient = useQueryClient();
  const view = useQuery({
    queryKey: INTERNET_QUERY_KEY,
    queryFn: () => api<NetworkInternetView>("GET", API_ROUTES.networkInternet),
    refetchInterval: (query) =>
      query.state.data?.run.status === "running" ? ASKING_REFRESH_MILLISECONDS : REFRESH_MILLISECONDS,
  });
  const run = useMutation({
    mutationFn: () => api("POST", API_ROUTES.networkSpeedTest),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: INTERNET_QUERY_KEY }),
  });
  const data = view.data;
  if (data === undefined) return view.error ? <ErrorNotice error={view.error} /> : <Loading />;
  const running = data.run.status === "running" || run.isPending;
  const latest = data.tests.at(-1);
  return (
    <div className="stack">
      <section className="card">
        <div className="row spread">
          <h3>{text.internet.speedTitle}</h3>
          <button type="button" className="primary" disabled={running} onClick={() => run.mutate()}>
            {text.internet.run}
          </button>
        </div>
        {running && (
          <p className="small" role="status">
            {text.internet.running}
          </p>
        )}
        {data.run.status === "failed" && (
          <p className="notice warning small">{text.internet.runFailed(data.run.error)}</p>
        )}
        <ErrorNotice error={run.error} />
        {latest !== undefined && (
          <p className="small">
            <strong>{text.internet.latest(latest.downMbps, latest.upMbps, latest.ping)}</strong>{" "}
            <span className="muted">
              {latest.source === SPEED_SOURCE.router ? text.internet.byRouter : text.internet.byThisMachine}
            </span>
          </p>
        )}
        <p className="small muted">{text.internet.fairNote}</p>
        {data.tests.length === 0 && <p className="muted">{text.internet.noTests}</p>}
        {data.tests.length > 0 && <SpeedChart view={data} />}
        {data.speedTestRefused && <p className="notice warning small">{text.internet.refused}</p>}
        <p className="small muted">{text.internet.serverNote}</p>
        <div className="row">
          <a className="button" href={API_ROUTES.networkInternetReport} download>
            {text.internet.download}
          </a>
        </div>
      </section>
      <div className="network-two">
        <section className="card">
          <h3>{text.internet.outages}</h3>
          {data.outages.length === 0 && <p className="muted">{text.internet.noOutages}</p>}
          {data.outages.map(({ from, to, state }) => (
            <p key={from} className="small">
              <strong>{new Date(from).toLocaleString()}</strong>{" "}
              {text.internet.lasted(to === null ? null : Math.round((to - from) / 60_000))}
              {TEXT.separator}
              <span className="muted">{INTERNET_STATE_WORDS[state as InternetState] ?? state}</span>
            </p>
          ))}
          <p className="small muted">{text.internet.notWatched}</p>
        </section>
        <section className="card">
          <h3>{text.internet.line}</h3>
          {data.lines.map(({ wan, up, latency }) => (
            <p key={wan} className="small">
              <strong>{wan}</strong> {up ? text.internet.lineUp : text.internet.lineDown}
              {latency !== null && ` ${TEXT.separator}${latency} ms`}
            </p>
          ))}
          {data.publicAddress !== null && <p className="small muted mono">{data.publicAddress}</p>}
        </section>
      </div>
    </div>
  );
}

const CHECK_MARK = { [CHECK_RESULT.passed]: "✓", [CHECK_RESULT.failed]: "!", [CHECK_RESULT.notTested]: "○" };
const CHECK_CLASS = {
  [CHECK_RESULT.passed]: "text-good",
  [CHECK_RESULT.failed]: "text-warning",
  [CHECK_RESULT.notTested]: "muted",
};

function Firewall() {
  const queryClient = useQueryClient();
  const view = useQuery({
    queryKey: ["network-firewall"],
    queryFn: () => api<NetworkFirewallView>("GET", API_ROUTES.networkFirewall),
    refetchInterval: REFRESH_MILLISECONDS,
  });
  const confirm = useMutation({
    mutationFn: () => api("POST", API_ROUTES.networkFirewallConfirm),
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  const data = view.data;
  if (data === undefined) return view.error ? <ErrorNotice error={view.error} /> : <Loading />;
  const waiting = data.checks.some(({ key, result }) => key === "rules" && result === CHECK_RESULT.failed);
  return (
    <div className="stack">
      <section className="card">
        <h3>{text.firewall.evidence}</h3>
        <p className="small muted">{text.firewall.noClaim}</p>
        {data.checks.map(({ key, result }) => (
          <p key={key} className="small">
            <span className={CHECK_CLASS[result]}>{CHECK_MARK[result]}</span>{" "}
            {text.firewall.checks[key as keyof typeof text.firewall.checks][result]}
          </p>
        ))}
        {data.logLastAt !== null && (
          <p className="small muted">
            {text.firewall.logsLast}: <TimeAgo timestamp={data.logLastAt} />
          </p>
        )}
        {data.logRefusedSender !== null && (
          <p className="notice warning small">{text.firewall.logsRefused(data.logRefusedSender)}</p>
        )}
        {data.logNameUnresolved && <p className="notice warning small">{text.firewall.logsNameUnresolved}</p>}
      </section>
      <div className="network-two">
        <section className="card">
          <h3>{text.firewall.open}</h3>
          {!data.exposureReadable && <p className="muted">{text.firewall.cannotRead}</p>}
          {data.exposureReadable && data.forwards.length === 0 && <p className="muted">{text.firewall.noForwards}</p>}
          {data.forwards.map(({ name, detail, isNew }) => (
            <p key={`${name}${detail}`} className="small">
              <strong>{name}</strong> <span className="mono">{detail}</span>{" "}
              {isNew && <span className="text-warning">{text.firewall.isNew}</span>}
            </p>
          ))}
          {data.rules.length > 0 && <p className="small muted">{text.firewall.rules(data.rules.length)}</p>}
          {waiting && (
            <button type="button" className="primary" disabled={confirm.isPending} onClick={() => confirm.mutate()}>
              {text.firewall.iMadeThis}
            </button>
          )}
          <ErrorNotice error={confirm.error} />
        </section>
        <section className="card">
          <h3>{text.firewall.blocked}</h3>
          {data.blocked7Days === null && <p className="muted">{text.firewall.logsOff}</p>}
          {data.blocked7Days !== null && <p className="network-big">{data.blocked7Days.toLocaleString()}</p>}
          {data.blocked7Days !== null && <p className="small muted">{text.firewall.blockedNote}</p>}
          {data.crossing.slice(0, 8).map(({ source, destination, port, lines, blocked }) => (
            <p key={`${source}${destination}${port}${blocked}`} className="small">
              <strong>{source}</strong> {text.firewall.to} <strong>{destination}</strong>
              {TEXT.separator}
              {text.firewall.crossing(port, lines, blocked)}
            </p>
          ))}
        </section>
      </div>
    </div>
  );
}

function MapTab() {
  const view = useQuery({
    queryKey: ["network-map"],
    queryFn: () => api<NetworkMapView>("GET", API_ROUTES.networkMap),
    refetchInterval: REFRESH_MILLISECONDS,
  });
  if (view.data === undefined) return view.error ? <ErrorNotice error={view.error} /> : <Loading />;
  return <NetworkMap view={view.data} />;
}

function Reports() {
  const view = useQuery({
    queryKey: ["network-reports"],
    queryFn: () => api<NetworkReportView[]>("GET", API_ROUTES.networkReports),
  });
  if (view.data === undefined) return view.error ? <ErrorNotice error={view.error} /> : <Loading />;
  if (view.data.length === 0) return <p className="muted">{text.reports.none}</p>;
  return (
    <div className="stack">
      {view.data.map(({ at, summary, points, figures, server }) => (
        <section key={at} className="card">
          <h3>{new Date(at).toLocaleDateString()}</h3>
          <p>{summary}</p>
          <ul>
            {points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          <details>
            <summary className="small">{text.reports.figures}</summary>
            <p className="small muted mono">{figures.join(TEXT.separator)}</p>
          </details>
          <p className="small muted">{text.answeredBy(server)}</p>
        </section>
      ))}
    </div>
  );
}

/** What the router says of the network: six answers at the top, each a click from its detail. */
export function NetworkPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const overview = useQuery(networkOverviewQuery);
  return (
    <div className="page">
      <PageHeader title={text.title} lede={text.lede} />
      <div className="show-chips" role="group" aria-label={text.tabsLabel}>
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            className={name === tab ? "chip-button active" : "chip-button"}
            aria-pressed={name === tab}
            onClick={() => setTab(name)}
          >
            {text.tabs[name]}
          </button>
        ))}
      </div>
      {tab === "overview" && overview.data === undefined && !overview.error && <Loading />}
      {tab === "overview" && overview.data !== undefined && <Overview view={overview.data} onOpen={setTab} />}
      {tab === "devices" && <Devices />}
      {tab === "map" && <MapTab />}
      {tab === "internet" && <Internet />}
      {tab === "firewall" && <Firewall />}
      {tab === "reports" && <Reports />}
      <ErrorNotice error={overview.error} />
    </div>
  );
}
