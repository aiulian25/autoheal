import { RebootPlanPanel } from "../components/reboot-plan.js";
import { MaintenanceBadge } from "../components/maintenance-dialog.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import { Link } from "react-router";
import {
  API_ROUTES,
  apiPath,
  hasUpdate,
  type BoardView,
  type ContainerView,
  type HostMetricsView,
  type HostView,
} from "../../../src/shared/api.js";
import {
  CONTAINER_STATE_RUNNING,
  HOST_SECTIONS,
  HOST_STATE,
  RESTART_CHOICE,
  wordsOf,
  type HostState,
} from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { whatNeedsYou } from "../board.js";
import { GaugeFigure, type Gauge } from "../components/charts.js";
import { ErrorNotice, Loading, PageHeader } from "../components/common.js";
import { Icon } from "../components/icons.js";
import { PATHS, TEXT, type Tone } from "../constants.js";
import { bytesOf, celsius, linkSpeed, percentOf, shortSystemName, shortTimeAgo, timeOfDay } from "../format.js";
import {
  boardQuery,
  containersQuery,
  enrolledHostsQuery,
  hostsQuery,
  localHostQuery,
  overviewQuery,
} from "../queries.js";
import { isAdmin, useSignedInSession } from "../session.js";
import { ConnectHostTile } from "./connect-host.js";
import { powerBadge } from "./host-power.js";
import { HomeAssistantFleetCard } from "./home-assistant-system.js";
import { diskUsedPercent, fullestDisk, networkCeiling, rateDial, shareDial } from "./host-stats.js";

const hostLink = (hostId: string) => apiPath(PATHS.host, { hostId });

const STATE_TONE: Record<HostState, string> = {
  [HOST_STATE.online]: "good",
  [HOST_STATE.silent]: "danger",
  [HOST_STATE.neverSeen]: "warning",
  [HOST_STATE.revoked]: "neutral",
};

/** An online host whose runner lost Docker's events still reports, but heals nothing until they are back. */
export const healingPaused = (host: HostView) =>
  host.state === HOST_STATE.online && host.docker !== false && !host.eventStreamConnected;

export const hostStateText = (host: HostView) => (healingPaused(host) ? TEXT.hosts.healingPaused : wordsOf(host.state));

export function StateBadge({ host }: { host: HostView }) {
  // Being rebooted or shut down, it says so: rebooting, offline, starting, shut down.
  const power = powerBadge(host.power);
  if (power !== null) {
    return (
      <span className={power.moving ? `badge ${power.tone} badge-moving` : `badge ${power.tone}`}>
        <span className="status-dot" />
        {power.text}
      </span>
    );
  }
  const tone = healingPaused(host) ? "danger" : STATE_TONE[host.state];
  return (
    <span className={`badge ${tone}`}>
      <span className="status-dot" />
      {hostStateText(host)}
    </span>
  );
}

/** Its runner restarts nothing on its own just now: for the hour after a new install, or until someone fixes it. */
export function RecoveryHoldBadge({ host }: { host: HostView }) {
  const hold = host.recoveryHold ?? null;
  if (hold === null) {
    return null;
  }
  const text = hold.until === null ? TEXT.hosts.recoveryHeld : TEXT.hosts.recoveryHeldUntil(timeOfDay(hold.until));
  const tone: Tone = hold.until === null ? "danger" : "warning";
  return (
    <span className={`badge ${tone}`} title={TEXT.hosts.recoveryHeldWhy[hold.reason]}>
      {text}
    </span>
  );
}

function cpuDetail(host: HostView): string | null {
  const temperature = host.metrics?.cpu.temperatureCelsius ?? null;
  const parts = [
    host.health === null ? null : TEXT.metrics.threads(host.health.cpuCount),
    temperature === null ? null : celsius(temperature),
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(TEXT.separator);
}

// The first card is the one the host talks through; the host's page lists them all.
function networkDetail(network: NonNullable<HostMetricsView["network"]>): string | null {
  const card = network.interfaces[0];
  if (card === undefined) {
    return null;
  }
  return card.speedMegabitsPerSecond === null
    ? card.name
    : `${card.name}${TEXT.separator}${linkSpeed(card.speedMegabitsPerSecond)}`;
}

function gaugesOf(host: HostView, metrics: HostMetricsView): Gauge[] {
  const { memory, network } = metrics;
  const disk = fullestDisk(host.health);
  const disks: Gauge[] =
    disk === undefined
      ? []
      : [
          {
            label: TEXT.metrics.disk,
            detail: disk.path,
            mono: true,
            dial: shareDial(diskUsedPercent(disk), TEXT.metrics.used, "violet"),
          },
        ];
  const networks: Gauge[] =
    network === null
      ? []
      : [
          {
            label: TEXT.metrics.network,
            detail: networkDetail(network),
            mono: false,
            dial: rateDial(
              network.receiveBytesPerSecond + network.transmitBytesPerSecond,
              TEXT.metrics.inAndOut,
              "violet",
              networkCeiling(network),
            ),
          },
        ];
  return [
    {
      label: TEXT.metrics.cpu,
      detail: cpuDetail(host),
      mono: false,
      dial: shareDial(metrics.cpu.busyPercent, TEXT.metrics.busy, "violet"),
    },
    {
      label: TEXT.metrics.memory,
      detail: bytesOf(memory.usedBytes, memory.totalBytes),
      mono: false,
      dial: shareDial(percentOf(memory.usedBytes, memory.totalBytes), TEXT.metrics.used, "green"),
    },
    ...disks,
    ...networks,
  ];
}

interface HostFacts {
  updates: number;
  problems: number;
  decisions: number;
}

function aboutHost(host: HostView): string {
  const system = host.health?.operatingSystem ?? null;
  return [
    system === null ? null : shortSystemName(system),
    host.health === null ? null : TEXT.hosts.cpus(host.health.cpuCount),
    host.lastHeartbeatAt === null ? null : TEXT.hosts.reported(shortTimeAgo(host.lastHeartbeatAt)),
  ]
    .filter((part) => part !== null)
    .join(TEXT.separator);
}

function HostCard({ host, facts }: { host: HostView; facts: HostFacts }) {
  const titleId = useId();
  return (
    <article className="card host-card" aria-labelledby={titleId}>
      <header className="host-card-head">
        <h2 id={titleId}>{host.label}</h2>
        <StateBadge host={host} />
        <RecoveryHoldBadge host={host} />
        <MaintenanceBadge hostId={host.id} />
      </header>
      <p className="host-card-about">{aboutHost(host)}</p>
      {host.metrics === null ? (
        <p className="host-card-empty muted">{TEXT.hosts.noStats}</p>
      ) : (
        <div className="gauges">
          {gaugesOf(host, host.metrics).map((gauge) => (
            <GaugeFigure key={gauge.label} gauge={gauge} />
          ))}
        </div>
      )}
      <footer className="host-card-foot">
        <span>
          {host.docker === false ? TEXT.hosts.systemOnly : TEXT.hosts.running(host.runningCount, host.containerCount)}
        </span>
        {facts.updates > 0 && <span>{TEXT.hosts.updates(facts.updates)}</span>}
        {facts.problems > 0 && <span className="text-danger">{TEXT.hosts.problems(facts.problems)}</span>}
        {facts.decisions > 0 && <span className="text-warning">{TEXT.hosts.needYou(facts.decisions)}</span>}
        <Link className="push" to={hostLink(host.id)} aria-label={TEXT.hosts.openHost(host.label)}>
          {TEXT.hosts.open}
        </Link>
      </footer>
    </article>
  );
}

/** New images for the host's containers, and its own packages' updates: everything the host's Updates hold. */
export const waitingUpdates = (host: HostView, containers: readonly ContainerView[]) =>
  containers.filter((container) => container.hostId === host.id && hasUpdate(container)).length +
  (host.health?.pendingUpdates ?? 0);

// The same counts the Attention page groups under Updates, Fix and Decide, host by host.
function factsOf(host: HostView, containers: readonly ContainerView[], board: BoardView | undefined): HostFacts {
  const { decisions, problems } = whatNeedsYou(board?.needsYou ?? []);
  return {
    updates: waitingUpdates(host, containers),
    problems: problems.filter((card) => card.task.hostId === host.id).length,
    decisions: decisions.filter((card) => card.incident.hostId === host.id).length,
  };
}

// Stopped without a problem, and still watched: one left unwatched was stopped on purpose, and is not counted.
const stoppedOn = (containers: readonly ContainerView[], hostId: string) =>
  containers.filter(
    (container) =>
      container.hostId === hostId &&
      container.state !== CONTAINER_STATE_RUNNING &&
      container.problem === null &&
      container.byItself.restart !== RESTART_CHOICE.ignore,
  ).length;

/**
 * The dashboard's own machine lost its runner: the same host comes back with a new token, which the runner reads
 * from the volume both share. Nothing stops or restarts.
 */
function LocalRunnerRevoked() {
  const queryClient = useQueryClient();
  const reenroll = useMutation({
    mutationFn: () => api<HostView>("POST", API_ROUTES.localHostReenroll),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: hostsQuery.queryKey });
      await queryClient.invalidateQueries({ queryKey: localHostQuery.queryKey });
    },
  });
  return (
    <>
      <div className="banner danger" role="status">
        <Icon name="alert" />
        <p>{TEXT.hosts.localRevoked}</p>
        <button type="button" className="primary" disabled={reenroll.isPending} onClick={() => reenroll.mutate()}>
          {TEXT.hosts.addLocalAgain}
        </button>
      </div>
      <ErrorNotice error={reenroll.error} />
    </>
  );
}

function StoppedBanner({ host, count }: { host: HostView; count: number }) {
  return (
    <p className="banner">
      <span>{TEXT.hosts.stopped(count, host.label)}</span>
      <Link to={`${hostLink(host.id)}#${HOST_SECTIONS.containers}`}>{TEXT.hosts.reviewStopped}</Link>
    </p>
  );
}

/** Every host at a glance, Home Assistant's box beside them, what is stopped and counted, and how to add another. */
export function FleetPage() {
  const admin = isAdmin(useSignedInSession());
  const hosts = useQuery(enrolledHostsQuery);
  const containers = useQuery(containersQuery);
  const board = useQuery(boardQuery);
  const overview = useQuery(overviewQuery);
  const local = useQuery({ ...localHostQuery, enabled: admin });
  if (hosts.data === undefined) {
    return (
      <div className="page">
        <ErrorNotice error={hosts.error} />
        {hosts.error === null && <Loading />}
      </div>
    );
  }
  const list = containers.data ?? [];
  const online = hosts.data.filter((host) => host.state === HOST_STATE.online).length;
  const running = hosts.data.reduce((total, host) => total + host.runningCount, 0);
  const total = hosts.data.reduce((sum, host) => sum + host.containerCount, 0);
  const stopped = hosts.data
    .map((host) => ({ host, count: stoppedOn(list, host.id) }))
    .filter((entry) => entry.count > 0);
  // Null until Home Assistant is set up in Settings.
  const home = overview.data?.homeAssistant ?? null;
  return (
    <div className="page fleet">
      <PageHeader title={TEXT.hosts.title} lede={TEXT.hosts.lede(online, running, total)} />
      {admin && local.data?.revoked === true && <LocalRunnerRevoked />}
      {hosts.data.length === 0 && <p className="card muted">{TEXT.hosts.empty}</p>}
      {(hosts.data.length > 0 || home !== null || admin) && (
        <div className="host-grid">
          {hosts.data.map((host) => (
            <HostCard key={host.id} host={host} facts={factsOf(host, list, board.data)} />
          ))}
          {home !== null && <HomeAssistantFleetCard home={home} />}
          {admin && <ConnectHostTile hosts={hosts.data} />}
        </div>
      )}
      {admin && <RebootPlanPanel hosts={hosts.data} />}
      {stopped.map((entry) => (
        <StoppedBanner key={entry.host.id} host={entry.host} count={entry.count} />
      ))}
      <ErrorNotice error={containers.error ?? board.error} />
    </div>
  );
}
