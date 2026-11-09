import { AnomalyExplanation } from "../../components/anomaly-explanation.js";
import { ANOMALY_TASK_LABEL, TREND_METRICS } from "../../../../src/shared/metric-trends.js";
import { MaintenanceBadge } from "../../components/maintenance-dialog.js";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import {
  API_ROUTES,
  apiPath,
  type HostView,
  type TaskChangeRequest,
  type TaskSummaryView,
} from "../../../../src/shared/api.js";
import { PERCENT, TASK_RESOURCE, TASK_STATUS } from "../../../../src/shared/constants.js";
import { api } from "../../api-client.js";
import { hostLink, taskPlaceLink } from "../../host-links.js";
import { SnoozeChoices } from "../../components/snooze-choices.js";
import { Bar, ErrorNotice } from "../../components/common.js";
import { DISK_FULL_DANGER_PERCENT, PATHS, TEXT } from "../../constants.js";
import { percent, timeAgo } from "../../format.js";
import { boardQuery } from "../../queries.js";
import { diskUsedPercent } from "../host-dial-values.js";

const ownerOf = (task: TaskSummaryView, viewerId: string) => {
  const since = timeAgo(task.createdAt);
  if (task.assignee === null) {
    return TEXT.attention.openSince(since);
  }
  return task.assignee.kind === "user" && task.assignee.id === viewerId
    ? TEXT.attention.yoursSince(since)
    : TEXT.attention.theirsSince(task.assignee.name, since);
};

export function FixCard({
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
  const queryClient = useQueryClient();
  const change = useMutation({
    mutationFn: (body: TaskChangeRequest) => api("PATCH", apiPath(API_ROUTES.task, { taskId: task.id }), body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: boardQuery.queryKey }),
  });
  const disk =
    task.resource?.kind === TASK_RESOURCE.disk
      ? host?.health?.disks.find((candidate) => candidate.path === task.resource?.id)
      : undefined;
  const filled = disk === undefined ? null : diskUsedPercent(disk);
  const tone = filled !== null && filled >= DISK_FULL_DANGER_PERCENT ? "danger" : "warning";
  const where = disk === undefined ? (task.hostLabel ?? "") : TEXT.attention.diskOn(task.hostLabel ?? "");
  return (
    <article className="card fix">
      <header className="fix-head">
        <h3 className={disk === undefined ? undefined : "mono"}>{disk === undefined ? task.title : disk.path}</h3>
        {filled !== null && <span className={`fix-figure text-${tone}`}>{percent(filled)}</span>}
      </header>
      {filled !== null && <Bar fraction={filled / PERCENT} tone={tone} />}
      <p className="small muted">{[where, ownerOf(task, viewerId)].filter(Boolean).join(TEXT.separator)}</p>
      {task.hostId !== null && (
        <MaintenanceBadge
          hostId={task.hostId}
          containerName={task.resource?.kind === TASK_RESOURCE.container ? task.resource?.id : undefined}
        />
      )}
      {task.hostId !== null && task.labels.includes(ANOMALY_TASK_LABEL) && (
        <AnomalyExplanation
          hostId={task.hostId}
          containerName={task.resource?.kind === TASK_RESOURCE.container ? task.resource.id : null}
          metric={TREND_METRICS.find(
            (metric) =>
              task.labels.includes(`${ANOMALY_TASK_LABEL}-${metric}`) ||
              task.labels.includes(`${ANOMALY_TASK_LABEL}:${metric}`),
          )}
          admin={admin}
        />
      )}
      <div className="card-actions">
        {task.hostId !== null && task.hostLabel !== null ? (
          <Link className="button" to={taskPlaceLink(task) ?? hostLink(task.hostId)}>
            {TEXT.attention.open(task.hostLabel)}
          </Link>
        ) : (
          <Link className="button" to={apiPath(PATHS.task, { taskId: task.id })}>
            {TEXT.attention.open(`#${task.number}`)}
          </Link>
        )}
        {admin && (
          <>
            <SnoozeChoices disabled={change.isPending} onChoose={(snoozed) => change.mutate({ snoozed })} />
            <button
              type="button"
              className="quiet"
              disabled={change.isPending}
              onClick={() => change.mutate({ status: TASK_STATUS.done })}
            >
              {TEXT.attention.done}
            </button>
          </>
        )}
      </div>
      <ErrorNotice error={change.error} />
    </article>
  );
}
