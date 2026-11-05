import { DependencyMap } from "../components/dependency-map.js";
import { ServiceProbes } from "../components/service-probes.js";
import { queryOptions, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, lazy, Suspense, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router";
import {
  API_ROUTES,
  INCIDENT_QUERY,
  apiPath,
  type HostPackagesView,
  type HostView,
  type IncidentSummaryView,
  type JobView,
} from "../../../src/shared/api.js";
import {
  DETECTOR_THRESHOLDS,
  HOST_KIND,
  HOST_LABEL_PATTERN,
  HOST_PACKAGES,
  HOST_SECTIONS,
  HOST_STATE,
  JOB_ACTION,
  TASK_RESOURCE,
  type TaskSnooze,
} from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { Badge, ErrorNotice, Loading, TimeAgo } from "../components/common.js";
import { Icon } from "../components/icons.js";
import { isWaiting } from "../components/container-actions.js";
import { incidentLink } from "../components/incident-parts.js";
import { JOB_REFRESH_MILLISECONDS, PATHS, RECENT_INCIDENTS, REFRESH_MILLISECONDS, TEXT } from "../constants.js";
import { countInWords, dateTime, duration, listSeparator, percent, timeAgo } from "../format.js";
import { boardQuery, hostContainersQuery, hostPackagesQuery, hostTasksQuery, hostsQuery } from "../queries.js";
import { SnoozeChoices } from "../components/snooze-choices.js";
import { useScrollToHash } from "../components/section-tabs.js";
import { isAdmin, useSignedInSession } from "../session.js";
import { RecoveryHoldBadge, StateBadge, waitingUpdates } from "./fleet-page.js";
import { HostChanges } from "./host-changes.js";
import { HostContainers, HostControl } from "./host-control.js";
import { HostImages } from "./host-images.js";
import { RebootWarning, hostPackageJobKey, useHostPackageBusy } from "./host-packages.js";
import { HostUpdates } from "./host-updates.js";
import { HostOllamaFact } from "./ollama-servers.js";
import { HostDials, HostHistory, diskUsedPercent } from "./host-stats.js";
import { HostProfileFold } from "./host-profile.js";
import { HostSystem } from "./host-system.js";
import { SshHostCard, SwitchToSsh } from "./host-ssh.js";
import { RunnerBehind, isRunnerHost } from "./runner-behind.js";
import { PowerButtons, PowerStrip } from "./host-power.js";

const taskLink = (taskId: string) => apiPath(PATHS.task, { taskId });

// The host's .env lets its packages be listed: a check can be asked for.
const packagesCheckable = (view: HostPackagesView | undefined) =>
  view?.facts !== null &&
  view?.facts !== undefined &&
  view.facts.unsupported === null &&
  view.facts.setting !== HOST_PACKAGES.off;

type CheckAction = typeof JOB_ACTION.checkUpdates | typeof JOB_ACTION.checkPackages;

/**
 * Asks the host's runner to check every image for updates now, and its own packages where its .env lets
 * them be listed, instead of at their next scheduled checks.
 */
// Its images are checked only where it runs Docker: an SSH host without it has its packages alone.
// The terminal and xterm.js load when a shell first opens: most visits never need them.
const HostTerminal = lazy(() =>
  import("../components/shell-terminal.js").then((module) => ({ default: module.HostTerminal })),
);

/** Why no shell can open on the host now; null when one can. */
function terminalUnavailable(host: HostView): string | null {
  const reasons = TEXT.hostTerminal.unavailable;
  if (host.state !== HOST_STATE.online) return reasons.silent(host.label);
  const allowed = host.hostTerminal ?? null;
  if (allowed === null) return reasons.runner(host.label);
  return allowed ? null : reasons.off(host.label);
}

function TerminalButton({ host, open, onToggle }: { host: HostView; open: boolean; onToggle: () => void }) {
  const unavailable = terminalUnavailable(host);
  return (
    <button
      type="button"
      disabled={unavailable !== null}
      title={unavailable ?? undefined}
      aria-pressed={open}
      onClick={onToggle}
    >
      <Icon name="terminal" />
      {TEXT.hostTerminal.button}
    </button>
  );
}

function CheckUpdates({ hostId, docker }: { hostId: string; docker: boolean }) {
  const queryClient = useQueryClient();
  const packages = useQuery(hostPackagesQuery(hostId));
  const packagesBusy = useHostPackageBusy(hostId, packages.data, packages.isError);
  const [accepted, setAccepted] = useState<JobView[]>([]);
  const [remaining, setRemaining] = useState<readonly CheckAction[]>([]);
  // Follow exact IDs: the host's bounded recent-jobs list may no longer contain a long-running check.
  const results = useQueries({
    queries: accepted.map((job) =>
      queryOptions({
        queryKey: ["job", job.id],
        queryFn: () => api<JobView>("GET", apiPath(API_ROUTES.job, { jobId: job.id })),
        initialData: job,
        staleTime: 0,
        refetchInterval: (query) =>
          query.state.data === undefined || isWaiting(query.state.data) ? JOB_REFRESH_MILLISECONDS : false,
      }),
    ),
  });
  const jobs = accepted.map((job, index) => results[index]?.data ?? job);
  const busy = jobs.some(isWaiting);
  const statusUnavailable = results.some((result, index) => result.isError && isWaiting(jobs[index]!));
  const check = useMutation({
    mutationKey: hostPackageJobKey(hostId),
    mutationFn: async (actions: readonly CheckAction[]) => {
      for (const [index, action] of actions.entries()) {
        const job = await api<JobView>("POST", apiPath(API_ROUTES.hostActions, { hostId }), { action });
        setAccepted((current) => [...current, job]);
        // Retain each accepted ID even if the next submission fails. Retrying submits only the remainder.
        setRemaining(actions.slice(index + 1));
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: hostPackagesQuery(hostId).queryKey }),
  });
  const start = () => {
    const actions =
      remaining.length > 0
        ? remaining
        : [
            ...(docker ? [JOB_ACTION.checkUpdates] : []),
            ...(packagesCheckable(packages.data) ? [JOB_ACTION.checkPackages] : []),
          ];
    if (remaining.length === 0) setAccepted([]);
    setRemaining(actions);
    check.mutate(actions);
  };
  const partial = check.isError && accepted.length > 0;
  // A host without Docker whose packages cannot be checked (yet) has nothing to check.
  const nothingToCheck = !docker && !packagesCheckable(packages.data);
  const words = TEXT.actions.hostCheck;
  return (
    <div className="header-action stack">
      {jobs.map((job) => (
        <span key={job.id} className="small muted" role="status">
          {job.action === JOB_ACTION.checkUpdates ? words.images : words.packages}: {words.states[job.status]}
        </span>
      ))}
      <button type="button" disabled={check.isPending || busy || packagesBusy || nothingToCheck} onClick={start}>
        {partial ? words.retryPackages : TEXT.actions.checkHost}
      </button>
      {partial && (
        <span className="small muted" role="status">
          {words.partial}
        </span>
      )}
      <ErrorNotice error={check.error} />
      {statusUnavailable && (
        <>
          <p className="notice error small" role="alert">
            {words.unavailable}
          </p>
          <button
            type="button"
            disabled={results.some((result) => result.isFetching)}
            onClick={() => {
              for (const result of results) void result.refetch();
            }}
          >
            {words.refresh}
          </button>
        </>
      )}
    </div>
  );
}

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

// Reached through a runner container of its own: older views name no kind.

/** This machine, while its runner waits to be looked after from Autoheal's own container: why, and what to do. */
function InPlaceWaiting({ host }: { host: HostView }) {
  const problem = host.inPlace?.problem ?? null;
  if (problem === null) {
    return null;
  }
  return (
    <p className="notice warning small" role="status">
      {problem}
    </p>
  );
}

/** The disks the tasks count as almost full, fullest first, in one sentence above everything else. */
function DiskWarning({ host, admin }: { host: HostView; admin: boolean }) {
  const queryClient = useQueryClient();
  const tasks = useQuery(hostTasksQuery(host.id));
  const taskOf = (path: string) =>
    tasks.data?.find((task) => task.resource?.kind === TASK_RESOURCE.disk && task.resource.id === path);
  const full = (host.health?.disks ?? [])
    .map((disk) => ({ path: disk.path, used: diskUsedPercent(disk) }))
    .filter((disk) => disk.used >= DETECTOR_THRESHOLDS.diskPercent && !taskOf(disk.path)?.snoozedUntil)
    .sort((first, second) => second.used - first.used);
  const snooze = useMutation({
    mutationFn: (snoozed: TaskSnooze) =>
      Promise.all(
        full
          .flatMap((disk) => taskOf(disk.path) ?? [])
          .map((task) => api("PATCH", apiPath(API_ROUTES.task, { taskId: task.id }), { snoozed })),
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void queryClient.invalidateQueries({ queryKey: boardQuery.queryKey });
    },
  });
  if (full.length === 0) {
    return null;
  }
  const canSnooze = admin && full.every((disk) => taskOf(disk.path) !== undefined);
  return (
    <div className="banner danger" role="status">
      <Icon name="alert" />
      <p>
        {TEXT.hosts.disksAlmostFull(countInWords(full.length))}
        {full.map((disk, index) => (
          <Fragment key={disk.path}>
            {listSeparator(index, full.length)}
            <code>{disk.path}</code>
            {TEXT.hosts.diskAt(percent(disk.used))}
          </Fragment>
        ))}
        {TEXT.sentenceEnd}
      </p>
      {canSnooze && <SnoozeChoices disabled={snooze.isPending} onChoose={(length) => snooze.mutate(length)} />}
      <a href={`#${HOST_SECTIONS.overview}`}>{TEXT.hosts.seeDisks}</a>
      <ErrorNotice error={snooze.error} />
    </div>
  );
}

const SECTION_ORDER = [
  HOST_SECTIONS.overview,
  HOST_SECTIONS.containers,
  HOST_SECTIONS.updates,
  HOST_SECTIONS.dependencies,
  HOST_SECTIONS.control,
];
type Section = (typeof SECTION_ORDER)[number];

const isSectionOf = (sections: readonly Section[], hash: string): hash is Section =>
  (sections as readonly string[]).includes(hash);
// What a host without Docker has: its system and its packages. The rest is its containers', and comes back with Docker.
const WITHOUT_DOCKER: readonly Section[] = [HOST_SECTIONS.overview, HOST_SECTIONS.updates];
const sectionsOf = (docker: boolean): readonly Section[] => (docker ? SECTION_ORDER : WITHOUT_DOCKER);

/** The section crossing this share of the window's height is the one being read. */
const READING_LINE = 1 / 3;

/** Which section a person has scrolled to; null until they scroll, and again each time a tab jumps. */
function useSectionScrolledTo(docker: boolean, hash: string): Section | null {
  const [scrolledTo, setScrolledTo] = useState<Section | null>(null);
  useEffect(() => setScrolledTo(null), [hash]);
  useEffect(() => {
    const look = () => {
      const line = window.innerHeight * READING_LINE;
      const passed = sectionsOf(docker).filter(
        (section) => (document.getElementById(section)?.getBoundingClientRect().top ?? Infinity) <= line,
      );
      setScrolledTo(passed.at(-1) ?? null);
    };
    window.addEventListener("scroll", look, { passive: true });
    return () => window.removeEventListener("scroll", look);
  }, [docker]);
  return scrolledTo;
}

/** The page's sections as tabs that jump to them, the one being read underlined. */
function HostTabs({
  containers,
  updates,
  docker,
  onContainers,
}: {
  containers: number;
  updates: number;
  docker: boolean;
  onContainers: () => void;
}) {
  const hash = useLocation().hash.slice(1);
  const sections = sectionsOf(docker);
  const scrolledTo = useSectionScrolledTo(docker, hash);
  const jumpedTo = isSectionOf(sections, hash) ? hash : HOST_SECTIONS.overview;
  const active = scrolledTo ?? jumpedTo;
  const extras: Record<Section, ReactNode> = {
    overview: null,
    dependencies: null,
    containers: <span className="tab-count">{containers}</span>,
    updates: updates > 0 ? <span className="tab-pill">{updates}</span> : null,
    control: null,
  };
  return (
    <nav className="tabs host-tabs" aria-label={TEXT.hosts.tabs.label}>
      {sections.map((section) => (
        <a
          key={section}
          href={`#${section}`}
          aria-current={active === section ? "true" : undefined}
          onClick={section === HOST_SECTIONS.containers ? onContainers : undefined}
        >
          {TEXT.hosts.tabs[section]}
          {extras[section]}
        </a>
      ))}
    </nav>
  );
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
  const revoke = useMutation({
    mutationFn: () => api("POST", apiPath(API_ROUTES.hostRevoke, { hostId: host.id })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: hostsQuery.queryKey }),
  });
  const confirmRevoke = () => {
    if (window.confirm(TEXT.hosts.revokeConfirm(host.label))) {
      revoke.mutate();
    }
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

/** One host: how it runs, its containers, what waits to be updated, and what Autoheal may do there. */
export function HostPage() {
  const { hostId = "" } = useParams();
  const admin = isAdmin(useSignedInSession());
  // The host whose terminal is open: another host's page opens with none.
  const [terminalHost, setTerminalHost] = useState<string | null>(null);
  const [containersAsked, setContainersAsked] = useState(0);
  const hosts = useQuery(hostsQuery);
  const containers = useQuery({ ...hostContainersQuery(hostId), enabled: hostId !== "" });
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
      {isRunnerHost(host) && <RunnerBehind host={host} />}
      <HostTabs
        containers={host.containerCount}
        updates={waitingUpdates(host, containers.data ?? [])}
        docker={hasDocker}
        onContainers={() => setContainersAsked((asked) => asked + 1)}
      />
      <section id={HOST_SECTIONS.overview} className="host-section">
        <HostDials host={host} />
        <HostHistory host={host} />
        {host.health === null ? (
          <p className="muted">{TEXT.hosts.noReport}</p>
        ) : (
          <HostSystem host={host} health={host.health} />
        )}
        <HostOllamaFact hostId={host.id} />
        {admin && hasDocker && <HostProfileFold hostId={host.id} />}
        {admin && <ServiceProbes hostId={host.id} />}
      </section>
      {hasDocker && (
        <section id={HOST_SECTIONS.containers} className="host-section">
          <HostContainers host={host} admin={admin} containersAsked={containersAsked} />
          {enrolled && <HostImages host={host} admin={admin} />}
        </section>
      )}
      <section id={HOST_SECTIONS.updates} className="host-section">
        <HostUpdates host={host} admin={admin} />
      </section>
      {hasDocker && (
        <section id={HOST_SECTIONS.dependencies} className="host-section">
          <DependencyMap host={host} />
          {admin && (
            <p>
              <Link to={`${PATHS.backups}#application-plans`}>Application backup coverage and restore drills</Link>
            </p>
          )}
        </section>
      )}
      {enrolled && hasDocker && (
        <section id={HOST_SECTIONS.control} className="host-section">
          <HostControl host={host} admin={admin} />
        </section>
      )}
      <div className="host-more">
        <div className="split even">
          <HostTasks hostId={host.id} />
          <HostIncidents hostId={host.id} />
        </div>
        <HostChanges hostId={host.id} />
        {admin && enrolled && host.kind === HOST_KIND.ssh && <SshHostCard host={host} />}
        {admin && enrolled && isRunnerHost(host) && <SwitchToSsh host={host} />}
        {admin && enrolled && <RevokeHost host={host} />}
      </div>
    </div>
  );
}
