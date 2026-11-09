import { DependencyMap } from "../components/dependency-map.js";
import { ServiceProbes } from "../components/service-probes.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useState, type FormEvent } from "react";
import { Link, useLocation, useParams } from "react-router";
import {
  API_ROUTES,
  INCIDENT_QUERY,
  apiPath,
  type HostView,
  type IncidentSummaryView,
} from "../../../src/shared/api.js";
import {
  HOST_CHANGES_ANCHOR,
  HOST_KIND,
  HOST_LABEL_PATTERN,
  HOST_SECTIONS,
  HOST_STATE,
} from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { arrangedCards } from "../card-preferences.js";
import {
  ArrangeLine,
  CardGroup,
  fixedCard,
  usePageArrangement,
  type ArrangedCard,
  type MovableCard,
} from "../components/arranged-cards.js";
import { useAskInPlace } from "../components/ask-in-place.js";
import { Badge, ErrorNotice, Loading, TimeAgo } from "../components/common.js";
import { incidentLink } from "../components/incident-parts.js";
import {
  CARD_PAGES,
  DEPENDENCY_MAP_TEXT,
  HOST_CARDS,
  PATHS,
  RECENT_INCIDENTS,
  REFRESH_MILLISECONDS,
  TEXT,
} from "../constants.js";
import { dateTime, duration, timeAgo } from "../format.js";
import { hostContainersQuery, hostTasksQuery, hostsQuery } from "../queries.js";
import { useScrollToHash } from "../components/section-tabs.js";
import { isAdmin, useSignedInSession } from "../session.js";
import { RecoveryHoldBadge, StateBadge, waitingUpdates } from "./fleet-page.js";
import { HostChanges } from "./host-changes.js";
import { HostControl } from "./host-control.js";
import { HostContainers } from "../components/host-containers.js";
import { HostImages } from "./host-images.js";
import { RebootWarning } from "./host-packages.js";
import { HostUpdates } from "./host-updates.js";
import { HostOllamaFact } from "./ollama-servers.js";
import { HostDials, HostHistory } from "./host-stats.js";
import { HostProfileFold } from "./host-profile.js";
import { HostSystem } from "./host-system.js";
import { SshHostCard, SwitchToSsh } from "./host-ssh.js";
import { JoinCodeCard } from "./host-join-code.js";
import { RunnerBehind, isRunnerHost } from "./runner-behind.js";
import { PowerButtons, PowerStrip } from "./host-power.js";
import { CheckUpdates, TerminalButton } from "./host-page-actions.js";
import { DiskWarning, InPlaceWaiting, ContainersStale, ReportTrimmed } from "./host-notices.js";
import { HostTabs } from "./host-tabs.js";

const taskLink = (taskId: string) => apiPath(PATHS.task, { taskId });

// The terminal and xterm.js load when a shell first opens: most visits never need them.
const HostTerminal = lazy(() =>
  import("../components/shell-terminal.js").then((module) => ({ default: module.HostTerminal })),
);

// "delta3640 · 192.168.10.178 · Ubuntu 24.04.5 LTS · up 1 day · reported 12 seconds ago"
function aboutHost(host: HostView): string {
  const health = host.health;
  return [
    health?.hostname ?? null,
    health?.address ?? null,
    health?.operatingSystem ?? null,
    health === null ? null : TEXT.hosts.up(duration(health.uptimeSeconds)),
    host.lastHeartbeatAt === null ? null : TEXT.hosts.reported(timeAgo(host.lastHeartbeatAt)),
  ]
    .filter((part) => part !== null)
    .join(TEXT.separator);
}

function HostTasks({ hostId }: { hostId: string }) {
  const tasks = useQuery(hostTasksQuery(hostId));
  return (
    <section className="card">
      <h2>{TEXT.hosts.openHere}</h2>
      {tasks.data === undefined && <Loading />}
      {tasks.data?.length === 0 && <p className="muted small">{TEXT.hosts.nothingOpen}</p>}
      <ul className="plain-list">
        {tasks.data?.map((task) => (
          <li key={task.id} className="row">
            <Badge value={task.priority} />
            <Link to={taskLink(task.id)}>{task.title}</Link>
            <TimeAgo timestamp={task.updatedAt} />
            {task.snoozedUntil !== null && (
              <span className="small muted">{TEXT.hosts.snoozedUntil(dateTime(task.snoozedUntil))}</span>
            )}
          </li>
        ))}
      </ul>
      <ErrorNotice error={tasks.error} />
    </section>
  );
}

function HostIncidents({ hostId }: { hostId: string }) {
  const query = new URLSearchParams({
    [INCIDENT_QUERY.hostId]: hostId,
    [INCIDENT_QUERY.limit]: String(RECENT_INCIDENTS),
  });
  const incidents = useQuery({
    queryKey: ["incidents", "host", hostId],
    queryFn: () => api<IncidentSummaryView[]>("GET", `${API_ROUTES.incidents}?${query}`),
    refetchInterval: REFRESH_MILLISECONDS,
  });
  return (
    <section className="card">
      <h2>{TEXT.hosts.recentIncidents}</h2>
      {incidents.data === undefined && <Loading />}
      {incidents.data?.length === 0 && <p className="muted small">{TEXT.hosts.noIncidents}</p>}
      <ul className="plain-list">
        {incidents.data?.map((incident) => (
          <li key={incident.id} className="row">
            <Badge value={incident.verdict ?? incident.status} />
            <Link to={incidentLink(incident.id)}>{incident.containerName}</Link>
            <TimeAgo timestamp={incident.detectedAt} />
          </li>
        ))}
      </ul>
      <ErrorNotice error={incidents.error} />
    </section>
  );
}

/** Taking the host off the dashboard: its runner keeps healing on its own, and stops reporting here. */
function RevokeHost({ host }: { host: HostView }) {
  const queryClient = useQueryClient();
  const asking = useAskInPlace();
  const revoke = useMutation({
    mutationFn: () => api("POST", apiPath(API_ROUTES.hostRevoke, { hostId: host.id })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: hostsQuery.queryKey }),
  });
  const confirmRevoke = () => {
    asking.confirm(TEXT.hosts.revokeConfirm(host.label), () => revoke.mutate());
  };
  return (
    <section className="card revoke-host" aria-labelledby="revoke-host-title">
      <div>
        <h2 id="revoke-host-title">{TEXT.hosts.revokeTitle(host.label)}</h2>
        <p className="small muted">{TEXT.hosts.revokeExplanation}</p>
      </div>
      <button type="button" className="danger" disabled={revoke.isPending} onClick={confirmRevoke}>
        {TEXT.hosts.revoke}
      </button>
      {asking.question}
      <ErrorNotice error={revoke.error} />
    </section>
  );
}

/** A new name for the host, typed where its name shows: by the rules it was added by, and unique among hosts. */
function RenameHost({ host, onClose }: { host: HostView; onClose: () => void }) {
  const queryClient = useQueryClient();
  const rename = useMutation({
    mutationFn: (label: string) => api<HostView>("PATCH", apiPath(API_ROUTES.host, { hostId: host.id }), { label }),
    // Its name shows on most pages: each takes the new one.
    onSuccess: () => {
      onClose();
      void queryClient.invalidateQueries();
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    rename.mutate(String(new FormData(event.currentTarget).get("label") ?? "").trim());
  };
  return (
    <form className="title-row rename-host" aria-label={TEXT.hosts.renaming(host.label)} onSubmit={submit}>
      <input
        name="label"
        defaultValue={host.label}
        pattern={HOST_LABEL_PATTERN.source}
        title={TEXT.hosts.nameRule}
        aria-label={TEXT.hosts.newName(host.label)}
        required
        autoFocus
      />
      <button className="primary" type="submit" disabled={rename.isPending}>
        {TEXT.hosts.save}
      </button>
      <button type="button" onClick={onClose}>
        {TEXT.hosts.cancel}
      </button>
      <ErrorNotice error={rename.error} />
    </form>
  );
}

function HostTitle({ host, admin }: { host: HostView; admin: boolean }) {
  const [renaming, setRenaming] = useState(false);
  if (renaming) {
    return <RenameHost host={host} onClose={() => setRenaming(false)} />;
  }
  return (
    <div className="title-row">
      <h1>{host.label}</h1>
      <StateBadge host={host} />
      <RecoveryHoldBadge host={host} />
      {host.dryRun === true && <span className="badge neutral">{TEXT.hosts.dryRun}</span>}
      {admin && (
        <button type="button" className="link" onClick={() => setRenaming(true)}>
          {TEXT.hosts.rename}
        </button>
      )}
    </div>
  );
}

/**
 * What this browser may pin first or hide on a host's page, section by section. A link to one shows it hidden or not,
 * and so does the system card while the host's clock pauses its automatic recovery. Its containers, its open work and
 * what an admin does here keep their place.
 */
function hostCards({
  host,
  admin,
  enrolled,
  hasDocker,
  linkedTo,
}: {
  host: HostView;
  admin: boolean;
  enrolled: boolean;
  hasDocker: boolean;
  linkedTo: string;
}) {
  const overview: ArrangedCard[] = [
    { id: HOST_CARDS.dials, title: TEXT.metrics.dials, node: <HostDials host={host} /> },
    { id: HOST_CARDS.history, title: TEXT.metrics.statsHistory, node: <HostHistory host={host} /> },
    {
      id: HOST_CARDS.system,
      title: TEXT.hostSystem.title,
      pressing: (host.clockSkewSeconds ?? null) !== null,
      node:
        host.health === null ? (
          <p className="muted">{TEXT.hosts.noReport}</p>
        ) : (
          <HostSystem host={host} health={host.health} />
        ),
    },
    fixedCard(HOST_CARDS.ollama, <HostOllamaFact hostId={host.id} />),
    ...(admin && hasDocker
      ? [{ id: HOST_CARDS.profile, title: TEXT.hostProfile.title, node: <HostProfileFold hostId={host.id} /> }]
      : []),
    ...(admin ? [{ id: HOST_CARDS.probes, title: TEXT.probes.title, node: <ServiceProbes hostId={host.id} /> }] : []),
  ];
  const images: MovableCard[] = enrolled
    ? [{ id: HOST_CARDS.images, title: TEXT.hostImages.title, node: <HostImages host={host} admin={admin} /> }]
    : [];
  const updates: MovableCard[] = [
    {
      id: HOST_CARDS.updates,
      title: TEXT.containerImages.heading,
      pressing: linkedTo === HOST_SECTIONS.updates,
      node: <HostUpdates host={host} admin={admin} />,
    },
  ];
  const dependencies: MovableCard[] = [
    {
      id: HOST_CARDS.dependencies,
      title: DEPENDENCY_MAP_TEXT.title,
      pressing: linkedTo === HOST_SECTIONS.dependencies,
      node: (
        <>
          <DependencyMap host={host} />
          {admin && (
            <p>
              <Link to={`${PATHS.backups}#application-plans`}>Application backup coverage and restore drills</Link>
            </p>
          )}
        </>
      ),
    },
  ];
  const control: MovableCard[] = enrolled
    ? [
        {
          id: HOST_CARDS.control,
          title: TEXT.hostControl.title(host.label),
          pressing: linkedTo === HOST_SECTIONS.control,
          node: <HostControl host={host} admin={admin} />,
        },
      ]
    : [];
  const changes: MovableCard[] = [
    {
      id: HOST_CARDS.changes,
      title: TEXT.hostChanges.title,
      pressing: linkedTo === HOST_CHANGES_ANCHOR,
      node: <HostChanges hostId={host.id} />,
    },
  ];
  return { overview, images, updates, dependencies, control, changes };
}

/** One host: how it runs, its containers, what waits to be updated, and what Autoheal may do there. */
export function HostPage() {
  const { hostId = "" } = useParams();
  const admin = isAdmin(useSignedInSession());
  // The host whose terminal is open: another host's page opens with none.
  const [terminalHost, setTerminalHost] = useState<string | null>(null);
  const [containersAsked, setContainersAsked] = useState(0);
  const hosts = useQuery(hostsQuery);
  const containers = useQuery({ ...hostContainersQuery(hostId), enabled: hostId !== "" });
  const page = usePageArrangement(CARD_PAGES.host);
  const linkedTo = useLocation().hash.slice(1);
  // A link from Attention or a task to one section lands on it once the host is drawn.
  useScrollToHash(hosts.data !== undefined);
  if (hosts.data === undefined) {
    return hosts.error ? <ErrorNotice error={hosts.error} /> : <Loading />;
  }
  const host = hosts.data.find((candidate) => candidate.id === hostId);
  if (host === undefined) {
    return (
      <div className="page">
        <h1>{TEXT.hosts.title}</h1>
        <p className="muted">{TEXT.hosts.notFound}</p>
        <Link to={PATHS.hosts}>{TEXT.hosts.back}</Link>
      </div>
    );
  }
  const enrolled = host.state !== HOST_STATE.revoked;
  // Its containers' sections show while it reports Docker, and come back by themselves once Docker is installed.
  const hasDocker = host.docker !== false;
  const terminalOpen = admin && terminalHost === host.id;
  const { overview, images, updates, dependencies, control, changes } = hostCards({
    host,
    admin,
    enrolled,
    hasDocker,
    linkedTo,
  });
  // A section with every card hidden goes, and its tab with it.
  const shown = (cards: readonly ArrangedCard[]) => arrangedCards(cards, page.arrangement).length > 0;
  const showsUpdates = shown(updates);
  const showsDependencies = hasDocker && shown(dependencies);
  const showsControl = hasDocker && shown(control);
  const hiddenSections = [
    ...(showsUpdates ? [] : [HOST_SECTIONS.updates]),
    ...(showsDependencies ? [] : [HOST_SECTIONS.dependencies]),
    ...(showsControl ? [] : [HOST_SECTIONS.control]),
  ];
  const arrangeable = [
    ...overview,
    ...(hasDocker ? [...images, ...dependencies, ...control] : []),
    ...updates,
    ...changes,
  ];
  // Keyed by host: what is ticked, found or opened on one host, and its containers' last report, never carry over.
  return (
    <div className="page host-page" key={host.id}>
      <nav className="crumbs" aria-label={TEXT.hosts.trail}>
        <Link to={PATHS.hosts}>{TEXT.hosts.title}</Link>
        <span aria-hidden>/</span>
        <span aria-current="page">{host.label}</span>
      </nav>
      <header className="page-header">
        <div>
          <HostTitle host={host} admin={admin} />
          <p className="lede">{aboutHost(host)}</p>
        </div>
        {admin && enrolled && (
          <div className="header-actions">
            <CheckUpdates hostId={host.id} docker={hasDocker} />
            <TerminalButton
              host={host}
              open={terminalOpen}
              onToggle={() => setTerminalHost(terminalOpen ? null : host.id)}
            />
            <PowerButtons host={host} />
          </div>
        )}
      </header>
      {terminalOpen && (
        <Suspense fallback={<Loading />}>
          <HostTerminal host={host} onClose={() => setTerminalHost(null)} />
        </Suspense>
      )}
      <PowerStrip host={host} />
      <DiskWarning host={host} admin={admin} />
      <RebootWarning hostId={host.id} hostLabel={host.label} admin={admin} />
      <InPlaceWaiting host={host} />
      <ContainersStale host={host} />
      <ReportTrimmed host={host} />
      {isRunnerHost(host) && <RunnerBehind host={host} />}
      <HostTabs
        containers={host.containerCount}
        updates={waitingUpdates(host, containers.data ?? [])}
        docker={hasDocker}
        hidden={hiddenSections}
        onContainers={() => setContainersAsked((asked) => asked + 1)}
      />
      <section id={HOST_SECTIONS.overview} className="host-section">
        <CardGroup cards={overview} page={page} />
      </section>
      {hasDocker && (
        <section id={HOST_SECTIONS.containers} className="host-section">
          <HostContainers host={host} admin={admin} containersAsked={containersAsked} />
          <CardGroup cards={images} page={page} />
        </section>
      )}
      {showsUpdates && (
        <section id={HOST_SECTIONS.updates} className="host-section">
          <CardGroup cards={updates} page={page} />
        </section>
      )}
      {showsDependencies && (
        <section id={HOST_SECTIONS.dependencies} className="host-section">
          <CardGroup cards={dependencies} page={page} />
        </section>
      )}
      {showsControl && (
        <section id={HOST_SECTIONS.control} className="host-section">
          <CardGroup cards={control} page={page} />
        </section>
      )}
      <div className="host-more">
        <div className="split even">
          <HostTasks hostId={host.id} />
          <HostIncidents hostId={host.id} />
        </div>
        <CardGroup cards={changes} page={page} />
        {admin && enrolled && host.kind === HOST_KIND.ssh && <SshHostCard host={host} />}
        {admin && enrolled && isRunnerHost(host) && <SwitchToSsh host={host} />}
        {admin && enrolled && isRunnerHost(host) && host.lastHeartbeatAt !== null && <JoinCodeCard host={host} />}
        {admin && enrolled && <RevokeHost host={host} />}
      </div>
      <ArrangeLine cards={arrangeable} page={page} />
    </div>
  );
}
