import { useQueryClient, useMutation } from "@tanstack/react-query";
import {
  apiPath,
  API_ROUTES,
  type ContainerView,
  type HostView,
  type TaskSummaryView,
  updateVersions,
  hasUpdate,
  hasNewerVersion,
  type ContainerControlChange,
} from "../../../src/shared/api.js";
import {
  CONTAINER_HEALTH_NONE,
  CONTAINER_STATE_RUNNING,
  MAX_RESTARTS_PER_WINDOW,
  TASK_RESOURCE,
  TASK_LABEL,
  UPDATE_CHOICE,
  wordsOf,
  UPDATE_STATUS,
  UPDATE_POLICY,
  HOST_SECTIONS,
  HANDS_OFF,
  CONTROL_LOCK,
  type UpdateChoice,
  type RestartChoice,
  UPDATE_CHOICES,
  RESTART_CHOICES,
  PORT_PROTOCOL,
  MILLISECONDS_PER_SECOND,
  HOST_STATE,
  CONTAINER_STATE_PAUSED,
} from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { ASSIGNEE_KINDS, MOTION, PATHS, RESET_HEARD_MILLISECONDS, TEXT, type Motion } from "../constants.js";
import { duration, dateTime, timeOfDay, precisePercent, decimal, bytes } from "../format.js";
import { ErrorNotice } from "./common.js";
import { Link } from "react-router";
import { UpdateRunnerButton } from "../pages/runner-behind.js";
import { Icon } from "./icons.js";
import type { WorkingJob } from "../container-motion.js";
import { phaseWords } from "./update-stream.js";

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
export function RestartsUsed({ host, name, admin }: { host: HostView; name: string; admin: boolean }) {
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
export const isPersonsUpdate = (task: TaskSummaryView) =>
  task.labels.includes(TASK_LABEL.update) &&
  task.resource?.kind === TASK_RESOURCE.container &&
  task.assignee?.kind === ASSIGNEE_KINDS.user;
export function ImageCell({
  container,
  held,
  admin,
}: {
  container: ContainerView;
  held: TaskSummaryView | undefined;
  admin: boolean;
}) {
  const { status, policy, reason } = container.update;
  const text = TEXT.hostContainers;
  // The runner's own container updates itself, protected as it is: the one action that reaches it.
  if (container.ownRunner === true && status === UPDATE_STATUS.available) {
    return (
      <span className="row">
        <span className="muted">{text.updateReady}</span>
        {admin && <UpdateRunnerButton hostId={container.hostId} asked={text.runnerUpdating} />}
      </span>
    );
  }
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
  // Up to date behind its tag, with a newer version of that tag out: the person's to take, told where they look.
  if (!hasUpdate(container) && hasNewerVersion(container)) {
    return <a href={`#${HOST_SECTIONS.updates}`}>{TEXT.updates.newer(container.update.newerTag!)}</a>;
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
export function ChoiceCells({
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
// Ports beyond these show as "+2", all of them in its tooltip: two keep a row one line high.
const PORTS_SHOWN = 2;
// What it publishes, each a link to it on its host where that is plain TCP; or that it uses the host's network.
export function PortsCell({ container, address }: { container: ContainerView; address: string | null }) {
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
export function UpForCell({ container }: { container: ContainerView }) {
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
export function UsageCells({ container }: { container: ContainerView }) {
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
export function WorkingState({ job }: { job: WorkingJob }) {
  return (
    <span className="working-state">
      <Icon name="rotateCw" className="spin" />
      {job.progress === null ? TEXT.hostContainers.working[job.action] : phaseWords(job.progress)}
    </span>
  );
}
// A container just removed, as it was, fading out for a moment so the change is seen.
export function GoneRow({ container, admin, actions }: { container: ContainerView; admin: boolean; actions: boolean }) {
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
export function rowClassOf(
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
