import { useState } from "react";
import {
  type AssessedPackageView,
  type HostPackagesView,
  type JobView,
  type RemovablePackageView,
} from "../../../src/shared/api.js";
import {
  HOST_PACKAGE_COMMANDS,
  HOST_PACKAGE_MANAGER,
  JOB_ACTION,
  JOB_STATUS,
  type ChangingPackageAction,
  type HostPackageManager,
} from "../../../src/shared/constants.js";
import type { PackageChange } from "../../../src/shared/protocol.js";
import { LatestJob } from "../components/container-actions.js";
import { Badge, FollowedLog, PlainText, TimeAgo } from "../components/common.js";
import { TEXT } from "../constants.js";
import { capitalized } from "../format.js";

const CHANGE_NAMES_SHOWN = 6;

export const isWaiting = (job: JobView | null) =>
  job !== null && (job.status === JOB_STATUS.pending || job.status === JOB_STATUS.delivered);

// A runner from before dnf only knew apt.
export const managerOf = (view: HostPackagesView) => view.facts?.manager ?? HOST_PACKAGE_MANAGER.apt;

function whoOf(view: HostPackagesView, name: string): string {
  const { whoNames } = TEXT.hostPackages;
  if (view.automatic.includes(name)) {
    return whoNames.automatic;
  }
  return view.unattended.includes(name) ? whoNames.unattended[managerOf(view)] : whoNames.person;
}

export interface Selection {
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

export function PackageRows({
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

export function Removable({
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
export function RecentJobs({ jobs }: { jobs: readonly JobView[] }) {
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

export function RecentChanges({ changes }: { changes: readonly PackageChange[] }) {
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
export function PackageRun({
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
