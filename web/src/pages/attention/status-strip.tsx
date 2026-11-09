import { AgentNetwork } from "../../components/agent-network.js";
import { useQuery } from "@tanstack/react-query";
import { useState, type DragEvent } from "react";
import { Link } from "react-router";
import { hasUpdate, type ContainerView, type HostView, type OllamaServersView } from "../../../../src/shared/api.js";
import { DETECTOR_THRESHOLDS, HOST_STATE, INTEGRATION_KIND } from "../../../../src/shared/constants.js";
import { carriesHandOver, droppedItems } from "../../agent-dispatch.js";
import { FLEET_STATE, fleetOf, serversFor, type Fleet, type FleetState } from "../../ollama-fleet.js";
import { hostLink } from "../../host-links.js";
import { Icon } from "../../components/icons.js";
import { PATHS, SETTINGS_SECTIONS, TEXT } from "../../constants.js";
import { percent } from "../../format.js";
import {
  integrationsQuery,
  ollamaQuery,
  networkOverviewQuery,
  ollamaServersQuery,
  routerSettingsQuery,
  overviewQuery,
} from "../../queries.js";
import { isAdmin, useSignedInSession } from "../../session.js";
import { healingPaused, hostStateText } from "../fleet-page.js";
import { homeAssistantProblems } from "../home-assistant-system.js";
import { diskUsedPercent, fullestDisk } from "../host-dial-values.js";
import { serverLabel, type HandOver } from "./attention-parts.js";

// How full the host's fullest disk is; 0 before its first report.
function fullestPercent(host: HostView): number {
  const fullest = fullestDisk(host.health);
  return fullest === undefined ? 0 : diskUsedPercent(fullest);
}

const updatesOn = (containers: readonly ContainerView[], hostId: string) =>
  containers.filter((container) => container.hostId === hostId && hasUpdate(container)).length;

// One more fact after the running count, the most pressing: a disk nearly full, else updates waiting.
function HostCardFact({ disk, updates }: { disk: number; updates: number }) {
  if (disk >= DETECTOR_THRESHOLDS.diskPercent) {
    return (
      <>
        {TEXT.separator}
        <span className="text-danger">{TEXT.attention.fullestDisk(percent(disk))}</span>
      </>
    );
  }
  return updates > 0 ? `${TEXT.separator}${TEXT.hosts.updates(updates)}` : null;
}

function HostCard({ host, updates }: { host: HostView; updates: number }) {
  const disk = fullestPercent(host);
  const healing = host.state === HOST_STATE.online && !healingPaused(host);
  return (
    <Link className="status-card" to={hostLink(host.id)}>
      <span className="status-card-head">
        <strong>{host.label}</strong>
        <span className={healing ? "state tone-good" : "state tone-danger"}>
          <span className="status-dot" />
          {hostStateText(host)}
        </span>
      </span>
      <span className="status-card-line">
        {TEXT.hosts.running(host.runningCount, host.containerCount)}
        <HostCardFact disk={disk} updates={updates} />
      </span>
    </Link>
  );
}

function HomeAssistantCard() {
  const integrations = useQuery(integrationsQuery);
  const overview = useQuery(overviewQuery);
  const text = TEXT.attention.homeAssistant;
  const configured = integrations.data?.some(
    (view) => view.kind === INTEGRATION_KIND.homeAssistant && view.source !== null,
  );
  if (!configured) {
    return (
      <Link className="status-card dashed" to={`${PATHS.settings}#${SETTINGS_SECTIONS.connections}`}>
        <span className="status-card-head">
          <strong>{text.title}</strong>
          <span className="state">{text.notConnected}</span>
        </span>
        <span className="status-card-line accent">{text.connect}</span>
      </Link>
    );
  }
  const home = overview.data?.homeAssistant ?? null;
  if (home === null || !home.connected) {
    return (
      <Link className="status-card" to={`${PATHS.settings}#${SETTINGS_SECTIONS.connections}`}>
        <span className="status-card-head">
          <strong>{text.title}</strong>
          <span className="state tone-danger">
            <span className="status-dot" />
            {text.notAnswering}
          </span>
        </span>
        <span className="status-card-line accent">{text.checkIt}</span>
      </Link>
    );
  }
  const problems = homeAssistantProblems(home);
  return (
    <Link className="status-card" to={PATHS.homeAssistant}>
      <span className="status-card-head">
        <strong>{text.title}</strong>
        <span className="state tone-good">
          <span className="status-dot" />
          {text.connected}
        </span>
      </span>
      <span className="status-card-line">{problems === 0 ? text.allFine : text.toLookAt(problems)}</span>
    </Link>
  );
}

// With several servers: each one, what it runs and who it watches.
function FleetLines({ fleet }: { fleet: Fleet }) {
  const onDefault = fleet.lines[0]?.name ?? TEXT.attention.ollama.defaultServer;
  const text = TEXT.attention.ollama;
  return (
    <span className="agent-servers">
      {fleet.lines.map((line) => (
        <span key={line.id ?? ""} className="agent-server">
          <span className={line.reachable ? "agent-server-name" : "agent-server-name tone-danger"}>
            {serverLabel(line.name)}
          </span>
          <span className="mono">{line.model}</span>
          <span className="muted">{text.watching(line.hosts)}</span>
          {!line.reachable && line.id !== null && (
            <span className="agent-server-note tone-danger">{text.onDefault(onDefault)}</span>
          )}
        </span>
      ))}
    </span>
  );
}

const FLEET_TONE: Record<FleetState, string> = {
  [FLEET_STATE.all]: "tone-good",
  [FLEET_STATE.some]: "tone-warning",
  [FLEET_STATE.none]: "tone-danger",
};

// Where what is being dragged goes. Nothing is said while there is only one place it could.
function dropWords(servers: OllamaServersView | undefined, draggingHosts: readonly (string | null)[]): string {
  const { dropTarget, goesTo, goesToServers } = TEXT.attention.agent;
  if ((servers?.extras.length ?? 0) === 0 || draggingHosts.length === 0) return dropTarget;
  const going = serversFor(servers, draggingHosts);
  return going.length === 1 ? goesTo(going[0] ?? TEXT.attention.ollama.defaultServer) : goesToServers(going.length);
}

function OllamaCard({
  hosts,
  onHandOver,
  draggingHosts,
  working,
}: {
  hosts: readonly HostView[];
  onHandOver?: HandOver;
  draggingHosts: readonly (string | null)[];
  working: boolean;
}) {
  const ollama = useQuery(ollamaQuery);
  const servers = useQuery(ollamaServersQuery);
  const [over, setOver] = useState(false);
  if (ollama.data === undefined) {
    return null;
  }
  const fleet = fleetOf(ollama.data, servers.data, hosts);
  const several = fleet.lines.length > 1;
  const text = TEXT.attention;
  const dropping = onHandOver !== undefined;
  const singleWords = ollama.data.reachable ? text.ollama.answering : text.ollama.notAnswering;
  const stateWords = several ? text.ollama.answeringOf(fleet.answering, fleet.lines.length) : singleWords;
  // Only a hand-over may be dropped here: anything else dragged over it is left to the browser.
  const dragOver = (event: DragEvent) => {
    if (!carriesHandOver(event)) {
      return;
    }
    event.preventDefault();
    setOver(true);
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const items = droppedItems(event);
    if (items.length > 0) {
      onHandOver?.(items);
    }
  };
  const classes = ["status-card", "agent-card", dropping ? "drop-target" : "", over ? "dragged-over" : ""];
  return (
    <Link
      className={classes.filter(Boolean).join(" ")}
      to={`${PATHS.settings}#${SETTINGS_SECTIONS.connections}`}
      title={dropping ? text.agent.dropHere : undefined}
      onDragEnter={dropping ? dragOver : undefined}
      onDragOver={dropping ? dragOver : undefined}
      onDragLeave={() => setOver(false)}
      onDrop={dropping ? drop : undefined}
    >
      <span className="status-card-head">
        <strong>
          <span className="agent-avatar" aria-hidden />
          {text.ollama.title}
        </strong>
        <span className={`state ${FLEET_TONE[fleet.state]}`}>
          <span className="status-dot" />
          {stateWords}
        </span>
      </span>
      {several && <FleetLines fleet={fleet} />}
      <AgentNetwork working={working || over} answering={fleet.state !== FLEET_STATE.none} />
      <span className={several ? "status-card-line agent-line agent-line-end" : "status-card-line agent-line"}>
        {!several && <span className="mono">{ollama.data.model}</span>}
        {dropping && (
          <span className="drop-chip">
            <Icon name="arrowDown" />
            {dropWords(servers.data, draggingHosts)}
          </span>
        )}
      </span>
    </Link>
  );
}

// With a router set up: how the network is doing, a click from its page. Its details are for admins.
function NetworkCard() {
  const admin = isAdmin(useSignedInSession());
  const router = useQuery({ ...routerSettingsQuery, enabled: admin });
  const overview = useQuery({ ...networkOverviewQuery, enabled: admin && router.data?.configured === true });
  const view = overview.data;
  if (view === undefined) return null;
  const text = TEXT.network.card;
  const toLookAt = view.toLookAt > 0;
  const words = toLookAt ? text.toLookAt(view.toLookAt) : text.allFine;
  const tone = toLookAt ? "tone-warning" : "tone-good";
  return (
    <Link className="status-card" to={PATHS.network}>
      <span className="status-card-head">
        <strong>{text.title}</strong>
        <span className={`state ${view.connected ? tone : "tone-danger"}`}>
          <span className="status-dot" />
          {view.connected ? words : text.notRead}
        </span>
      </span>
      <span className="status-card-line">
        {view.internet.upPercent === null
          ? TEXT.none
          : TEXT.network.stats.internetLine(view.internet.outages, view.internet.downMinutes)}
      </span>
    </Link>
  );
}

/**
 * Each host, Home Assistant and Ollama in a line of cards: how each is doing, each a link to more. Where work may
 * be handed to the Ollama agent, its card takes what is dropped on it.
 */
export function StatusStrip({
  hosts,
  containers,
  onHandOver,
  draggingHosts = [],
  working = false,
}: {
  hosts: readonly HostView[];
  containers: readonly ContainerView[];
  onHandOver?: HandOver;
  // The hosts of what is being dragged now.
  draggingHosts?: readonly (string | null)[];
  // Whether the agent has something in hand.
  working?: boolean;
}) {
  return (
    <nav className="status-strip" aria-label={TEXT.attention.services}>
      <div className="status-hosts">
        {hosts.map((host) => (
          <HostCard key={host.id} host={host} updates={updatesOn(containers, host.id)} />
        ))}
        <HomeAssistantCard />
        <NetworkCard />
      </div>
      <OllamaCard hosts={hosts} onHandOver={onHandOver} draggingHosts={draggingHosts} working={working} />
    </nav>
  );
}
