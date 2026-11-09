import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { API_ROUTES } from "../../../src/shared/api.js";
import { sizeText } from "../../../src/shared/constants.js";
import { type NetworkMapView, type NetworkOverviewView, type NetworkReportView } from "../../../src/shared/network.js";
import { api } from "../api-client.js";
import { ErrorNotice, Loading, PageHeader } from "../components/common.js";
import { PATHS, SETTINGS_SECTIONS, TEXT } from "../constants.js";
import { networkOverviewQuery } from "../queries.js";
import { NetworkMap } from "./network-map.js";
import { MINIMUM_BAR_PERCENT, PERCENT, REFRESH_MILLISECONDS } from "./network/network-refresh.js";
import { Devices } from "./network/devices.js";
import { Internet } from "./network/internet.js";
import { Firewall } from "./network/firewall.js";

const text = TEXT.network;
const TABS = ["overview", "devices", "map", "internet", "firewall", "reports"] as const;
type Tab = (typeof TABS)[number];

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
