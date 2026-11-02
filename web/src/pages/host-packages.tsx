import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  API_ROUTES,
  apiPath,
  type AssessedPackageView,
  type HostPackagesView,
  type JobView,
  type LifecycleView,
  type RemovablePackageView,
} from "../../../src/shared/api.js";
import {
  APT_HISTORY,
  HOST_PACKAGE_COMMANDS,
  HOST_PACKAGE_MANAGER,
  HOST_KIND,
  HOST_PACKAGES,
  isChangingPackageAction,
  JOB_ACTION,
  JOB_STATUS,
  LIFECYCLE_STATUS,
  type ChangingPackageAction,
  type HostPackageAction,
  type HostPackageManager,
  type LifecycleStatus,
} from "../../../src/shared/constants.js";
import type { PackageChange } from "../../../src/shared/protocol.js";
import { api } from "../api-client.js";
import { LatestJob } from "../components/container-actions.js";
import { Badge, ErrorNotice, FollowedLog, Loading, PlainText, TimeAgo } from "../components/common.js";
import { Icon } from "../components/icons.js";
import { JOB_REFRESH_MILLISECONDS, REFRESH_MILLISECONDS, TEXT } from "../constants.js";
import { capitalized, day } from "../format.js";
import { hostPackagesQuery, hostsQuery } from "../queries.js";

const CHANGE_NAMES_SHOWN = 6;
const isWaiting = (job: JobView | null) =>
  job !== null && (job.status === JOB_STATUS.pending || job.status === JOB_STATUS.delivered);
// A runner from before dnf only knew apt.
const managerOf = (view: HostPackagesView) => view.facts?.manager ?? HOST_PACKAGE_MANAGER.apt;
const LIFECYCLE_NOTICES = {
  ending: "warning",
  extended: "warning",
  unsupported: "error",
} as const satisfies Record<Exclude<LifecycleStatus, typeof LIFECYCLE_STATUS.supported>, string>;

// The list follows a job on its way closely, and otherwise refreshes as the rest of the page does.
const useHostPackages = (hostId: string) =>
  useQuery({
    ...hostPackagesQuery(hostId),
    refetchInterval: (query) =>
      isWaiting(query.state.data?.running ?? null) ? JOB_REFRESH_MILLISECONDS : REFRESH_MILLISECONDS,
  });

function useHostPackageJob(hostId: string) {
  const queryClient = useQueryClient();
  const queryKey = hostPackagesQuery(hostId).queryKey;
  return useMutation({
    mutationKey: hostPackageJobKey(hostId),
    mutationFn: ({ action, names }: { action: HostPackageAction; names: readonly string[] }) =>
      api<JobView>("POST", apiPath(API_ROUTES.hostActions, { hostId }), { action, packages: names }),
    onSuccess: async (job) => {
      // Keep acceptance in the shared cache even if the submitting page has unmounted. An older
      // in-flight read must not erase it and reopen the controls before the next server observation.
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData<HostPackagesView>(queryKey, (view) =>
        view === undefined
          ? view
          : { ...view, running: job, recent: [job, ...view.recent.filter(({ id }) => id !== job.id)] },
      );
    },
    // A lost POST response can still mean the server accepted work. Refresh before releasing the
    // shared submission lock, on errors too; this retries observation, never the package action.
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });
}

export const hostPackageJobKey = (hostId: string) => ["host-package-job", hostId] as const;

/** Submission belongs to the host, not a mounted page; accepted work is followed from server state. */
export function useHostPackageBusy(hostId: string, view: HostPackagesView | undefined, statusUnavailable: boolean) {
  const submitting = useIsMutating({ mutationKey: hostPackageJobKey(hostId) }) > 0;
  return submitting || statusUnavailable || isWaiting(view?.running ?? null);
}

// Authority is separate from busy state: keep permitted controls visible, but disabled during work.
const reachable = (view: HostPackagesView) => view.facts !== null && view.facts.unsupported === null;
const mayCheck = (view: HostPackagesView, admin: boolean) =>
  admin && reachable(view) && view.facts?.setting !== HOST_PACKAGES.off;
const mayChange = (view: HostPackagesView, admin: boolean) =>
  mayCheck(view, admin) && view.facts?.setting === HOST_PACKAGES.apply;

/** The host says a reboot is needed, or names a package or a kernel that waits for one. */
const rebootWaitingOf = (view: HostPackagesView) =>
  view.rebootRequired ||
  (view.facts !== null && (view.facts.rebootPackages.length > 0 || view.facts.kernelWaiting !== null));

function whoOf(view: HostPackagesView, name: string): string {
  const { whoNames } = TEXT.hostPackages;
  if (view.automatic.includes(name)) {
    return whoNames.automatic;
  }
  return view.unattended.includes(name) ? whoNames.unattended[managerOf(view)] : whoNames.person;
}

// How long the release gets security fixes: a plain line while that is far off, a warning after.
function Lifecycle({ lifecycle }: { lifecycle: LifecycleView | null }) {
  if (lifecycle === null) {
    return null;
  }
  const { release, status, securityUntil, extendedUntil } = lifecycle;
  const until = status === LIFECYCLE_STATUS.extended ? extendedUntil : securityUntil;
  const text = TEXT.hostPackages.lifecycle[status](release, until === null ? null : day(until));
  if (status === LIFECYCLE_STATUS.supported) {
    return <p className="muted small">{text}</p>;
  }
  return <p className={`notice ${LIFECYCLE_NOTICES[status]}`}>{text}</p>;
}

/**
 * The reboot warning, where the host's page starts: what waits for a reboot, the reboot itself where the
 * host's .env allows it, and hiding the warning until the page is opened again.
 */
export function RebootWarning({ hostId, hostLabel, admin }: { hostId: string; hostLabel: string; admin: boolean }) {
  const packages = useHostPackages(hostId);
  const run = useHostPackageJob(hostId);
  const busy = useHostPackageBusy(hostId, packages.data, packages.isError);
  const [hidden, setHidden] = useState(false);
  const view = packages.data;
  if (view === undefined || hidden || !rebootWaitingOf(view)) {
    return null;
  }
  const reboot = () => {
    if (window.confirm(TEXT.hostPackages.confirmReboot(hostLabel))) {
      run.mutate({ action: JOB_ACTION.reboot, names: [] });
    }
  };
  const details = TEXT.hostPackages.rebootDetails(view.facts?.rebootPackages ?? [], view.facts?.kernelWaiting ?? null);
  // The last reboot asked for since the host's last check: on its way, or what the host said, a refusal included.
  const lastReboot = view.recent.find(
    (job) => job.action === JOB_ACTION.reboot && job.createdAt >= (view.checkedAt ?? 0),
  );
  const rebootLine = isWaiting(lastReboot ?? null) ? TEXT.hostPackages.running : lastReboot?.outcome;
  return (
    <div className="banner warning" role="status">
      <Icon name="alert" />
      <div className="banner-text">
        <p>{TEXT.hostPackages.rebootWarning}</p>
        {details !== "" && <p className="small muted">{details}</p>}
        {rebootLine !== undefined && rebootLine !== null && <p className="small">{rebootLine}</p>}
        <ErrorNotice error={run.error} />
      </div>
      <div className="banner-actions">
        {mayChange(view, admin) && (
          <button type="button" disabled={busy} onClick={reboot}>
            {TEXT.hostPackages.rebootNow}
          </button>
        )}
        <button type="button" className="quiet" onClick={() => setHidden(true)}>
          {TEXT.hostPackages.hideAlert}
        </button>
      </div>
    </div>
  );
}

interface Selection {
  disabled: boolean;
  isTicked: (name: string) => boolean;
  toggle: (name: string) => void;
}

/**
 * One package as drawn: a tick, its name and what it is, a security fix marked. Its name opens the
 * details under it: the new version, the one installed, where it comes from, and who installs it.
 */
function PackageRow({
  view,
  item,
  selection,
}: {
  view: HostPackagesView;
  item: AssessedPackageView;
  selection: Selection | null;
}) {
  const [open, setOpen] = useState(false);
  const text = TEXT.hostPackages;
  return (
    <li className="update-row">
      {selection === null ? (
        <span className="tick-space" />
      ) : (
        <input
          type="checkbox"
          disabled={selection.disabled}
          checked={selection.isTicked(item.name)}
          onChange={() => selection.toggle(item.name)}
          aria-label={text.selectOne(item.name)}
        />
      )}
      <span className="update-what">
        <button type="button" className="link mono" aria-expanded={open} onClick={() => setOpen(!open)}>
          {item.name}
        </button>
        <span className="small faint">{item.summary ?? TEXT.none}</span>
        {open && (
          <span className="package-details small">
            <span className="new-version">{text.newVersion(item.candidate)}</span>
            <span className="mono muted">{text.installedVersion(item.installed)}</span>
            <span className={item.security ? "security-source" : "muted"}>
              {item.source === null ? TEXT.none : capitalized(item.source)}
            </span>
            <span className="muted">{text.kindAndWho(text.kindNames[item.kind], whoOf(view, item.name))}</span>
          </span>
        )}
      </span>
      {item.held && <Badge value={text.held} tone="neutral" />}
      {item.security && <Badge value={text.security} tone="danger" />}
    </li>
  );
}

function PackageRows({
  view,
  packages,
  selection,
}: {
  view: HostPackagesView;
  packages: readonly AssessedPackageView[];
  selection: Selection | null;
}) {
  return (
    <ul className="update-rows">
      {packages.map((item) => (
        <PackageRow key={item.name} view={view} item={item} selection={selection} />
      ))}
    </ul>
  );
}

function Removable({
  packages,
  canRemove,
  busy,
  onRemove,
}: {
  packages: readonly RemovablePackageView[];
  canRemove: boolean;
  busy: boolean;
  onRemove: () => void;
}) {
  return (
    <details className="fold">
      <summary className="small">{TEXT.hostPackages.removable(packages.length)}</summary>
      <ul className="plain-list small">
        {packages.map(({ name, installed }) => (
          <li key={name} className="mono">
            {name} {installed}
          </li>
        ))}
      </ul>
      {canRemove && (
        <button type="button" disabled={busy} onClick={onRemove}>
          {TEXT.hostPackages.removeUnused(packages.length)}
        </button>
      )}
    </details>
  );
}

// The newest package job with what it printed; the ones before it, by what they did.
function RecentJobs({ jobs }: { jobs: readonly JobView[] }) {
  const [latest, ...earlier] = jobs;
  if (latest === undefined) {
    return null;
  }
  return (
    <div className="stack" aria-label={TEXT.hostPackages.recentJobs}>
      <LatestJob job={latest} />
      <ul className="plain-list small">
        {earlier.map((job) => (
          <li key={job.id} className="row">
            <Badge value={job.status} />
            <span>{TEXT.actions.names[job.action]}</span>
            <TimeAgo timestamp={job.completedAt ?? job.createdAt} />
            {job.outcome !== null && <span className="muted">{job.outcome}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function changeLine(change: PackageChange): string {
  const names = change.upgraded
    .slice(0, CHANGE_NAMES_SHOWN)
    .map(({ name, version }) => `${name} ${version}`)
    .join(", ");
  const parts = [
    change.upgradedCount === 0 ? "" : TEXT.hostPackages.upgraded(names, change.upgradedCount - CHANGE_NAMES_SHOWN),
    change.installed.length === 0 ? "" : TEXT.hostPackages.installed(change.installed.join(", ")),
    change.removed.length === 0 ? "" : TEXT.hostPackages.removed(change.removed.join(", ")),
  ];
  return parts.filter((part) => part !== "").join("; ");
}

function RecentChanges({ changes }: { changes: readonly PackageChange[] }) {
  return (
    <div className="stack">
      <h4 className="small muted">{TEXT.hostPackages.recentChanges}</h4>
      {changes.length === 0 && <p className="muted small">{TEXT.hostPackages.noChanges}</p>}
      <ul className="plain-list small">
        {changes.map((change) => (
          <li key={change.endedAt} className="row">
            <TimeAgo timestamp={change.endedAt} />
            <span className="muted">
              {change.byUnattendedUpgrades ? TEXT.hostPackages.changeBy.unattended : TEXT.hostPackages.changeBy.apt}
            </span>
            <span>{changeLine(change)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Exactly what the host runs for the job, as HOST_PACKAGE_COMMANDS has it.
function commandOf(action: ChangingPackageAction, manager: HostPackageManager, packages: readonly string[]): string {
  const commands = HOST_PACKAGE_COMMANDS[manager];
  if (action === JOB_ACTION.upgradePackages) {
    return commands.upgrade(packages).join(" ");
  }
  if (action === JOB_ACTION.autoremovePackages) {
    return commands.autoremove.join(" ");
  }
  return HOST_PACKAGE_COMMANDS.apt.repair.join(" ");
}

/**
 * A package job as it runs: what it does, the command, the package manager's own
 * output as it comes in, how it ended, and the check that follows it.
 */
function PackageRun({
  job,
  view,
  onBack,
}: {
  job: JobView & { action: ChangingPackageAction };
  view: HostPackagesView;
  onBack: () => void;
}) {
  const { run } = TEXT.hostPackages;
  const finished = !isWaiting(job);
  const refetch = finished
    ? view.recent.find(
        (other) => other.action === JOB_ACTION.checkPackages && other.createdAt >= (job.completedAt ?? Infinity),
      )
    : undefined;
  const output = job.output ?? (finished ? "" : run.waiting);
  return (
    <div className="stack" role="group" aria-label={run.title}>
      <p>{run.now[job.action](job.packages)}</p>
      {!finished && (
        <p className="muted small" role="status">
          {run.continues}
        </p>
      )}
      <p className="mono small muted">
        {run.command[job.action](commandOf(job.action, managerOf(view), job.packages))}
      </p>
      {finished ? (
        <PlainText text={output} className="log terminal" />
      ) : (
        <FollowedLog text={output} className="log terminal" />
      )}
      {finished && job.status === JOB_STATUS.succeeded && (
        <p>
          {run.done[job.action]} {job.outcome}
        </p>
      )}
      {finished && job.status !== JOB_STATUS.succeeded && (
        <p className="notice error">{run.failed(job.outcome ?? job.status)}</p>
      )}
      {refetch !== undefined && <p className="muted">{isWaiting(refetch) ? run.refetching : run.refetched}</p>}
      <div className="row">
        <button type="button" disabled={!finished} onClick={onBack}>
          {run.back}
        </button>
      </div>
    </div>
  );
}

const isChangingJob = (job: JobView | null | undefined): job is JobView & { action: ChangingPackageAction } =>
  job !== null && job !== undefined && isChangingPackageAction(job.action);

/** The card's first line: when the listed packages go in, and who puts them in. */
function packagesLine(view: HostPackagesView, overSsh: boolean): string {
  const { facts, window } = view;
  const text = TEXT.hostPackages;
  if (facts === null) {
    return text.noFacts;
  }
  if (facts.unsupported !== null) {
    return text.unsupported[facts.unsupported];
  }
  if (facts.setting !== HOST_PACKAGES.apply) {
    return overSsh ? text.allowedOverSsh[facts.setting] : text.allowed[facts.setting];
  }
  if (facts.unattendedUpgrades) {
    return text.unattended[managerOf(view)];
  }
  if (!window.securityInWindow) {
    return text.alwaysAsks;
  }
  const allTonight = view.packages.every((item) => view.automatic.includes(item.name));
  return allTonight
    ? text.inWindow(window.windowStart, window.windowEnd)
    : text.someWaitForYou(window.windowStart, window.windowEnd);
}

// When the list is from, and what it found; nothing where the host's .env keeps its packages off.
function CheckedLine({ view }: { view: HostPackagesView }) {
  if (view.facts === null || view.facts.setting === HOST_PACKAGES.off) {
    return null;
  }
  if (view.checkedAt === null) {
    const checking = view.running?.action === JOB_ACTION.checkPackages;
    return <p className="muted small">{checking ? TEXT.hostPackages.firstCheck : TEXT.hostPackages.notChecked}</p>;
  }
  return (
    <p className="small">
      <span className="muted">
        {TEXT.hostPackages.checked} <TimeAgo timestamp={view.checkedAt} />
        {TEXT.separator}
      </span>
      {view.packages.length === 0 ? TEXT.hostPackages.upToDate : TEXT.hostPackages.available(view.packages.length)}
    </p>
  );
}

/** One card's buttons, sent up to the bar the page keeps in view: whose they are, and how many they reach. */
export function UpdateActions({
  into,
  title,
  ticked,
  children,
}: {
  into: HTMLElement | null | undefined;
  title: string;
  ticked: number;
  children: ReactNode;
}) {
  if (into === null || into === undefined) return null;
  return createPortal(
    <span className="action-group">
      <strong>{title}</strong>
      <span className="muted">{TEXT.hostContainers.bulk.ticked(ticked)}</span>
      {children}
    </span>,
    into,
  );
}

/**
 * A host's own packages, as drawn: when they go in, each one ticked to begin with, and the way to put the
 * ticked ones in now. The details stay a click away: a package's versions, what is kept back or no
 * longer needed, a run as a terminal shows it, and what changed this week. The host's runner has the last
 * word on every job.
 */
export function HostPackages({
  hostId,
  admin,
  actionsIn,
}: {
  hostId: string;
  admin: boolean;
  // Where the install button goes when a page keeps its buttons in a bar; without one it stays on the card's foot.
  actionsIn?: HTMLElement | null;
}) {
  const packages = useHostPackages(hostId);
  // Where its package setting lives: a runner's .env, or an SSH host's own card.
  const overSsh = useQuery(hostsQuery).data?.find((host) => host.id === hostId)?.kind === HOST_KIND.ssh;
  const run = useHostPackageJob(hostId);
  const busy = useHostPackageBusy(hostId, packages.data, packages.isError);
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [followed, setFollowed] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const running = packages.data?.running ?? null;
  // A run that changes packages is followed as it goes, whoever asked for it, until the person goes back.
  const runningChange = isChangingJob(running) ? running.id : null;
  useEffect(() => {
    if (runningChange !== null) {
      setFollowed(runningChange);
    }
  }, [runningChange]);
  const view = packages.data;
  if (view === undefined) {
    return packages.error ? <ErrorNotice error={packages.error} /> : <Loading />;
  }
  const text = TEXT.hostPackages;
  const ask = (action: HostPackageAction, names: readonly string[]) => {
    if (busy) return;
    run.mutate(
      { action, names },
      { onSuccess: (job) => setFollowed(isChangingPackageAction(job.action) ? job.id : null) },
    );
  };
  // Just asked for: the job the request answered with, until the list has it.
  const followedJob = view.recent.find((job) => job.id === followed) ?? (run.data?.id === followed ? run.data : null);
  const canChange = mayChange(view, admin);
  const selected = view.packages.map(({ name }) => name).filter((name) => !unticked.has(name));
  const selection: Selection | null =
    canChange && view.packages.length > 0
      ? {
          disabled: busy,
          isTicked: (name) => !unticked.has(name),
          toggle: (name) =>
            setUnticked(
              unticked.has(name)
                ? new Set([...unticked].filter((other) => other !== name))
                : new Set([...unticked, name]),
            ),
        }
      : null;
  const removeUnused = () => {
    const lines = view.removable.map(({ name, installed }) => `${name} ${installed}`);
    if (window.confirm(text.confirmRemove(lines))) {
      ask(JOB_ACTION.autoremovePackages, []);
    }
  };
  const tonight = selected.every((name) => view.automatic.includes(name));
  const install = selection !== null && (
    <button
      type="button"
      disabled={busy || selected.length === 0}
      onClick={() => ask(JOB_ACTION.upgradePackages, selected)}
    >
      {tonight ? text.installNowInstead : text.installNow}
    </button>
  );
  return (
    <section className="card update-card" aria-labelledby="host-packages-title">
      <div className="update-card-body">
        <h3 id="host-packages-title">{text.title}</h3>
        <p className="update-card-line">{packagesLine(view, overSsh)}</p>
        {view.lifecycle !== null && view.lifecycle.status !== LIFECYCLE_STATUS.supported && (
          <Lifecycle lifecycle={view.lifecycle} />
        )}
        {view.needsRepair && (
          <div className="notice warning row spread">
            <span>{text.needsRepair}</span>
            {canChange && (
              <button type="button" disabled={busy} onClick={() => ask(JOB_ACTION.repairPackages, [])}>
                {text.repair}
              </button>
            )}
          </div>
        )}
        {view.refreshProblem !== null && <p className="notice warning">{text.notRefreshed(view.refreshProblem)}</p>}
        {isChangingJob(followedJob) ? (
          <PackageRun job={followedJob} view={view} onBack={() => setFollowed(null)} />
        ) : (
          <PackageRows view={view} packages={view.packages} selection={selection} />
        )}
        {view.packages.length === 0 && !isChangingJob(followedJob) && <CheckedLine view={view} />}
        {view.keptBack.length > 0 && (
          <details className="fold">
            <summary className="small">{text.keptBack(view.keptBack.length)}</summary>
            <PackageRows view={view} packages={view.keptBack} selection={null} />
          </details>
        )}
        {view.removable.length > 0 && (
          <Removable packages={view.removable} canRemove={canChange} busy={busy} onRemove={removeUnused} />
        )}
        {isWaiting(view.running) && <p className="muted small">{text.running}</p>}
        {history && (
          <div className="package-history stack">
            {view.packages.length > 0 && <CheckedLine view={view} />}
            {view.lifecycle?.status === LIFECYCLE_STATUS.supported && <Lifecycle lifecycle={view.lifecycle} />}
            <RecentJobs jobs={view.recent} />
            {view.facts !== null && managerOf(view) === HOST_PACKAGE_MANAGER.apt && (
              <RecentChanges changes={view.facts.recentChanges.slice(0, APT_HISTORY.entries)} />
            )}
          </div>
        )}
      </div>
      {install !== false && (
        <UpdateActions into={actionsIn} title={text.title} ticked={selected.length}>
          {install}
        </UpdateActions>
      )}
      <footer className="update-card-foot">
        {actionsIn === undefined && install}
        <button type="button" className="link" aria-expanded={history} onClick={() => setHistory(!history)}>
          {text.whatChanged}
        </button>
      </footer>
      <ErrorNotice error={run.error ?? packages.error} />
    </section>
  );
}
