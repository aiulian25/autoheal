import { Link } from "react-router";
import { AnomalyExplanation } from "../../components/anomaly-explanation.js";
import { ANOMALY_TASK_LABEL, TREND_METRICS } from "../../../../src/shared/metric-trends.js";
import { MaintenanceBadge } from "../../components/maintenance-dialog.js";
import { apiPath, type HostView, type TaskSummaryView } from "../../../../src/shared/api.js";
import { PRESSING_TASK_PRIORITIES, TASK_ABOUT, TASK_RESOURCE, TASK_STATUS } from "../../../../src/shared/constants.js";
import { hostLink, taskPlaceLink } from "../../host-links.js";
import { HeldBack } from "../../components/held-back.js";
import { SnoozeMenu } from "../../components/snooze-menu.js";
import { ErrorNotice } from "../../components/common.js";
import { DISK_FULL_DANGER_PERCENT, PATHS, TEXT } from "../../constants.js";
import { bytesOf, timeAgo } from "../../format.js";
import { diskUsedPercent } from "../host-dial-values.js";
import { useTaskChange } from "./attention-parts.js";
import { UpdateTile } from "./update-rows.js";

const ownerOf = (task: TaskSummaryView, viewerId: string) => {
  const since = timeAgo(task.createdAt);
  if (task.assignee === null) {
    return TEXT.attention.openSince(since);
  }
  return task.assignee.kind === "user" && task.assignee.id === viewerId
    ? TEXT.attention.yoursSince(since)
    : TEXT.attention.theirsSince(task.assignee.name, since);
};

/**
 * Where its Open button goes, and what it names: the thing itself on its host (a disk as a disk, its path may be
 * just "/"), or the task where it has no host. None where it is about the host itself: its card's head leads there.
 */
function wayThere(task: TaskSummaryView): { to: string; name: string } | null {
  if (task.hostId === null) {
    return { to: apiPath(PATHS.task, { taskId: task.id }), name: `#${task.number}` };
  }
  const resource = task.resource;
  if (resource === null || resource.kind === TASK_RESOURCE.host) return null;
  const name = resource.kind === TASK_RESOURCE.disk ? TEXT.attention.disk : resource.label;
  return { to: taskPlaceLink(task) ?? hostLink(task.hostId), name };
}

/** A problem a restart cannot solve, in its place's card: what it is, whose it is, its way there, Done and Snooze. */
export function FixRow({
  task,
  host,
  viewerId,
  admin,
}: {
  task: TaskSummaryView;
  host: HostView | undefined;
  viewerId: string;
  admin: boolean;
}) {
  const change = useTaskChange(task.id);
  const disk =
    task.resource?.kind === TASK_RESOURCE.disk
      ? host?.health?.disks.find((candidate) => candidate.path === task.resource?.id)
      : undefined;
  const filled = disk === undefined ? null : diskUsedPercent(disk);
  const nearlyFull = filled !== null && filled >= DISK_FULL_DANGER_PERCENT;
  const tone = PRESSING_TASK_PRIORITIES.includes(task.priority) || nearlyFull ? "danger" : "warning";
  const silent = task.about === TASK_ABOUT.runnerSilent;
  const facts = [disk === undefined ? "" : bytesOf(disk.usedBytes, disk.totalBytes), ownerOf(task, viewerId)];
  const way = wayThere(task);
  const containerName = task.resource?.kind === TASK_RESOURCE.container ? task.resource.id : undefined;
  return (
    <li className={`update-row place-row tone-${tone}`}>
      <UpdateTile icon={silent ? "server" : "alert"} tone={tone} />
      <div className="update-what">
        <div className="row-title">
          {!silent && <span className={`row-tag tone-${tone}`}>{TEXT.attention.tags.fix}</span>}
          <h3>{task.title}</h3>
          {task.hostId !== null && <MaintenanceBadge hostId={task.hostId} containerName={containerName} />}
        </div>
        <p className="row-detail">{facts.filter(Boolean).join(TEXT.separator)}</p>
        {task.hostId !== null && task.labels.includes(ANOMALY_TASK_LABEL) && (
          <AnomalyExplanation
            hostId={task.hostId}
            containerName={containerName ?? null}
            metric={TREND_METRICS.find(
              (metric) =>
                task.labels.includes(`${ANOMALY_TASK_LABEL}-${metric}`) ||
                task.labels.includes(`${ANOMALY_TASK_LABEL}:${metric}`),
            )}
            admin={admin}
          />
        )}
        {silent && host !== undefined && <HeldBack host={host} admin={admin} />}
        <ErrorNotice error={change.error} />
      </div>
      <span className="row-actions">
        {way !== null && (
          <Link className="button" to={way.to}>
            {TEXT.attention.open(way.name)}
          </Link>
        )}
        {admin && (
          <>
            <button
              type="button"
              disabled={change.isPending}
              onClick={() => change.mutate({ status: TASK_STATUS.done })}
            >
              {TEXT.attention.done}
            </button>
            <SnoozeMenu disabled={change.isPending} onChoose={(snoozed) => change.mutate({ snoozed })} />
          </>
        )}
      </span>
    </li>
  );
}
