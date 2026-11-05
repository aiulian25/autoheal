import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  API_ROUTES,
  CONTAINER_QUERY,
  TASK_FILTERS,
  TASK_QUERY,
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
  CLOSED_TASK_STATUSES,
  OPEN_TASK_STATUSES,
  TASK_LABEL,
  TASK_LABEL_PATTERN,
  TASK_PRIORITIES,
  TASK_STATUSES,
  UPDATE_STATUS,
  type TaskStatus,
} from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { containerLink, hostLink } from "../host-links.js";
import { Badge, ErrorNotice, Loading, PageHeader, TimeAgo, rowClick } from "../components/common.js";
import { ContainerActions, hasParked } from "../components/container-actions.js";
import {
  ASSIGNEE_KINDS,
  ASSIGNEE_SEPARATOR,
  INVENTORY_REFRESH_MILLISECONDS,
  PATHS,
  TASK_LIST_VIEW,
  TASK_SEARCH_PARAMETERS,
  TASK_SHOW,
  TEXT,
} from "../constants.js";
import { dateTime } from "../format.js";
import { isAdmin, useSignedInSession } from "../session.js";
import { HostPackages, RebootWarning } from "./host-packages.js";

type Show = (typeof TASK_SHOW)[keyof typeof TASK_SHOW];

const taskLink = (taskId: string) => apiPath(PATHS.task, { taskId });

// Each quick filter is a question the list answers: what is open, what is mine, what Autoheal is doing.
const SHOW_QUERIES: Record<Show, Record<string, string>> = {
  [TASK_SHOW.open]: { [TASK_QUERY.status]: TASK_FILTERS.open },
  [TASK_SHOW.mine]: { [TASK_QUERY.status]: TASK_FILTERS.open, [TASK_QUERY.assignee]: TASK_FILTERS.me },
  [TASK_SHOW.autoheal]: { [TASK_QUERY.status]: TASK_FILTERS.open, [TASK_QUERY.assignee]: AGENT_AUTOHEAL },
  [TASK_SHOW.updates]: { [TASK_QUERY.status]: TASK_FILTERS.open, [TASK_QUERY.label]: TASK_LABEL.update },
  [TASK_SHOW.closed]: { [TASK_QUERY.status]: TASK_FILTERS.closed },
};

const isShow = (value: string | null): value is Show => Object.values(TASK_SHOW).some((show) => show === value);

function listQuery(show: Show, search: string) {
  const query = new URLSearchParams(SHOW_QUERIES[show]);
  if (search.trim() !== "") {
    query.set(TASK_QUERY.search, search.trim());
  }
  return query.toString();
}

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

function NewTask() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: (title: string) => api<TaskDetailView>("POST", API_ROUTES.tasks, { title }),
    onSuccess: (task) => {
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void navigate(taskLink(task.id));
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = String(new FormData(event.currentTarget).get("title") ?? "").trim();
    if (title !== "") {
      create.mutate(title);
      event.currentTarget.reset();
    }
  };
  return (
    <form className="row" onSubmit={submit}>
      <input name="title" aria-label={TEXT.tasks.newTitle} placeholder={TEXT.tasks.newPlaceholder} required />
      <button className="primary" type="submit" disabled={create.isPending}>
        {TEXT.tasks.add}
      </button>
      <ErrorNotice error={create.error} />
    </form>
  );
}

function TaskWhat({ task }: { task: TaskSummaryView }) {
  return (
    <span className="muted small">
      {[task.resource?.label, task.hostLabel].filter(Boolean).join(TEXT.separator)}
      {task.occurrences > 1 && `${TEXT.separator}${TEXT.tasks.occurrences(task.occurrences)}`}
    </span>
  );
}

function TaskList({
  tasks,
  selected,
  onSelect,
}: {
  tasks: TaskSummaryView[];
  selected: string | undefined;
  onSelect: (taskId: string) => void;
}) {
  if (tasks.length === 0) {
    return <p className="muted">{TEXT.tasks.empty}</p>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{TEXT.tasks.number}</th>
            <th>{TEXT.tasks.task}</th>
            <th>{TEXT.tasks.priority}</th>
            <th>{TEXT.tasks.status}</th>
            <th>{TEXT.tasks.assignee}</th>
            <th>{TEXT.tasks.updated}</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr
              key={task.id}
              className={task.id === selected ? "clickable selected" : "clickable"}
              onClick={rowClick(() => onSelect(task.id))}
            >
              <td className="mono small">{TEXT.tasks.numbered(task.number)}</td>
              <td>
                <button
                  type="button"
                  className="link"
                  aria-pressed={task.id === selected}
                  onClick={() => onSelect(task.id)}
                >
                  {task.title}
                </button>
                <div>
                  <TaskWhat task={task} />
                </div>
              </td>
              <td>
                <Badge value={task.priority} />
              </td>
              <td className="small">{TEXT.tasks.statusNames[task.status]}</td>
              <td className="small">{task.assignee?.name ?? TEXT.tasks.nobody}</td>
              <td className="small">
                <TimeAgo timestamp={task.updatedAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TaskBoard({
  tasks,
  closed,
  selected,
  onSelect,
}: {
  tasks: TaskSummaryView[];
  // Closed tasks have their own two columns.
  closed: boolean;
  selected: string | undefined;
  onSelect: (taskId: string) => void;
}) {
  const statuses = closed ? CLOSED_TASK_STATUSES : OPEN_TASK_STATUSES;
  const columns = statuses.map((status) => ({
    status,
    tasks: tasks.filter((task) => task.status === status),
  }));
  return (
    <div className="board">
      {columns.map((column) => (
        <section key={column.status} className="column" aria-label={TEXT.tasks.statusNames[column.status]}>
          <h2>
            {TEXT.tasks.statusNames[column.status]} <span className="muted">{column.tasks.length}</span>
          </h2>
          {column.tasks.map((task) => (
            <button
              key={task.id}
              type="button"
              className="flow-card"
              aria-pressed={task.id === selected}
              onClick={() => onSelect(task.id)}
            >
              <span className="row">
                <Badge value={task.priority} />
                <span className="mono small muted">{TEXT.tasks.numbered(task.number)}</span>
              </span>
              <span>{task.title}</span>
              <TaskWhat task={task} />
              <span className="small">{task.assignee?.name ?? TEXT.tasks.nobody}</span>
            </button>
          ))}
        </section>
      ))}
    </div>
  );
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

function Related({ task }: { task: TaskDetailView }) {
  const groups = [
    { label: TEXT.tasks.subtasks, tasks: task.subtasks },
    { label: TEXT.tasks.waitingOn, tasks: task.blockedBy },
    { label: TEXT.tasks.holdsUp, tasks: task.blocking },
  ].filter((group) => group.tasks.length > 0);
  return groups.map((group) => (
    <div key={group.label} className="stack">
      <span className="small muted">{group.label}</span>
      {group.tasks.map((related) => (
        <Link key={related.id} to={taskLink(related.id)} className="row small">
          <Badge value={related.status} />
          {TEXT.tasks.numbered(related.number)} {related.title}
        </Link>
      ))}
    </div>
  ));
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
      <Related task={task} />
      <Timeline task={task} />
      {admin && <CommentForm taskId={taskId} onDone={updated} />}
      <ErrorNotice error={change.error ?? assignees.error} />
    </section>
  );
}

/**
 * Every task on one screen: the board (or the list) on one side, the chosen task on the other,
 * with its container's actions right there. The address keeps the choice and the filter.
 */
export function TasksPage() {
  const session = useSignedInSession();
  const { taskId } = useParams();
  const navigate = useNavigate();
  const [parameters, setParameters] = useSearchParams();
  const shown = parameters.get(TASK_SEARCH_PARAMETERS.show);
  const show: Show = isShow(shown) ? shown : TASK_SHOW.open;
  const board = parameters.get(TASK_SEARCH_PARAMETERS.view) !== TASK_LIST_VIEW;
  const [search, setSearch] = useState(parameters.get(TASK_SEARCH_PARAMETERS.search) ?? "");
  const query = listQuery(show, search);
  const tasks = useQuery({
    queryKey: ["tasks", query],
    queryFn: () => api<TaskSummaryView[]>("GET", `${API_ROUTES.tasks}?${query}`),
    refetchInterval: INVENTORY_REFRESH_MILLISECONDS,
  });
  const setParameter = (name: string, value: string | null) =>
    setParameters(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === null) {
          next.delete(name);
          return next;
        }
        next.set(name, value);
        return next;
      },
      { replace: true },
    );
  const close = () => void navigate(`${PATHS.tasks}?${parameters}`);
  // A task clicked again closes its panel, like a board card or a container row.
  const select = (id: string) => (id === taskId ? close() : void navigate(`${taskLink(id)}?${parameters}`));
  const items = tasks.data ?? [];
  return (
    <div className="page">
      <PageHeader title={TEXT.tasks.title}>{isAdmin(session) && <NewTask />}</PageHeader>
      <div className="filters">
        <div className="row" role="group" aria-label={TEXT.tasks.showLabel}>
          {Object.values(TASK_SHOW).map((value) => (
            <button
              key={value}
              type="button"
              className={value === show ? "chip-button active" : "chip-button"}
              aria-pressed={value === show}
              onClick={() => setParameter(TASK_SEARCH_PARAMETERS.show, value === TASK_SHOW.open ? null : value)}
            >
              {TEXT.tasks.show[value]}
            </button>
          ))}
        </div>
        <input
          type="search"
          aria-label={TEXT.tasks.search}
          placeholder={TEXT.tasks.search}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setParameter(TASK_SEARCH_PARAMETERS.search, event.target.value === "" ? null : event.target.value);
          }}
        />
        <div className="row" role="group" aria-label={TEXT.tasks.viewLabel}>
          <button
            type="button"
            className={board ? "chip-button active" : "chip-button"}
            aria-pressed={board}
            onClick={() => setParameter(TASK_SEARCH_PARAMETERS.view, null)}
          >
            {TEXT.tasks.board}
          </button>
          <button
            type="button"
            className={board ? "chip-button" : "chip-button active"}
            aria-pressed={!board}
            onClick={() => setParameter(TASK_SEARCH_PARAMETERS.view, TASK_LIST_VIEW)}
          >
            {TEXT.tasks.list}
          </button>
        </div>
      </div>
      <div className={taskId === undefined ? "board-layout" : "board-layout with-drawer"}>
        <div>
          {tasks.data === undefined && <Loading />}
          {tasks.data !== undefined && board && (
            <TaskBoard tasks={items} closed={show === TASK_SHOW.closed} selected={taskId} onSelect={select} />
          )}
          {tasks.data !== undefined && !board && <TaskList tasks={items} selected={taskId} onSelect={select} />}
        </div>
        {taskId !== undefined && (
          <aside className="drawer">
            <TaskPanel taskId={taskId} onClose={close} />
          </aside>
        )}
      </div>
      <ErrorNotice error={tasks.error} />
    </div>
  );
}
