import { BACKUP_DIALOG, BackupDialog, type BackupDialogMode } from "./container-backup.js";
import { ComposePanel } from "../components/compose-panel.js";
import { HostNetworks, LeftBehindOffer, NetworksChip, NetworksHeading } from "./host-networks.js";
import { HostVolumes, VolumesChip, VolumesHeading, VolumesLeftOffer } from "./host-volumes.js";
import { OperationImpactReview } from "../components/dependency-map.js";
import { UpdateConfirm } from "../components/update-confirm.js";
import { actionPermission, type ResourceAction } from "../../../src/shared/resource-permissions.js";
import { useResourcePermissions } from "../session.js";
import { MaintenanceBadge, MaintenanceDialog } from "../components/maintenance-dialog.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  API_ROUTES,
  apiPath,
  hasUpdate,
  updateVersions,
  type ContainerControlChange,
  type ContainerControlView,
  type ContainerView,
  type HostControlChange,
  type HostControlView,
  type HostView,
  type JobView,
  type TaskSummaryView,
} from "../../../src/shared/api.js";
import {
  CONTAINER_HEALTH_NONE,
  CONTAINER_STATE_PAUSED,
  HOST_STATE,
  MILLISECONDS_PER_SECOND,
  CONTAINER_STATE_RUNNING,
  CONTROL_LOCK,
  HANDS_OFF,
  HOST_RESTART_CHOICES,
  HOST_SECTIONS,
  HOST_UPDATE_CHOICES,
  IMAGE_CLEANUP,
  IMAGE_CLEANUPS,
  JOB_ACTION,
  MAX_RESTARTS_PER_WINDOW,
  PORT_PROTOCOL,
  RESTART_CHOICES,
  TASK_LABEL,
  TASK_RESOURCE,
  UPDATE_CHOICE,
  UPDATE_CHOICES,
  UPDATE_POLICY,
  UPDATE_STATUS,
  wordsOf,
  type ImageCleanup,
  type RestartChoice,
  type UpdateChoice,
  HOST_KIND,
} from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { goesAhead } from "../ask-first.js";
import { ChoiceCard, choicesOf } from "../components/choice-card.js";
import { ErrorNotice, Loading, TimeAgo } from "../components/common.js";
import { WebLink, isWaiting } from "../components/container-actions.js";
import { UpdateStream, phaseWords } from "../components/update-stream.js";
import { ContainerFiles } from "../components/container-files.js";
import { ContainerSettingsEditor } from "../components/container-settings.js";
import {
  BULK_ACTIONS,
  isStopped,
  targetsOf,
  useBulkAction,
  type BulkAction,
  type BulkAsked,
  type RowAction,
  type progressOf,
} from "../container-bulk.js";
import { useContainerSelection } from "../components/filters.js";
import { Icon, type IconName } from "../components/icons.js";
import { bringUnderListHeader, useContainerMotion, workOf, type WorkingJob } from "../container-motion.js";
import {
  ASSIGNEE_KINDS,
  CONTAINER_SHOW,
  CONTAINER_SHOWS,
  INVENTORY_REFRESH_MILLISECONDS,
  RESET_HEARD_MILLISECONDS,
  MOTION,
  PATHS,
  SAVED_NOTE_MILLISECONDS,
  TEXT,
  type ContainerShow,
  type Motion,
} from "../constants.js";
import { bytes, dateTime, dayIn, decimal, duration, precisePercent, timeOfDay } from "../format.js";
import { hostContainersQuery, hostJobsQuery, hostTasksQuery } from "../queries.js";
import { StackHead } from "../components/stack-head.js";
import { updateRunQuery, waitInRun } from "../update-runs.js";
import { AddContainer } from "./add-container.js";
import { ContainerInspector, type InspectorTabRequest } from "./host-stats.js";

// The terminal and xterm.js load when a shell first opens: most visits never need them.
const ContainerTerminal = lazy(() =>
  import("../components/shell-terminal.js").then((module) => ({ default: module.ContainerTerminal })),
);

// Container, state, image, ports, CPU, RAM and the two choices, and an admin's ticks and actions: an opened row's stats
// span them all.
const COLUMN_COUNT = 9;
const ADMIN_COLUMN_COUNT = COLUMN_COUNT + 2;
// Ports beyond these show as "+2", all of them in its tooltip: two keep a row one line high.
const PORTS_SHOWN = 2;

const hostControlQuery = (hostId: string) => ({
  queryKey: ["host-control", hostId],
  queryFn: () => api<HostControlView>("GET", apiPath(API_ROUTES.hostControl, { hostId })),
});

const byName = (first: ContainerView, second: ContainerView) => first.name.localeCompare(second.name);

/** "Saved", for a moment after a setting changed in place. */
export function useSavedNote() {
  const [shown, setShown] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const show = () => {
    setShown(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setShown(false), SAVED_NOTE_MILLISECONDS);
  };
  return { shown, show };
}

export function SavedNote({ shown }: { shown: boolean }) {
  return shown ? (
    <span role="status" className="small saved-note">
      {TEXT.hostControl.saved}
    </span>
  ) : null;
}

// When the next clean-up runs, or why none comes.
function cleanupLine(view: HostControlView, host: HostView): string {
  const text = TEXT.hostControl;
  if (view.imageCleanup === IMAGE_CLEANUP.off) {
    return text.never;
  }
  if (host.dryRun !== false) {
    return text.watchOnly;
  }
  return view.nextCleanupAt === null
    ? text.keeps
    : `${text.nextRun(dayIn(view.nextCleanupAt, view.timeZone))} ${text.keeps}`;
}

function LastCleanup({ job }: { job: JobView | null }) {
  if (job === null) {
    return null;
  }
  return (
    <p className="muted small">
      {TEXT.hostControl.last} <TimeAgo timestamp={job.completedAt ?? job.createdAt} />
      {TEXT.separator}
      {isWaiting(job) ? TEXT.actions.waiting : job.outcome}
    </p>
  );
}

/**
 * What Autoheal may do on a host besides what a container is set to on its own: when one dies, when a
 * new image is out, and when the images no container uses are removed. The host's .env has the last word.
 */
export function HostControl({ host, admin }: { host: HostView; admin: boolean }) {
  const queryClient = useQueryClient();
  const control = useQuery(hostControlQuery(host.id));
  const saved = useSavedNote();
  const save = useMutation({
    mutationFn: (change: HostControlChange) =>
      api<HostControlView>("PUT", apiPath(API_ROUTES.hostControl, { hostId: host.id }), change),
    onSuccess: (view) => {
      queryClient.setQueryData(hostControlQuery(host.id).queryKey, view);
      // A container without its own choice follows the host's.
      void queryClient.invalidateQueries({ queryKey: ["containers"] });
      saved.show();
    },
  });
  const view = control.data;
  const text = TEXT.hostControl;
  if (view === undefined) {
    return control.error ? <ErrorNotice error={control.error} /> : <Loading />;
  }
  return (
    <section className="host-control" aria-labelledby="host-control-title">
      <header className="section-head">
        <h2 id="host-control-title">{text.title(host.label)}</h2>
        <SavedNote shown={saved.shown} />
      </header>
      {host.dryRun !== false && <p className="notice warning">{host.dryRun === null ? text.unknown : text.watching}</p>}
      {admin && (
        <p>
          <Link to={`${PATHS.replays}?hostId=${encodeURIComponent(host.id)}#policy-rehearsal`}>
            Rehearse recovery policy
          </Link>
        </p>
      )}
      <MaintenanceDialog hostId={host.id} admin={admin} />
      <div className="choice-cards">
        <ChoiceCard
          title={text.restartTitle}
          name={`restart-${host.id}`}
          choices={choicesOf(HOST_RESTART_CHOICES, text.restartChoices)}
          chosen={view.restartDefault}
          disabled={!admin}
          onChoose={(restartDefault) => save.mutate({ restartDefault })}
        />
        <ChoiceCard
          title={text.updateTitle}
          name={`update-${host.id}`}
          choices={choicesOf(HOST_UPDATE_CHOICES, text.updateChoices)}
          chosen={view.updateDefault}
          disabled={!admin}
          onChoose={(updateDefault) => save.mutate({ updateDefault })}
        />
        <section className="card choice-card">
          <h3>{text.cleanupTitle}</h3>
          <label className="cleanup-often">
            {text.howOften}
            <select
              value={view.imageCleanup}
              disabled={!admin}
              onChange={(event) => save.mutate({ imageCleanup: event.target.value as ImageCleanup })}
            >
              {IMAGE_CLEANUPS.map((choice) => (
                <option key={choice} value={choice}>
                  {text.cleanups[choice]}
                </option>
              ))}
            </select>
          </label>
          {view.imageCleanup !== IMAGE_CLEANUP.off && (
            <label className="choice-option build-cache">
              <input
                type="checkbox"
                checked={view.clearBuildCache}
                disabled={!admin}
                onChange={(event) => save.mutate({ clearBuildCache: event.target.checked })}
              />
              <span className="choice-words">{text.buildCache}</span>
            </label>
          )}
          {view.imageCleanup !== IMAGE_CLEANUP.off && (
            <label className="choice-option build-cache" title={text.leftNetworksNote}>
              <input
                type="checkbox"
                checked={view.clearLeftNetworks}
                disabled={!admin}
                onChange={(event) => save.mutate({ clearLeftNetworks: event.target.checked })}
              />
              <span className="choice-words">{text.leftNetworks}</span>
            </label>
          )}
          <p className="small faint cleanup-line">{cleanupLine(view, host)}</p>
          <LastCleanup job={view.lastCleanup} />
        </section>
      </div>
      <ErrorNotice error={save.error} />
    </section>
  );
}

// --- the host's containers, each with what it does when it fails and when a new image is out --------

interface Group {
  // The compose project of two or more containers here; null for the ones that stand alone.
  stack: string | null;
  containers: ContainerView[];
}

// What needs a look first: a problem, then an update waiting, then by name.
const attentionOf = (container: ContainerView) => {
  if (container.problem !== null) {
    return 0;
  }
  return hasUpdate(container) ? 1 : 2;
};
const byAttention = (first: ContainerView, second: ContainerView) =>
  attentionOf(first) - attentionOf(second) || byName(first, second);

function groupsOf(containers: readonly ContainerView[]): Group[] {
  const byProject = new Map<string, ContainerView[]>();
  for (const container of containers) {
    if (container.composeProject !== null) {
      byProject.set(container.composeProject, [...(byProject.get(container.composeProject) ?? []), container]);
    }
  }
  const stacks = [...byProject.entries()]
    .filter(([, members]) => members.length > 1)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([stack, members]) => ({ stack, containers: [...members].sort(byAttention) }));
  const inStacks = new Set(stacks.flatMap((group) => group.containers.map((container) => container.name)));
  const alone = containers.filter((container) => !inStacks.has(container.name)).sort(byAttention);
  return alone.length === 0 ? stacks : [...stacks, { stack: null, containers: alone }];
}

const matches = (container: ContainerView, words: string) =>
  container.name.toLowerCase().includes(words) || container.image.toLowerCase().includes(words);

/** A container's state in words: its run state, its health check, and any problem. */
export function stateOf(container: ContainerView): string {
  const parts = [
    container.state,
    container.health === CONTAINER_HEALTH_NONE ? null : container.health,
    container.problem,
  ];
  return parts
    .filter((part) => part !== null)
    .map((part) => wordsOf(part))
    .join(TEXT.separator);
}

// Running reads green and a problem red, as the host page draws them; anything else stays quiet.
export const stateTone = (container: ContainerView) => {
  if (container.problem !== null) {
    return "text-danger";
  }
  return container.state === CONTAINER_STATE_RUNNING ? "text-good" : "muted";
};

// A moment still to come, or null: a time that has passed says nothing now.
const ahead = (at: number | null | undefined) => (at !== null && at !== undefined && at > Date.now() ? at : null);

// What a container's line says: Autoheal's restarts this hour, then when it may act on the container again.
function restartLine(used: number, againAt: number | null, looksAgainAt: number | null): string[] {
  const text = TEXT.hostContainers;
  if (used === 0) {
    return looksAgainAt === null ? [] : [text.looksAgainAlone(timeOfDay(looksAgainAt))];
  }
  if (againAt !== null) {
    return [text.restartsUsed(used), text.againFrom(timeOfDay(againAt))];
  }
  if (looksAgainAt !== null) {
    return [text.restartsUsed(used), text.looksAgain(timeOfDay(looksAgainAt))];
  }
  return [text.restartsUsed(used)];
}

// Autoheal's own restarts this hour, not Docker's, and when it may act again: once all are used, its next failure goes
// to a person, unless an admin resets them. Only a runner that reports its waits takes a reset.
function RestartsUsed({ host, name, admin }: { host: HostView; name: string; admin: boolean }) {
  const queryClient = useQueryClient();
  const reset = useMutation({
    mutationFn: () => api<void>("POST", apiPath(API_ROUTES.restartsReset, { hostId: host.id, containerName: name })),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["hosts"] }),
  });
  const used = host.restartBudget[name] ?? 0;
  const wait = host.restartWait?.[name];
  const line = restartLine(used, ahead(wait?.againAt), ahead(wait?.looksAgainAt));
  if (line.length === 0) {
    return null;
  }
  const spent = used >= MAX_RESTARTS_PER_WINDOW;
  const askedAt = Math.max(host.restartResets?.[name] ?? 0, reset.isSuccess ? reset.submittedAt : 0);
  const asked = Date.now() - askedAt < RESET_HEARD_MILLISECONDS;
  const canReset = admin && spent && Boolean(host.restartWait);
  return (
    <div className={spent ? "restarts-used text-warning" : "restarts-used muted"}>
      {line.join(TEXT.separator)}
      {canReset && asked && <span className="muted">{`${TEXT.separator}${TEXT.hostContainers.resetAsked}`}</span>}
      {canReset && !asked && (
        <button
          type="button"
          className="quiet restarts-reset"
          aria-label={TEXT.hostContainers.resetLabel(name)}
          disabled={reset.isPending}
          onClick={() => reset.mutate()}
        >
          {TEXT.hostContainers.reset}
        </button>
      )}
      <ErrorNotice error={reset.error} />
    </div>
  );
}

// Autoheal applies these new images by itself, unless it gave one to a person.
const APPLIED_BY_AUTOHEAL: ReadonlySet<string> = new Set([UPDATE_CHOICE.apply, UPDATE_CHOICE.always]);

// An image update a person has: Autoheal held it back, or a failed one came back to them.
const isPersonsUpdate = (task: TaskSummaryView) =>
  task.labels.includes(TASK_LABEL.update) &&
  task.resource?.kind === TASK_RESOURCE.container &&
  task.assignee?.kind === ASSIGNEE_KINDS.user;

function ImageCell({ container, held }: { container: ContainerView; held: TaskSummaryView | undefined }) {
  const { status, policy, reason } = container.update;
  const text = TEXT.hostContainers;
  if (policy === UPDATE_POLICY.off) {
    return <span className="muted">{text.updatesOff}</span>;
  }
  if (status === null) {
    return <span className="muted">{text.notChecked}</span>;
  }
  if (status === UPDATE_STATUS.unknown) {
    return (
      <>
        <span className="muted">{text.unknown}</span>
        {reason !== null && (
          <div className="check-reason muted" title={reason}>
            {reason}
          </div>
        )}
      </>
    );
  }
  if (!hasUpdate(container)) {
    return <span className="muted">{text.upToDate}</span>;
  }
  const byAutoheal = APPLIED_BY_AUTOHEAL.has(container.byItself.update) && container.handsOff === null;
  if (byAutoheal && held !== undefined) {
    return <Link to={apiPath(PATHS.task, { taskId: held.id })}>{text.held}</Link>;
  }
  if (byAutoheal) {
    return <span className="muted">{text.soon}</span>;
  }
  const versions = updateVersions(container);
  const label = versions === null ? text.updateReady : TEXT.updates.versions(versions.from, versions.to);
  if (container.handsOff === HANDS_OFF.dryRun) {
    return (
      <>
        <span className="muted">{label}</span>
        <div className="check-reason muted" title={TEXT.actions.handsOff.dry_run(container.hostLabel)}>
          {text.updateWatching}
        </div>
      </>
    );
  }
  return <a href={`#${HOST_SECTIONS.updates}`}>{label}</a>;
}

// Protected or kept aside, nothing may be set: one line across both choices says why.
const SPANNING_LOCKS: ReadonlySet<string> = new Set([CONTROL_LOCK.protected, CONTROL_LOCK.parked]);

function ChoiceCells({
  container,
  canAct,
  onChange,
}: {
  container: ContainerView;
  canAct: boolean;
  onChange: (change: Omit<ContainerControlChange, "names">) => void;
}) {
  const text = TEXT.hostContainers;
  const { restartLock, updateLock } = container.byItself;
  if (restartLock !== null && SPANNING_LOCKS.has(restartLock)) {
    return (
      <td colSpan={2} className="locked">
        <Icon name="lock" />
        {text.locks[restartLock]}
      </td>
    );
  }
  return (
    <>
      <td>
        <select
          aria-label={text.restartOf(container.name)}
          value={container.byItself.restart}
          disabled={!canAct}
          onChange={(event) => onChange({ restart: event.target.value as RestartChoice })}
        >
          {RESTART_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {text.restartChoices[choice]}
            </option>
          ))}
        </select>
      </td>
      <td>
        {updateLock === null ? (
          <select
            aria-label={text.updateOf(container.name)}
            value={container.byItself.update}
            disabled={!canAct}
            onChange={(event) => onChange({ update: event.target.value as UpdateChoice })}
          >
            {UPDATE_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {text.updateChoices[choice]}
              </option>
            ))}
          </select>
        ) : (
          <span className="muted small">{text.locks[updateLock]}</span>
        )}
      </td>
    </>
  );
}

// --- the ticked containers, and what may be asked of them at once ---------------------------------------

const BULK_TEXT = TEXT.hostContainers.bulk;

type Bulk = ReturnType<typeof useBulkAction>;
type Ask = (action: RowAction, targets: ContainerView[]) => void;

const toggled = (names: ReadonlySet<string>, name: string) =>
  names.has(name) ? new Set([...names].filter((other) => other !== name)) : new Set([...names, name]);

// How the last bulk action went: in a line while its jobs run, then with what failed and why.
function BulkProgress({ asked, progress }: { asked: BulkAsked; progress: ReturnType<typeof progressOf> }) {
  const label = TEXT.actions.names[asked.action];
  if (asked.action === JOB_ACTION.update) {
    return <span className="small muted">{BULK_TEXT.updating(asked.total)}</span>;
  }
  const line =
    progress.waiting > 0
      ? BULK_TEXT.going(label, asked.jobIds.length - progress.waiting, asked.jobIds.length)
      : BULK_TEXT.finished(label, progress.succeeded, asked.total);
  return (
    <span className="bulk-progress small" role="status">
      <span className="muted">{line}</span>
      {progress.failed.map((job) => (
        <span key={job.id} className="text-danger">
          {job.outcome ?? job.containerName}
        </span>
      ))}
      <ErrorNotice error={asked.refusal} />
    </span>
  );
}

/** Above the table: what the ticked containers can be asked, each action counting the ones it reaches. */
function BulkBar({
  hostId,
  ticked,
  bulk,
  ask,
  onClear,
  onLookAtVolumes,
}: {
  hostId: string;
  ticked: ContainerView[];
  bulk: Bulk;
  ask: Ask;
  onClear: () => void;
  onLookAtVolumes: () => void;
}) {
  const { run, asked, progress } = bulk;
  return (
    <div className={ticked.length > 0 ? "bulk-bar action-bar" : "bulk-bar"} role="group" aria-label={BULK_TEXT.label}>
      {ticked.length === 0 ? (
        <span className="muted">{BULK_TEXT.hint}</span>
      ) : (
        <>
          <span>{BULK_TEXT.ticked(ticked.length)}</span>
          <button type="button" className="quiet" onClick={onClear}>
            {BULK_TEXT.clear}
          </button>
          {BULK_ACTIONS.map((action) => ({ action, targets: targetsOf(action, ticked) }))
            .filter(({ targets }) => targets.length > 0)
            .map(({ action, targets }) => (
              <button
                key={action}
                type="button"
                className={action === JOB_ACTION.remove ? "danger" : undefined}
                disabled={run.isPending}
                onClick={() => ask(action, targets)}
              >
                {BULK_TEXT.buttons[action](targets.length)}
              </button>
            ))}
        </>
      )}
      {asked !== null && <BulkProgress asked={asked} progress={progress} />}
      {asked?.action === JOB_ACTION.remove && progress.waiting === 0 && (
        <>
          <LeftBehindOffer key={asked.jobIds.join()} hostId={hostId} projects={asked.projects} />
          <VolumesLeftOffer
            key={`${asked.jobIds.join()}-volumes`}
            hostId={hostId}
            projects={asked.projects}
            names={asked.volumes}
            onLook={onLookAtVolumes}
          />
        </>
      )}
      <ErrorNotice error={run.error} />
    </div>
  );
}

// --- each row's own buttons, and its ports -------------------------------------------------------------

// The row's buttons in order; one that does not fit the container is shown, but off.
function rowActionsOf(container: ContainerView): { action: BulkAction | typeof JOB_ACTION.rollBack; icon: IconName }[] {
  if (container.recovery !== undefined)
    return container.recovery.owner === container.name ? [{ action: JOB_ACTION.rollBack, icon: "rotateCw" }] : [];
  const paused = container.state === CONTAINER_STATE_PAUSED;
  return [
    { action: JOB_ACTION.restart, icon: "rotateCw" },
    paused ? { action: JOB_ACTION.unpause, icon: "play" } : { action: JOB_ACTION.pause, icon: "pause" },
    isStopped(container) ? { action: JOB_ACTION.start, icon: "play" } : { action: JOB_ACTION.stop, icon: "square" },
    { action: JOB_ACTION.remove, icon: "trash" },
  ];
}

// What opens under a row to reach inside its container: a shell, or its files. One at a time on the page.
const REACH = { shell: "shell", files: "files", settings: "settings", compose: "compose" } as const;
type Reach = (typeof REACH)[keyof typeof REACH];

// Why a row's shell, files or settings are off: the host's .env, the host's rules, or, for a shell and files,
// nothing running to reach into. Settings stay open on a stopped container: a wrong one may be why it stopped.
function reachRefusal(host: HostView, container: ContainerView, needsRunning: boolean): string | null {
  if (!host.containerAccess) {
    return TEXT.hostContainers.reachOff;
  }
  if (container.handsOff !== null) {
    return TEXT.actions.handsOff[container.handsOff](host.label);
  }
  if (needsRunning && container.state !== CONTAINER_STATE_RUNNING) {
    return TEXT.hostContainers.reachStopped(container.name);
  }
  return null;
}

const permissionOf = (reach: Reach): ResourceAction => {
  if (reach === REACH.shell) return "terminal";
  return reach === REACH.compose ? "settings" : reach;
};

// What opens under a row to reach inside its container.
function ReachPanel({
  reach,
  hostId,
  containerName,
  composeProject,
  keptByHost,
  onClose,
}: {
  reach: Reach;
  hostId: string;
  containerName: string;
  composeProject: string | null;
  keptByHost: boolean;
  onClose: () => void;
}) {
  if (reach === REACH.compose && composeProject !== null) {
    return <ComposePanel hostId={hostId} project={composeProject} readOnly={keptByHost} onClose={onClose} />;
  }
  if (reach === REACH.shell) {
    return (
      <Suspense fallback={<Loading />}>
        <ContainerTerminal hostId={hostId} containerName={containerName} onClose={onClose} />
      </Suspense>
    );
  }
  if (reach === REACH.files) {
    return <ContainerFiles hostId={hostId} containerName={containerName} onClose={onClose} />;
  }
  return <ContainerSettingsEditor hostId={hostId} containerName={containerName} onClose={onClose} />;
}

// Under its row: the shell and settings the icons on the row open, by name.
function PanelReach({
  host,
  container,
  reaching,
  files,
  onReach,
  allowed,
}: {
  host: HostView;
  container: ContainerView;
  reaching: Reach | null;
  files: ReactNode;
  onReach: (reach: Reach) => void;
  allowed: (action: ResourceAction) => boolean;
}) {
  const text = TEXT.containerDetails;
  const button = (reach: Reach, icon: IconName, label: string) => {
    if (!allowed(permissionOf(reach))) return null;
    const refusal = reachRefusal(host, container, reach !== REACH.settings);
    return (
      <button
        type="button"
        title={refusal ?? undefined}
        aria-pressed={reaching === reach}
        disabled={(refusal !== null && reaching !== reach) || container.recovery !== undefined}
        onClick={() => onReach(reach)}
      >
        <Icon name={icon} />
        {label}
      </button>
    );
  };
  return (
    <>
      {button(REACH.shell, "terminal", text.terminal)}
      {files}
      {button(REACH.settings, "pencil", text.editSettings)}
    </>
  );
}

function RowActions({
  host,
  container,
  open,
  reaching,
  busy,
  ask,
  onToggle,
  onLogs,
  onReach,
  allowed,
  admin,
  onBackup,
}: {
  admin: boolean;
  onBackup: (mode: BackupDialogMode) => void;
  host: HostView;
  container: ContainerView;
  open: boolean;
  reaching: Reach | null;
  busy: boolean;
  ask: Ask;
  onToggle: () => void;
  onLogs: () => void;
  onReach: (reach: Reach) => void;
  allowed: (action: ResourceAction) => boolean;
}) {
  const text = TEXT.hostContainers;
  // Read only where the host keeps it to itself, so unlike the others it stays open then.
  const composeRefusal = () => {
    if (container.composeProject === null) return TEXT.stacks.noCompose;
    return host.containerAccess === false ? text.reachOff : null;
  };
  const composeLabel = TEXT.stacks.labels.compose(container.composeProject ?? container.name);
  const composeButton = allowed("settings") && (
    <button
      type="button"
      className="icon-button"
      title={composeRefusal() ?? composeLabel}
      aria-label={composeLabel}
      aria-pressed={reaching === REACH.compose}
      disabled={composeRefusal() !== null && reaching !== REACH.compose}
      onClick={() => onReach(REACH.compose)}
    >
      <Icon name="file" />
    </button>
  );
  const reachButton = (reach: Reach, icon: IconName, label: string) => {
    if (!allowed(permissionOf(reach))) return null;
    const refusal = reachRefusal(host, container, reach !== REACH.settings);
    return (
      <button
        type="button"
        className="icon-button"
        title={refusal ?? label}
        aria-label={label}
        aria-pressed={reaching === reach}
        disabled={(refusal !== null && reaching !== reach) || container.recovery !== undefined}
        onClick={() => onReach(reach)}
      >
        <Icon name={icon} />
      </button>
    );
  };
  const button = (action: RowAction, icon: IconName, enabled: boolean, onClick: () => void) => {
    const permission = actionPermission(action);
    if (permission === null || !allowed(permission)) return null;
    return (
      <button
        key={action}
        type="button"
        className={action === JOB_ACTION.remove ? "icon-button danger" : "icon-button"}
        title={TEXT.actions.names[action]}
        aria-label={text.rowAction(TEXT.actions.names[action], container.name)}
        disabled={busy || !enabled}
        onClick={onClick}
      >
        <Icon name={icon} />
      </button>
    );
  };
  // Its logs have a tab under the row, which reads them as it opens.
  const readLogs = () => {
    onLogs();
    if (!open) {
      onToggle();
    }
  };
  return (
    <span className="row-actions-icons" role="group" aria-label={TEXT.actions.label(container.name)}>
      {button(JOB_ACTION.logs, "fileText", true, readLogs)}
      {reachButton(REACH.shell, "terminal", text.shell(container.name))}
      {reachButton(REACH.files, "folder", text.files(container.name))}
      <button
        type="button"
        className="icon-button"
        title={text.stats(container.name)}
        aria-label={text.stats(container.name)}
        aria-pressed={open}
        onClick={onToggle}
      >
        <Icon name="eye" />
      </button>
      {reachButton(REACH.settings, "pencil", text.settings(container.name))}
      {composeButton}
      {admin && (
        <>
          <button
            type="button"
            className="icon-button"
            title={TEXT.containerBackup.rowBackUp(container.name)}
            aria-label={TEXT.containerBackup.rowBackUp(container.name)}
            disabled={busy}
            onClick={() => onBackup(BACKUP_DIALOG.backUp)}
          >
            <Icon name="archive" />
          </button>
          <button
            type="button"
            className="icon-button"
            title={TEXT.containerBackup.rowRestore(container.name)}
            aria-label={TEXT.containerBackup.rowRestore(container.name)}
            disabled={busy}
            onClick={() => onBackup(BACKUP_DIALOG.restore)}
          >
            <Icon name="history" />
          </button>
        </>
      )}
      {container.recovery !== undefined && (
        <span className="small text-warning" role="status">
          {TEXT.actions.recovery(container.recovery.owner)}
        </span>
      )}
      {rowActionsOf(container).map(({ action, icon }) =>
        button(
          action,
          icon,
          action === JOB_ACTION.rollBack ? container.handsOff === null : targetsOf(action, [container]).length > 0,
          () => {
            if (action !== JOB_ACTION.rollBack || window.confirm(TEXT.actions.confirmRollBack(container.name)))
              ask(action, [container]);
          },
        ),
      )}
    </span>
  );
}

// What it publishes, each a link to it on its host where that is plain TCP; or that it uses the host's network.
function PortsCell({ container, address }: { container: ContainerView; address: string | null }) {
  const text = TEXT.hostContainers;
  if (container.hostNetwork) {
    return <span className="muted small">{text.hostNetwork}</span>;
  }
  if (container.ports === null || container.ports.length === 0) {
    return <span className="muted">{TEXT.none}</span>;
  }
  const described = container.ports.map((port) => text.port(port.published, port.target, port.protocol));
  const more = container.ports.length - PORTS_SHOWN;
  return (
    <span className="ports" title={described.join(TEXT.listComma)}>
      {container.ports.slice(0, PORTS_SHOWN).map((port, index) =>
        address !== null && port.protocol === PORT_PROTOCOL.tcp ? (
          <a
            key={described[index]}
            className="port"
            href={`http://${address}:${port.published}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {port.published}
          </a>
        ) : (
          <span key={described[index]} className="port">
            {port.published}
          </span>
        ),
      )}
      {more > 0 && <span className="muted small">{text.morePorts(more)}</span>}
    </span>
  );
}

// Reuse the inventory's latest sample; missing or stopped containers must not look like zero usage.
// How long it has been up, from Docker's own start time: a fresh number after an update or a restart shows it happened.
function UpForCell({ container }: { container: ContainerView }) {
  const up = container.state === CONTAINER_STATE_RUNNING || container.state === CONTAINER_STATE_PAUSED;
  // A silent host's report is old, and the time since it would only keep growing.
  const known = up && container.startedAt !== null && container.hostState === HOST_STATE.online;
  if (!known) return <td className="muted">{TEXT.none}</td>;
  const seconds = Math.max(0, (Date.now() - container.startedAt!) / MILLISECONDS_PER_SECOND);
  return (
    <td className="muted" title={TEXT.hostContainers.upSince(dateTime(container.startedAt!))}>
      {duration(seconds)}
    </td>
  );
}

function UsageCells({ container }: { container: ContainerView }) {
  const usage = container.state === CONTAINER_STATE_RUNNING ? container.usage : null;
  const unavailable =
    container.state === CONTAINER_STATE_RUNNING ? TEXT.metrics.waitingForContainer : TEXT.metrics.notRunning;
  const cpuOf =
    usage?.cpuLimitCores == null ? TEXT.metrics.ofHost : TEXT.metrics.cpuLimit(decimal(usage.cpuLimitCores));
  const memoryOf =
    usage?.memoryLimitBytes == null ? TEXT.metrics.noLimit : TEXT.metrics.memoryLimit(bytes(usage.memoryLimitBytes));
  return (
    <>
      <td className="usage-cell muted" title={usage === null ? unavailable : cpuOf}>
        {usage === null ? TEXT.none : precisePercent(usage.cpuPercent)}
      </td>
      <td className="usage-cell muted" title={usage === null ? unavailable : memoryOf}>
        {usage === null ? TEXT.none : bytes(usage.memoryBytes)}
      </td>
    </>
  );
}

// --- a row as its container changes: a job at work on it, an update under it, a change seen for a moment ----------

// What a job is doing to the container, in its state's place until the job ends.
function WorkingState({ job }: { job: WorkingJob }) {
  return (
    <span className="working-state">
      <Icon name="rotateCw" className="spin" />
      {job.progress === null ? TEXT.hostContainers.working[job.action] : phaseWords(job.progress)}
    </span>
  );
}

// A container just removed, as it was, fading out for a moment so the change is seen.
function GoneRow({ container, admin, actions }: { container: ContainerView; admin: boolean; actions: boolean }) {
  return (
    <tr className={`motion-${MOTION.removed}`}>
      {admin && <td className="tick-column" />}
      <td>
        <span className="name-cell">
          <span className="name-text mono" title={container.name}>
            {container.name}
          </span>
        </span>
      </td>
      <td className="text-danger">{TEXT.hostContainers.removed}</td>
      <td />
      <td />
      <td />
      <td colSpan={2} />
      <td colSpan={2} />
      {actions && <td />}
    </tr>
  );
}

function rowClassOf(
  open: boolean,
  pinned: boolean,
  job: WorkingJob | null,
  motion: Motion | undefined,
): string | undefined {
  const classes = [
    open ? "selected" : null,
    pinned ? "pinned" : null,
    job === null ? null : `working working-${job.action}`,
    motion === undefined ? null : `motion-${motion}`,
  ].filter((name) => name !== null);
  return classes.length === 0 ? undefined : classes.join(" ");
}

type Working = ReadonlyMap<string, WorkingJob>;

// Which containers the table shows: all, or one kind of them.
const SHOWS: Record<ContainerShow, (container: ContainerView, working: Working) => boolean> = {
  [CONTAINER_SHOW.all]: () => true,
  [CONTAINER_SHOW.running]: (container) => container.state === CONTAINER_STATE_RUNNING,
  [CONTAINER_SHOW.stopped]: (container) => container.state !== CONTAINER_STATE_RUNNING,
  [CONTAINER_SHOW.problems]: (container) => container.problem !== null,
  [CONTAINER_SHOW.updates]: hasUpdate,
  [CONTAINER_SHOW.working]: (container, working) => working.has(container.name),
};

// Each kind with how many it holds now; one with none is left out, unless it is the one chosen.
function ShowChips({
  containers,
  working,
  chosen,
  onChoose,
  children,
}: {
  containers: readonly ContainerView[];
  working: Working;
  // Null while the list showing is not the containers.
  chosen: ContainerShow | null;
  onChoose: (show: ContainerShow) => void;
  children?: ReactNode;
}) {
  const text = TEXT.hostContainers;
  const counted = CONTAINER_SHOWS.map((show) => ({
    show,
    count: containers.filter((container) => SHOWS[show](container, working)).length,
  }));
  return (
    <div className="show-chips" role="group" aria-label={text.showLabel}>
      {counted
        .filter(({ show, count }) => count > 0 || show === chosen || show === CONTAINER_SHOW.all)
        .map(({ show, count }) => (
          <button
            key={show}
            type="button"
            className={show === chosen ? "chip-button active" : "chip-button"}
            aria-pressed={show === chosen}
            onClick={() => onChoose(show)}
          >
            {text.shows[show]} <span className="tab-count">{count}</span>
          </button>
        ))}
      {children}
    </div>
  );
}

const HOST_PANEL = { containers: "containers", networks: "networks", volumes: "volumes" } as const;
type HostPanel = (typeof HOST_PANEL)[keyof typeof HOST_PANEL];
const PANEL_TITLES: Record<HostPanel, string> = {
  containers: "host-containers-title",
  networks: "host-networks-title",
  volumes: "host-volumes-title",
};

const ticksOf = (change: ContainerControlChange): Partial<ContainerControlView> => ({
  ...(change.restart === undefined ? {} : { restart: change.restart }),
  ...(change.update === undefined ? {} : { update: change.update }),
});

/**
 * One host's containers, stacks first: what each does when it fails and when a new image is out, set
 * in place. A container's name opens its stats beneath it, as everywhere. Live: a row shows the job at work on it,
 * an update's pull under it, and each change of its container for a moment as it happens.
 */
export function HostContainers({
  host,
  admin,
  containersAsked = 0,
}: {
  host: HostView;
  admin: boolean;
  // Goes up each time a person clicks the page's Containers tab, which leads back to this list.
  containersAsked?: number;
}) {
  const permissions = useResourcePermissions();
  const allowed = (action: ResourceAction, container: ContainerView) => admin || permissions.allowed(action, container);
  const queryClient = useQueryClient();
  const query = hostContainersQuery(host.id);
  const containers = useQuery({ ...query, refetchInterval: INVENTORY_REFRESH_MILLISECONDS });
  const jobs = useQuery(hostJobsQuery(host.id));
  const run = useQuery(updateRunQuery(host.id));
  const motion = useContainerMotion(containers.data, jobs.data);
  const working: Working = new Map([...motion.awaiting, ...workOf(jobs.data ?? [])]);
  const [show, setShow] = useState<ContainerShow>(CONTAINER_SHOW.all);
  const tasks = useQuery(hostTasksQuery(host.id));
  const heldUpdates = new Map(
    (tasks.data ?? []).filter(isPersonsUpdate).map((task) => [task.resource?.id ?? "", task] as const),
  );
  const selection = useContainerSelection();
  const saved = useSavedNote();
  const [find, setFind] = useState("");
  const [panel, setPanel] = useState<HostPanel>(HOST_PANEL.containers);
  const [networksLeftAsked, setNetworksLeftAsked] = useState(0);
  const [volumesLeftAsked, setVolumesLeftAsked] = useState(0);
  const openPanel = (next: HostPanel) => {
    if (next !== panel) setFind("");
    setPanel(next);
  };
  useEffect(() => {
    if (containersAsked > 0) openPanel(HOST_PANEL.containers);
  }, [containersAsked]);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  // The container reached into under its row, and how: one at a time.
  const [reach, setReach] = useState<{ name: string; kind: Reach } | null>(null);
  const [backingUp, setBackingUp] = useState<{ name: string; mode: BackupDialogMode } | null>(null);
  const [logsAsked, setLogsAsked] = useState<{ name: string; request: InspectorTabRequest } | null>(null);
  const reachingOf = (name: string) => (reach?.name === name ? reach.kind : null);
  // The one being worked on keeps its row in view: the last thing opened, if two are.
  const pinnedName = reach?.name ?? selection.open;
  const pinnedRow = useRef<HTMLTableRowElement>(null);
  // A panel with buttons at its foot needs the room; stats opened by a click on the row leave that row where it is.
  useEffect(() => {
    if (reach !== null && pinnedRow.current !== null) bringUnderListHeader(pinnedRow.current);
  }, [reach?.name]);
  const toggleReach = (name: string, kind: Reach) => setReach(reachingOf(name) === kind ? null : { name, kind });
  const bulk = useBulkAction(host.id);
  const [operatorReview, setOperatorReview] = useState<{
    action: typeof JOB_ACTION.update | typeof JOB_ACTION.rollBack;
    target: ContainerView;
  } | null>(null);
  // The update asked for by a row's icon, and the icon its small box opens from.
  const [updateAsked, setUpdateAsked] = useState<{ target: ContainerView; anchor: HTMLElement } | null>(null);
  const canUpdate = (container: ContainerView) => {
    const permission = actionPermission(JOB_ACTION.update);
    return (
      permission !== null && allowed(permission, container) && targetsOf(JOB_ACTION.update, [container]).length > 0
    );
  };
  const operatorAction = useMutation({
    mutationFn: ({ action, target, previewId }: { action: RowAction; target: ContainerView; previewId?: string }) =>
      api<JobView>("POST", apiPath(API_ROUTES.containerActions, { hostId: host.id, containerName: target.name }), {
        action,
        ...(previewId ? { previewId } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["jobs", host.id] });
      void queryClient.invalidateQueries({ queryKey: ["containers", host.id] });
    },
  });
  const ask: Ask = (action, targets) => {
    const names = targets.map((target) => target.name);
    if (!goesAhead(action, names)) return;
    if (admin) {
      if (action === JOB_ACTION.update || action === JOB_ACTION.rollBack) bulk.review(action, targets);
      else bulk.run.mutate({ action, targets });
      return;
    }
    const target = targets[0];
    const permission = actionPermission(action);
    if (targets.length === 1 && target && permission !== null && allowed(permission, target)) {
      if (action === JOB_ACTION.update || action === JOB_ACTION.rollBack) setOperatorReview({ action, target });
      else operatorAction.mutate({ action, target });
    }
  };
  const updateConfirmed = (target: ContainerView, previews: Record<string, string>) => {
    setUpdateAsked(null);
    if (admin) bulk.run.mutate({ action: JOB_ACTION.update, targets: [target], previews });
    else operatorAction.mutate({ action: JOB_ACTION.update, target, previewId: previews[target.name] });
  };
  const choose = useMutation({
    mutationFn: (change: ContainerControlChange) =>
      api<void>("PUT", apiPath(API_ROUTES.containerControls, { hostId: host.id }), change),
    // The choice shows at once; the list follows what the control plane kept.
    onMutate: (change) =>
      queryClient.setQueryData<ContainerView[]>(query.queryKey, (current) =>
        current?.map((container) =>
          change.names.includes(container.name)
            ? { ...container, byItself: { ...container.byItself, ...ticksOf(change) } }
            : container,
        ),
      ),
    onSuccess: () => saved.show(),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["containers"] }),
  });
  const list = containers.data;
  const text = TEXT.hostContainers;
  const showingContainers = panel === HOST_PANEL.containers;
  const words = showingContainers ? find.trim().toLowerCase() : "";
  const gone = new Set(motion.ghosts.map((container) => container.name));
  const found = [...(list ?? []), ...motion.held, ...motion.ghosts].filter(
    (container) => matches(container, words) && SHOWS[show](container, working),
  );
  const groups = groupsOf(found);
  // A stack's score counts all its containers, whatever the list is filtered to.
  const membersOf = (stack: string) => (list ?? []).filter((container) => container.composeProject === stack);
  // Restart stack restarts the ones Autoheal may change: the person must be let restart every one of them.
  const mayRestart = (stack: string) => {
    const restartable = membersOf(stack).filter((container) => container.handsOff === null);
    return restartable.length > 0 && restartable.every((container) => allowed("lifecycle", container));
  };
  const actionsShown =
    admin ||
    list?.some((container) =>
      (["lifecycle", "update", "logs", "terminal", "files", "settings"] as const).some((action) =>
        allowed(action, container),
      ),
    ) === true;
  const columns = admin ? ADMIN_COLUMN_COUNT : COLUMN_COUNT + (actionsShown ? 1 : 0);
  useEffect(() => {
    if (!reach || admin) return;
    const container = list?.find((item) => item.name === reach.name);
    if (!container || !allowed(permissionOf(reach.kind), container)) setReach(null);
  }, [reach, list, admin, permissions.allowed]);
  const address = host.health?.address ?? null;
  // Only what the host lets Autoheal change can be ticked; ticks on containers gone since are left out.
  const tickable = groups
    .flatMap((group) => group.containers)
    .filter((container) => container.handsOff === null && !gone.has(container.name));
  const tickableIn = (stack: string) => tickable.filter((container) => container.composeProject === stack);
  const tickStack = (stack: string) => {
    const members = tickableIn(stack).map(({ name }) => name);
    const allOn = members.length > 0 && members.every((name) => ticked.has(name));
    setTicked(
      allOn ? new Set([...ticked].filter((name) => !members.includes(name))) : new Set([...ticked, ...members]),
    );
  };
  const allTicked = tickable.length > 0 && tickable.every((container) => ticked.has(container.name));
  const tickedContainers = (list ?? []).filter((container) => ticked.has(container.name));
  return (
    <section className="host-containers" aria-labelledby={PANEL_TITLES[panel]}>
      <header className="section-head">
        {panel === HOST_PANEL.networks && <NetworksHeading host={host} />}
        {panel === HOST_PANEL.volumes && <VolumesHeading host={host} />}
        {showingContainers && (
          <h2 id="host-containers-title">
            {text.title}
            <span className="muted">
              {TEXT.separator}
              {TEXT.hosts.running(host.runningCount, host.containerCount)}
            </span>
          </h2>
        )}
        <SavedNote shown={saved.shown} />
        <label className="find">
          {text.find}
          <input
            type="search"
            value={find}
            placeholder={showingContainers ? text.findPlaceholder : text.findNamePlaceholder}
            onChange={(event) => setFind(event.target.value)}
          />
        </label>
      </header>
      {list !== undefined && (
        <ShowChips
          containers={list}
          working={working}
          chosen={showingContainers ? show : null}
          onChoose={(next) => {
            openPanel(HOST_PANEL.containers);
            setShow(next);
          }}
        >
          <span className="chip-divider" aria-hidden="true" />
          <NetworksChip
            hostId={host.id}
            active={panel === HOST_PANEL.networks}
            onOpen={(leftBehind) => {
              openPanel(HOST_PANEL.networks);
              if (leftBehind) setNetworksLeftAsked((asked) => asked + 1);
            }}
          />
          <VolumesChip
            hostId={host.id}
            active={panel === HOST_PANEL.volumes}
            onOpen={(leftBehind) => {
              openPanel(HOST_PANEL.volumes);
              if (leftBehind) setVolumesLeftAsked((asked) => asked + 1);
            }}
          />
          <span className="chip-divider" aria-hidden="true" />
          {admin && host.hostDeploy === true && !host.dryRun && <AddContainer host={host} />}
          {backingUp !== null && (
            <BackupDialog
              hostId={host.id}
              target={{ container: backingUp.name, stack: null }}
              mode={backingUp.mode}
              onClose={() => setBackingUp(null)}
            />
          )}
        </ShowChips>
      )}
      <div hidden={panel !== HOST_PANEL.networks}>
        <HostNetworks
          host={host}
          admin={admin}
          find={panel === HOST_PANEL.networks ? find : ""}
          leftAsked={networksLeftAsked}
        />
      </div>
      <div hidden={panel !== HOST_PANEL.volumes}>
        <HostVolumes
          host={host}
          admin={admin}
          find={panel === HOST_PANEL.volumes ? find : ""}
          leftAsked={volumesLeftAsked}
        />
      </div>
      <div hidden={!showingContainers}>
        {admin && (
          <BulkBar
            hostId={host.id}
            ticked={tickedContainers}
            bulk={bulk}
            ask={ask}
            onClear={() => setTicked(new Set())}
            onLookAtVolumes={() => openPanel(HOST_PANEL.volumes)}
          />
        )}
        {list === undefined && (containers.error ? <ErrorNotice error={containers.error} /> : <Loading />)}
        {list !== undefined && (
          <div className="table-wrap container-table">
            <table>
              <thead>
                <tr>
                  {admin && (
                    <th className="tick-column">
                      <input
                        type="checkbox"
                        checked={allTicked}
                        disabled={tickable.length === 0}
                        aria-label={BULK_TEXT.tickAll}
                        onChange={() =>
                          setTicked(allTicked ? new Set() : new Set(tickable.map((container) => container.name)))
                        }
                      />
                    </th>
                  )}
                  <th className="name-column">{text.container}</th>
                  <th className="state-column">{text.state}</th>
                  <th className="up-column">{text.upFor}</th>
                  <th className="image-column">{text.image}</th>
                  <th className="ports-column">{text.ports}</th>
                  <th className="cpu-column usage-cell">{TEXT.metrics.cpu}</th>
                  <th className="memory-column usage-cell">{text.ram}</th>
                  <th className="choice-column">{text.ifItFails}</th>
                  <th className="choice-column">{text.newImage}</th>
                  {actionsShown && <th className="actions-column">{text.actions}</th>}
                </tr>
              </thead>
              <tbody>
                {found.length === 0 && (
                  <tr>
                    <td colSpan={columns} className="muted">
                      {list.length === 0 ? TEXT.containers.empty : text.nothingFound}
                    </td>
                  </tr>
                )}
                {groups.map((group) => (
                  <Fragment key={group.stack ?? ""}>
                    {(group.stack !== null || groups.length > 1) && (
                      <tr className="group-row">
                        <th scope="rowgroup" colSpan={columns}>
                          {group.stack === null ? (
                            text.single
                          ) : (
                            <StackHead
                              hostId={host.id}
                              stack={group.stack}
                              members={membersOf(group.stack)}
                              canRestart={mayRestart(group.stack)}
                              admin={admin}
                              overSsh={host.kind === HOST_KIND.ssh}
                              tick={
                                admin
                                  ? {
                                      ticked:
                                        tickableIn(group.stack).length > 0 &&
                                        tickableIn(group.stack).every(({ name }) => ticked.has(name)),
                                      onChange: () => tickStack(group.stack!),
                                    }
                                  : undefined
                              }
                            />
                          )}
                        </th>
                      </tr>
                    )}
                    {group.containers.map((container) => {
                      if (gone.has(container.name)) {
                        return (
                          <GoneRow key={container.name} container={container} admin={admin} actions={actionsShown} />
                        );
                      }
                      const open = selection.open === container.name;
                      const job = working.get(container.name) ?? null;
                      const waits = waitInRun(run.data ?? null, container.name);
                      return (
                        <Fragment key={container.name}>
                          <tr
                            ref={pinnedName === container.name ? pinnedRow : undefined}
                            className={rowClassOf(
                              open,
                              pinnedName === container.name,
                              job,
                              motion.motions.get(container.name),
                            )}
                            aria-busy={job !== null}
                          >
                            {admin && (
                              <td className="tick-column">
                                {container.handsOff === null && (
                                  <input
                                    type="checkbox"
                                    checked={ticked.has(container.name)}
                                    aria-label={BULK_TEXT.tickOne(container.name)}
                                    onChange={() => setTicked((names) => toggled(names, container.name))}
                                  />
                                )}
                              </td>
                            )}
                            <td>
                              <span className="name-cell">
                                <button
                                  type="button"
                                  className="link container-name"
                                  title={container.name}
                                  aria-expanded={open}
                                  onClick={() => selection.toggle(container.name)}
                                >
                                  <span className="name-text">{container.name}</span>
                                </button>
                                {job === null && canUpdate(container) && (
                                  <button
                                    type="button"
                                    className="icon-button update-ready"
                                    title={TEXT.hostContainers.updateBox.icon(container.name)}
                                    aria-label={TEXT.hostContainers.updateBox.icon(container.name)}
                                    aria-expanded={updateAsked?.target.name === container.name}
                                    disabled={bulk.run.isPending || operatorAction.isPending}
                                    onClick={(event) =>
                                      setUpdateAsked({ target: container, anchor: event.currentTarget })
                                    }
                                  >
                                    <Icon name="circleArrowUp" />
                                  </button>
                                )}
                                <MaintenanceBadge hostId={container.hostId} containerName={container.name} />
                                <WebLink container={container} />
                              </span>
                            </td>
                            <td className={job === null ? stateTone(container) : undefined}>
                              {job === null ? stateOf(container) : <WorkingState job={job} />}
                              {waits !== null && <div className="state-note muted">{waits}</div>}
                              <RestartsUsed host={host} name={container.name} admin={admin} />
                            </td>
                            <UpForCell container={container} />
                            <td>
                              <ImageCell container={container} held={heldUpdates.get(container.name)} />
                            </td>
                            <td>
                              <PortsCell container={container} address={address} />
                            </td>
                            <UsageCells container={container} />
                            <ChoiceCells
                              container={container}
                              canAct={admin}
                              onChange={(change) => choose.mutate({ names: [container.name], ...change })}
                            />
                            {actionsShown && (
                              <td>
                                <RowActions
                                  admin={admin}
                                  onBackup={(mode) => setBackingUp({ name: container.name, mode })}
                                  host={host}
                                  container={container}
                                  open={open}
                                  reaching={reachingOf(container.name)}
                                  busy={bulk.run.isPending || operatorAction.isPending}
                                  ask={ask}
                                  onToggle={() => selection.toggle(container.name)}
                                  onLogs={() =>
                                    setLogsAsked({
                                      name: container.name,
                                      request: { tab: "logs", count: (logsAsked?.request.count ?? 0) + 1 },
                                    })
                                  }
                                  onReach={(kind) => toggleReach(container.name, kind)}
                                  allowed={(action) => allowed(action, container)}
                                />
                              </td>
                            )}
                          </tr>
                          {job !== null && job.progress !== null && (
                            <tr className="update-stream-row">
                              <td colSpan={columns}>
                                <UpdateStream name={container.name} image={container.image} progress={job.progress} />
                              </td>
                            </tr>
                          )}
                          {open && (
                            <tr className="inspector-row">
                              <td colSpan={columns}>
                                <ContainerInspector
                                  container={container}
                                  siblings={list}
                                  canAct={admin}
                                  arrived={selection.arrived === container.name}
                                  tabRequest={logsAsked?.name === container.name ? logsAsked.request : null}
                                  tools={(files) => (
                                    <PanelReach
                                      host={host}
                                      container={container}
                                      reaching={reachingOf(container.name)}
                                      onReach={(kind) => toggleReach(container.name, kind)}
                                      allowed={(action) => allowed(action, container)}
                                      files={files}
                                    />
                                  )}
                                />
                              </td>
                            </tr>
                          )}
                          {reach?.name === container.name && allowed(permissionOf(reach.kind), container) && (
                            <tr className="reach-row">
                              <td colSpan={columns}>
                                <ReachPanel
                                  reach={reach.kind}
                                  hostId={host.id}
                                  containerName={container.name}
                                  composeProject={container.composeProject}
                                  keptByHost={container.handsOff !== null}
                                  onClose={() => setReach(null)}
                                />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {bulk.impact}
        {updateAsked && (
          <UpdateConfirm
            key={updateAsked.target.name}
            hostId={host.id}
            container={updateAsked.target}
            anchor={updateAsked.anchor}
            onCancel={() => setUpdateAsked(null)}
            onConfirm={(previews) => updateConfirmed(updateAsked.target, previews)}
          />
        )}
        {operatorReview && (
          <OperationImpactReview
            hostId={host.id}
            action={operatorReview.action}
            names={[operatorReview.target.name]}
            onCancel={() => setOperatorReview(null)}
            onConfirm={(previews) => {
              operatorAction.mutate({ ...operatorReview, previewId: previews[operatorReview.target.name] });
              setOperatorReview(null);
            }}
          />
        )}
        <ErrorNotice error={choose.error ?? operatorAction.error} />
      </div>
    </section>
  );
}
