import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import {
  API_ROUTES,
  CONTAINER_QUERY,
  apiPath,
  autohealCanTake,
  type AssignableView,
  type AssigneeChoice,
  type ContainerView,
  type TaskActivityView,
  type TaskChangeRequest,
  type TaskCommentView,
  type TaskDetailView,
  type TaskSummaryView,
} from "../../../src/shared/api.js";
import {
  AGENT_AUTOHEAL,
  TASK_LABEL,
  TASK_LABEL_PATTERN,
  TASK_PRIORITIES,
  TASK_STATUSES,
  UPDATE_STATUS,
  type TaskStatus,
} from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { containerLink, hostLink } from "../host-links.js";
import { Badge, ErrorNotice, Loading, TimeAgo } from "../components/common.js";
import { ContainerActions, hasParked } from "../components/container-actions.js";
import {
  ASSIGNEE_KINDS,
  ASSIGNEE_SEPARATOR,
  INVENTORY_REFRESH_MILLISECONDS,
  PATHS,
  TASK_SHOW,
  TEXT,
} from "../constants.js";
import { dateTime } from "../format.js";
import { isAdmin, useSignedInSession } from "../session.js";
import { HostPackages, RebootWarning } from "./host-packages.js";
import { listQuery, taskLink } from "./task-queries.js";

// A select holds one string: "kind:id", or nothing for nobody.
const assigneeValue = (assignee: { kind: string; id: string } | null) =>
  assignee === null ? "" : `${assignee.kind}${ASSIGNEE_SEPARATOR}${assignee.id}`;

function assigneeOf(value: string): AssigneeChoice | null {
  const [kind, id = ""] = value.split(ASSIGNEE_SEPARATOR);
  if (kind === ASSIGNEE_KINDS.user) {
    return { kind: ASSIGNEE_KINDS.user, id };
  }
  return kind === ASSIGNEE_KINDS.agent ? { kind: ASSIGNEE_KINDS.agent, id: AGENT_AUTOHEAL } : null;
}

const activityText = (entry: TaskActivityView) => TEXT.tasks.activity[entry.kind](entry.data);

type TimelineEntry =
  { at: number; key: string; comment: TaskCommentView } | { at: number; key: string; activity: TaskActivityView };

function Timeline({ task }: { task: TaskDetailView }) {
  const entries: TimelineEntry[] = [
    ...task.activity.map((activity) => ({ at: activity.createdAt, key: `activity-${activity.id}`, activity })),
    ...task.comments.map((comment) => ({ at: comment.createdAt, key: `comment-${comment.id}`, comment })),
  ].sort((first, second) => first.at - second.at);
  return (
    <ol className="timeline" aria-label={TEXT.tasks.timeline}>
      {entries.map((entry) =>
        "comment" in entry ? (
          <li key={entry.key} className="comment">
            <span className="small">
              <strong>{entry.comment.author}</strong> <TimeAgo timestamp={entry.at} />
            </span>
            <p className="pre-wrap">{entry.comment.body}</p>
          </li>
        ) : (
          <li key={entry.key} className="small muted">
            <strong>{entry.activity.actor}</strong> {activityText(entry.activity)}
            {TEXT.separator}
            <TimeAgo timestamp={entry.at} />
          </li>
        ),
      )}
    </ol>
  );
}

function CommentForm({ taskId, onDone }: { taskId: string; onDone: (task: TaskDetailView) => void }) {
  const [body, setBody] = useState("");
  const send = useMutation({
    mutationFn: () => api<TaskDetailView>("POST", apiPath(API_ROUTES.taskComments, { taskId }), { body }),
    onSuccess: (task) => {
      setBody("");
      onDone(task);
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send.mutate();
  };
  return (
    <form className="stack" onSubmit={submit}>
      <textarea
        className="comment-box"
        aria-label={TEXT.tasks.comment}
        placeholder={TEXT.tasks.commentPlaceholder}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        required
      />
      <div className="row">
        <button className="primary" type="submit" disabled={send.isPending || body.trim() === ""}>
          {TEXT.tasks.send}
        </button>
      </div>
      <ErrorNotice error={send.error} />
    </form>
  );
}

function Labels({
  task,
  canEdit,
  onChange,
}: {
  task: TaskDetailView;
  canEdit: boolean;
  onChange: (labels: string[]) => void;
}) {
  const [adding, setAdding] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const label = adding.trim().toLowerCase();
    if (TASK_LABEL_PATTERN.test(label)) {
      onChange([...task.labels, label]);
      setAdding("");
    }
  };
  return (
    <div className="row">
      {task.labels.map((label) => (
        <span key={label} className="chip">
          {label}
          {canEdit && (
            <button
              type="button"
              className="link"
              aria-label={TEXT.tasks.removeLabel(label)}
              onClick={() => onChange(task.labels.filter((existing) => existing !== label))}
            >
              {TEXT.tasks.removeMark}
            </button>
          )}
        </span>
      ))}
      {canEdit && (
        <form onSubmit={submit}>
          <input
            className="label-input"
            aria-label={TEXT.tasks.addLabel}
            placeholder={TEXT.tasks.addLabel}
            value={adding}
            onChange={(event) => setAdding(event.target.value)}
          />
        </form>
      )}
    </div>
  );
}

// Another task this one waits on, picked from the open ones it is not already linked to.
function WaitsOn({ task, onChange }: { task: TaskDetailView; onChange: (task: TaskDetailView) => void }) {
  const [chosen, setChosen] = useState("");
  const query = listQuery(TASK_SHOW.open, "");
  const open = useQuery({
    queryKey: ["tasks", query],
    queryFn: () => api<TaskSummaryView[]>("GET", `${API_ROUTES.tasks}?${query}`),
  });
  const add = useMutation({
    mutationFn: (blockedById: string) =>
      api<TaskDetailView>("POST", apiPath(API_ROUTES.taskBlockers, { taskId: task.id }), { blockedById }),
    onSuccess: (view) => {
      setChosen("");
      onChange(view);
    },
  });
  const linked = new Set([task.id, ...task.blockedBy.map(({ id }) => id), ...task.blocking.map(({ id }) => id)]);
  const candidates = (open.data ?? []).filter(({ id }) => !linked.has(id));
  if (candidates.length === 0) return null;
  return (
    <form
      className="row small"
      onSubmit={(event) => {
        event.preventDefault();
        if (chosen !== "") add.mutate(chosen);
      }}
    >
      <label>
        {TEXT.tasks.waitsOn}
        <select value={chosen} onChange={(event) => setChosen(event.target.value)}>
          <option value="">{TEXT.tasks.chooseTask}</option>
          {candidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {TEXT.tasks.numbered(candidate.number)} {candidate.title}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={chosen === "" || add.isPending}>
        {TEXT.tasks.addBlocker}
      </button>
      <ErrorNotice error={add.error} />
    </form>
  );
}

function Related({
  task,
  admin,
  onChange,
}: {
  task: TaskDetailView;
  admin: boolean;
  onChange: (task: TaskDetailView) => void;
}) {
  const remove = useMutation({
    mutationFn: (blockerId: string) =>
      api<TaskDetailView>("DELETE", apiPath(API_ROUTES.taskBlocker, { taskId: task.id, blockerId })),
    onSuccess: onChange,
  });
  const groups = [
    { label: TEXT.tasks.subtasks, tasks: task.subtasks, removable: false },
    { label: TEXT.tasks.waitingOn, tasks: task.blockedBy, removable: admin },
    { label: TEXT.tasks.holdsUp, tasks: task.blocking, removable: false },
  ].filter((group) => group.tasks.length > 0);
  return (
    <>
      {groups.map((group) => (
        <div key={group.label} className="stack">
          <span className="small muted">{group.label}</span>
          {group.tasks.map((related) => (
            <span key={related.id} className="row small">
              <Link to={taskLink(related.id)} className="row">
                <Badge value={related.status} />
                {TEXT.tasks.numbered(related.number)} {related.title}
              </Link>
              {group.removable && (
                <button
                  type="button"
                  className="quiet"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(related.id)}
                >
                  {TEXT.tasks.stopWaiting(related.number)}
                </button>
              )}
            </span>
          ))}
        </div>
      ))}
      {admin && <WaitsOn task={task} onChange={onChange} />}
      <ErrorNotice error={remove.error} />
    </>
  );
}

function TaskContainer({ task, canAct }: { task: TaskDetailView; canAct: boolean }) {
  const container = task.container!;
  const siblings = useQuery({
    queryKey: ["containers", "host", container.hostId],
    queryFn: () =>
      api<ContainerView[]>(
        "GET",
        `${API_ROUTES.containers}?${new URLSearchParams({ [CONTAINER_QUERY.hostId]: container.hostId })}`,
      ),
    refetchInterval: INVENTORY_REFRESH_MILLISECONDS,
  });
  return (
    <div className="card inset stack">
      <div className="row">
        <Link to={containerLink(container.hostId, container.name)}>
          <strong>{container.name}</strong>
        </Link>
        <Badge value={container.state} />
        {container.problem !== null && <Badge value={container.problem} />}
        {container.update.status === UPDATE_STATUS.available && <Badge value={TEXT.updates.available} tone="warning" />}
        <span className="mono small muted">{container.image}</span>
      </div>
      <ContainerActions
        container={container}
        taskId={task.id}
        parked={hasParked(container, siblings.data ?? [])}
        canAct={canAct}
      />
    </div>
  );
}

export function TaskPanel({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const session = useSignedInSession();
  const admin = isAdmin(session);
  const queryClient = useQueryClient();
  const anchor = useRef<HTMLElement>(null);
  const detail = useQuery({
    queryKey: ["task", taskId],
    queryFn: () => api<TaskDetailView>("GET", apiPath(API_ROUTES.task, { taskId })),
    refetchInterval: INVENTORY_REFRESH_MILLISECONDS,
  });
  const assignees = useQuery({
    queryKey: ["assignees"],
    queryFn: () => api<AssignableView>("GET", API_ROUTES.assignees),
  });
  const updated = (task: TaskDetailView) => {
    queryClient.setQueryData(["task", taskId], task);
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
  };
  const change = useMutation({
    mutationFn: (request: TaskChangeRequest) =>
      api<TaskDetailView>("PATCH", apiPath(API_ROUTES.task, { taskId }), request),
    onSuccess: updated,
  });
  useEffect(() => {
    anchor.current?.scrollIntoView?.({ block: "nearest" });
  }, [taskId]);
  const task = detail.data;
  if (task === undefined) {
    return detail.error ? <ErrorNotice error={detail.error} /> : <Loading />;
  }
  return (
    <section ref={anchor} className="card stack" aria-label={TEXT.tasks.panel(task.number, task.title)}>
      <header className="panel-header">
        <h2>
          <span className="muted">{TEXT.tasks.numbered(task.number)}</span> {task.title}
        </h2>
        <button type="button" className="link" aria-label={TEXT.tasks.close} onClick={onClose}>
          {TEXT.tasks.removeMark}
        </button>
      </header>
      <div className="row">
        {task.checkedOut && <Badge value={TEXT.tasks.working} tone="warning" />}
        <label className="inline-field">
          {TEXT.tasks.status}
          <select
            value={task.status}
            disabled={!admin}
            onChange={(event) => change.mutate({ status: event.target.value as TaskStatus })}
          >
            {TASK_STATUSES.map((status) => (
              <option key={status} value={status}>
                {TEXT.tasks.statusNames[status]}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-field">
          {TEXT.tasks.priority}
          <select
            value={task.priority}
            disabled={!admin}
            onChange={(event) => change.mutate({ priority: event.target.value as TaskDetailView["priority"] })}
          >
            {TASK_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-field">
          {TEXT.tasks.assignee}
          <select
            value={assigneeValue(task.assignee)}
            disabled={!admin}
            onChange={(event) => change.mutate({ assignee: assigneeOf(event.target.value) })}
          >
            <option value="">{TEXT.tasks.nobody}</option>
            {assignees.data?.users.map((user) => (
              <option key={user.id} value={assigneeValue({ kind: ASSIGNEE_KINDS.user, id: user.id })}>
                {user.name}
              </option>
            ))}
            {autohealCanTake(task.labels, task.resource?.kind) &&
              assignees.data?.agents.map((agent) => (
                <option key={agent.id} value={assigneeValue({ kind: ASSIGNEE_KINDS.agent, id: agent.id })}>
                  {agent.name}
                </option>
              ))}
          </select>
        </label>
      </div>
      <p className="muted small">
        {TEXT.tasks.openedBy(task.createdBy)} <TimeAgo timestamp={task.createdAt} />
        {task.hostId !== null && (
          <>
            {TEXT.separator}
            <Link to={hostLink(task.hostId)}>{task.hostLabel}</Link>
          </>
        )}
        {task.occurrences > 1 && `${TEXT.separator}${TEXT.tasks.occurrences(task.occurrences)}`}
        {task.incidentId !== null && (
          <>
            {TEXT.separator}
            <Link to={apiPath(PATHS.incident, { incidentId: task.incidentId })}>{TEXT.tasks.incident}</Link>
          </>
        )}
      </p>
      {task.snoozedUntil !== null && (
        <p className="row small muted">
          {TEXT.tasks.snoozedUntil(dateTime(task.snoozedUntil))}
          {admin && (
            <button type="button" className="link" onClick={() => change.mutate({ snoozed: false })}>
              {TEXT.tasks.wake}
            </button>
          )}
        </p>
      )}
      <Labels task={task} canEdit={admin} onChange={(labels) => change.mutate({ labels })} />
      {task.description !== "" && <p className="pre-wrap">{task.description}</p>}
      {task.container !== null && <TaskContainer task={task} canAct={admin} />}
      {task.labels.includes(TASK_LABEL.packages) && task.hostId !== null && (
        <>
          <RebootWarning hostId={task.hostId} hostLabel={task.hostLabel ?? ""} admin={admin} />
          <HostPackages hostId={task.hostId} admin={admin} />
        </>
      )}
      <Related task={task} admin={admin} onChange={updated} />
      <Timeline task={task} />
      {admin && <CommentForm taskId={taskId} onDone={updated} />}
      <ErrorNotice error={change.error ?? assignees.error} />
    </section>
  );
}
