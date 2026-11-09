import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { API_ROUTES, type TaskDetailView, type TaskSummaryView } from "../../../src/shared/api.js";
import { CLOSED_TASK_STATUSES, OPEN_TASK_STATUSES } from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { Badge, ErrorNotice, Loading, PageHeader, TimeAgo, rowClick } from "../components/common.js";
import {
  INVENTORY_REFRESH_MILLISECONDS,
  PATHS,
  TASK_LIST_VIEW,
  TASK_SEARCH_PARAMETERS,
  TASK_SHOW,
  TEXT,
} from "../constants.js";
import { isAdmin, useSignedInSession } from "../session.js";
import { type Show, taskLink, listQuery } from "./task-queries.js";
import { TaskPanel } from "./task-panel.js";

const isShow = (value: string | null): value is Show => Object.values(TASK_SHOW).some((show) => show === value);

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
