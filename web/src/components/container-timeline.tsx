import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link } from "react-router";
import {
  API_ROUTES,
  TIMELINE_ENTRY,
  apiPath,
  type ContainerTimelineEntry,
  type HostChangeView,
  type IncidentSummaryView,
  type JobView,
  type TaskActivityView,
  type TimelineTaskView,
} from "../../../src/shared/api.js";
import { HOST_CHANGE_TEXT, wordsOf } from "../../../src/shared/constants.js";
import { DELIVERY_RESOURCE, type NotificationEventView } from "../../../src/shared/notification-deliveries.js";
import { api } from "../api-client.js";
import { CONTAINER_TIMELINE_SHOWN, PATHS, REFRESH_MILLISECONDS, TEXT } from "../constants.js";
import { actionText } from "../format.js";
import { Badge, ErrorNotice, Loading, TimeAgo } from "./common.js";
import { incidentLink } from "./incident-parts.js";

const text = TEXT.containerTimeline;

const taskLink = (taskId: string) => apiPath(PATHS.task, { taskId });

const timelineQuery = (hostId: string, containerName: string) => ({
  queryKey: ["container-timeline", hostId, containerName],
  queryFn: () => api<ContainerTimelineEntry[]>("GET", apiPath(API_ROUTES.containerTimeline, { hostId, containerName })),
  refetchInterval: REFRESH_MILLISECONDS,
});

function keyOf(entry: ContainerTimelineEntry): string {
  switch (entry.kind) {
    case TIMELINE_ENTRY.incident:
      return `${entry.kind}-${entry.incident.id}`;
    case TIMELINE_ENTRY.job:
      return `${entry.kind}-${entry.job.id}`;
    case TIMELINE_ENTRY.change:
      return `${entry.kind}-${entry.change.id}`;
    case TIMELINE_ENTRY.task:
      return `${entry.kind}-${entry.activity.id}`;
    case TIMELINE_ENTRY.notification:
      return `${entry.kind}-${entry.notification.id}`;
  }
}

function IncidentLine({ incident }: { incident: IncidentSummaryView }) {
  return (
    <>
      <Badge value={incident.verdict ?? incident.status} />
      <span>{TEXT.incident.triggers[incident.trigger]}</span>
      {incident.action !== null && <span className="muted">{actionText(incident.action, incident.target)}</span>}
      <Link to={incidentLink(incident.id)}>{text.incident}</Link>
    </>
  );
}

function JobLine({ job }: { job: JobView }) {
  return (
    <>
      <Badge value={job.status} />
      <span>{TEXT.actions.names[job.action]}</span>
      <span className="muted">{TEXT.actions.by(job.requestedBy)}</span>
      {job.outcome !== null && <span className="muted">{job.outcome}</span>}
      {job.taskId !== null && <Link to={taskLink(job.taskId)}>{text.task}</Link>}
    </>
  );
}

// As the host's What changed says it: the container, or the host for its own changes.
function ChangeLine({ change }: { change: HostChangeView }) {
  return (
    <>
      <strong className="mono">{change.containerName ?? TEXT.hostChanges.host}</strong>
      <span>{HOST_CHANGE_TEXT[change.kind](change.details)}</span>
    </>
  );
}

function TaskLine({ task, activity }: { task: TimelineTaskView; activity: TaskActivityView }) {
  return (
    <>
      <Link to={taskLink(task.id)}>
        {TEXT.tasks.numbered(task.number)} {task.title}
      </Link>
      <span>
        <strong>{activity.actor}</strong> {TEXT.tasks.activity[activity.kind](activity.data)}
      </span>
    </>
  );
}

function AlertLine({ notification }: { notification: NotificationEventView }) {
  const sent = notification.deliveries
    .map((delivery) => text.sent(TEXT.services.names[delivery.channel], wordsOf(delivery.status)))
    .join(TEXT.listComma);
  const aboutIncident = notification.resourceKind === DELIVERY_RESOURCE.incident;
  return (
    <>
      <span>{text.alert(wordsOf(notification.kind))}</span>
      <span className="muted">{sent || text.unsent}</span>
      {notification.resourceId !== null && (
        <Link to={aboutIncident ? incidentLink(notification.resourceId) : taskLink(notification.resourceId)}>
          {aboutIncident ? text.incident : text.task}
        </Link>
      )}
    </>
  );
}

function EntryLine({ entry }: { entry: ContainerTimelineEntry }) {
  switch (entry.kind) {
    case TIMELINE_ENTRY.incident:
      return <IncidentLine incident={entry.incident} />;
    case TIMELINE_ENTRY.job:
      return <JobLine job={entry.job} />;
    case TIMELINE_ENTRY.change:
      return <ChangeLine change={entry.change} />;
    case TIMELINE_ENTRY.task:
      return <TaskLine task={entry.task} activity={entry.activity} />;
    case TIMELINE_ENTRY.notification:
      return <AlertLine notification={entry.notification} />;
  }
}

/**
 * What one container went through, newest first, at the bottom of its opened row: its incidents, the jobs asked of
 * it, what changed, its tasks' steps and the alerts about them. The newest few show at first.
 */
export function ContainerTimeline({ hostId, containerName }: { hostId: string; containerName: string }) {
  const titleId = useId();
  const [all, setAll] = useState(false);
  const timeline = useQuery(timelineQuery(hostId, containerName));
  const entries = timeline.data ?? [];
  const shown = all ? entries : entries.slice(0, CONTAINER_TIMELINE_SHOWN);
  return (
    <section className="stack" aria-labelledby={titleId}>
      <h3 id={titleId}>{text.title}</h3>
      {timeline.data === undefined && timeline.error === null && <Loading />}
      {timeline.data?.length === 0 && <p className="muted small">{text.empty}</p>}
      {shown.length > 0 && (
        <ol className="timeline">
          {shown.map((entry) => (
            <li key={keyOf(entry)} className="small">
              <span className="row">
                <TimeAgo timestamp={entry.at} />
                <EntryLine entry={entry} />
              </span>
            </li>
          ))}
        </ol>
      )}
      {entries.length > CONTAINER_TIMELINE_SHOWN && (
        <button type="button" className="link" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? text.showNewest(CONTAINER_TIMELINE_SHOWN) : text.showAll(entries.length)}
        </button>
      )}
      <ErrorNotice error={timeline.error} />
    </section>
  );
}
