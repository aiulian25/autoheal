import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { BoardCardView, BoardView } from "../../../src/shared/api.js";
import { BOARD_CARD, TASK_LABEL, TASK_STATUS } from "../../../src/shared/constants.js";
import { Badge, ErrorNotice, Loading, PageHeader, TimeAgo } from "../components/common.js";
import { IncidentSummary } from "../components/incident-parts.js";
import { PATHS, SEARCH_PARAMETERS, TEXT } from "../constants.js";
import { boardQuery, containersQuery, enrolledHostsQuery, viewPreferencesQuery } from "../queries.js";
import { arrangedColumns } from "../../../src/shared/view-preferences.js";
import { BoardArrangementPanel } from "../components/board-arrangement.js";
import { StatusStrip } from "./attention-page.js";
import { TaskPanel } from "./tasks-page.js";

// Left to right, the way a problem moves; on a phone, what needs you comes first. A person may arrange their own.
const COLUMNS = [
  { key: "noticed", text: TEXT.board.columns.noticed },
  { key: "autoheal", text: TEXT.board.columns.autoheal },
  { key: "needsYou", text: TEXT.board.columns.needsYou },
  { key: "done", text: TEXT.board.columns.done },
] as const satisfies readonly { key: keyof BoardView; text: { title: string; hint: string; empty: string } }[];

// "incident:<id>" or "task:<id>": which card's details are open, kept in the address.
const SELECTION_SEPARATOR = ":";
const selectionOf = (card: BoardCardView) =>
  card.kind === BOARD_CARD.incident
    ? `${BOARD_CARD.incident}${SELECTION_SEPARATOR}${card.incident.id}`
    : `${BOARD_CARD.task}${SELECTION_SEPARATOR}${card.task.id}`;

interface CardFacts {
  badge: string;
  title: string;
  where: string;
  line: string;
  at: number;
}

function taskBadge(task: Extract<BoardCardView, { kind: typeof BOARD_CARD.task }>["task"]): string {
  if (task.status === TASK_STATUS.done) {
    return TASK_STATUS.done;
  }
  return task.labels.includes(TASK_LABEL.update) ? TASK_LABEL.update : task.priority;
}

function factsOf(card: BoardCardView): CardFacts {
  if (card.kind === BOARD_CARD.incident) {
    const { incident } = card;
    return {
      badge: incident.verdict ?? incident.status,
      title: incident.containerName,
      where: incident.hostLabel,
      line: TEXT.incident.triggers[incident.trigger],
      at: incident.updatedAt,
    };
  }
  const { task } = card;
  return {
    badge: taskBadge(task),
    title: task.title,
    where: [task.resource?.label, task.hostLabel].filter(Boolean).join(TEXT.separator),
    line: [TEXT.tasks.statusNames[task.status], task.assignee?.name ?? TEXT.tasks.nobody].join(TEXT.separator),
    at: task.closedAt ?? task.updatedAt,
  };
}

function BoardCard({ card, selected, onSelect }: { card: BoardCardView; selected: boolean; onSelect: () => void }) {
  const facts = factsOf(card);
  return (
    <button type="button" className="flow-card" aria-pressed={selected} onClick={onSelect}>
      <Badge value={facts.badge} />
      <strong>{facts.title}</strong>
      <span className="small muted">{facts.where}</span>
      <span className="small">
        {facts.line}
        {TEXT.separator}
        <TimeAgo timestamp={facts.at} />
      </span>
    </button>
  );
}

function IncidentPanel({ incidentId, onClose }: { incidentId: string; onClose: () => void }) {
  const anchor = useRef<HTMLElement>(null);
  // On a phone the panel sits above the columns: bring it into view, as the task panel does.
  useEffect(() => {
    anchor.current?.scrollIntoView?.({ block: "nearest" });
  }, [incidentId]);
  return (
    <section ref={anchor} className="card">
      <IncidentSummary incidentId={incidentId} onClose={onClose} />
    </section>
  );
}

function Drawer({ selection, onClose }: { selection: string; onClose: () => void }) {
  const [kind, id = ""] = selection.split(SELECTION_SEPARATOR);
  return (
    <aside className="drawer">
      {kind === BOARD_CARD.task ? (
        <TaskPanel taskId={id} onClose={onClose} />
      ) : (
        <IncidentPanel incidentId={id} onClose={onClose} />
      )}
    </aside>
  );
}

/** Every open problem in the column of who has it now, from noticed to done; details open beside it. */
export function BoardPage() {
  const board = useQuery(boardQuery);
  const hosts = useQuery(enrolledHostsQuery);
  const containers = useQuery(containersQuery);
  const preferences = useQuery(viewPreferencesQuery);
  const [arranging, setArranging] = useState(false);
  const arranged = arrangedColumns(preferences.data?.board ?? null);
  const columns = arranged.visible.map((key) => COLUMNS.find((column) => column.key === key)!);
  const [parameters, setParameters] = useSearchParams();
  const open = parameters.get(SEARCH_PARAMETERS.open);
  const choose = (selection: string | null) =>
    setParameters(
      (current) => {
        const next = new URLSearchParams(current);
        if (selection === null) {
          next.delete(SEARCH_PARAMETERS.open);
          return next;
        }
        next.set(SEARCH_PARAMETERS.open, selection);
        return next;
      },
      { replace: true },
    );
  // A card clicked again closes its details, like a container row.
  const toggle = (selection: string) => choose(open === selection ? null : selection);
  return (
    <div className="page">
      <PageHeader title={TEXT.board.title} lede={TEXT.board.lede}>
        <Link to={PATHS.home}>{TEXT.board.asList}</Link>
        <button type="button" className="quiet" aria-expanded={arranging} onClick={() => setArranging(!arranging)}>
          {arranging ? TEXT.boardArrangement.close : TEXT.boardArrangement.open}
        </button>
      </PageHeader>
      {arranging && <BoardArrangementPanel board={preferences.data?.board ?? null} />}
      <StatusStrip hosts={hosts.data ?? []} containers={containers.data ?? []} />
      {board.data === undefined && <Loading />}
      {board.data !== undefined && (
        <div className={open === null ? "board-layout" : "board-layout with-drawer"}>
          <div className="board">
            {columns.map((column) => (
              <section key={column.key} className={`column ${column.key}`} aria-label={column.text.title}>
                <h2>
                  {column.text.title} <span className="muted">{board.data[column.key].length}</span>
                </h2>
                <p className="small muted">{column.text.hint}</p>
                {board.data[column.key].length === 0 && <p className="small muted">{column.text.empty}</p>}
                {board.data[column.key].map((card) => (
                  <BoardCard
                    key={selectionOf(card)}
                    card={card}
                    selected={open === selectionOf(card)}
                    onSelect={() => toggle(selectionOf(card))}
                  />
                ))}
              </section>
            ))}
          </div>
          {open !== null && <Drawer selection={open} onClose={() => choose(null)} />}
        </div>
      )}
      {arranged.hidden.length > 0 && board.data !== undefined && (
        <p className="small muted">
          {TEXT.boardArrangement.hidden(
            arranged.hidden.map((key) => `${TEXT.board.columns[key].title} (${board.data[key].length})`).join(", "),
          )}
        </p>
      )}
      <ErrorNotice error={board.error} />
    </div>
  );
}
