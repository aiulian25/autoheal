import {
  TASK_FILTERS,
  type BoardCardView,
  type BoardView,
  type IncidentSummaryView,
  type TaskSummaryView,
} from "../../shared/api.js";
import {
  BOARD_CARD,
  BOARD_COLUMN_LIMIT,
  BOARD_DONE_WINDOW_MILLISECONDS,
  INCIDENT_SETTLED_STATUSES,
  INCIDENT_STATUS,
  INCIDENT_WORKING_STATUSES,
  PRESSING_TASK_PRIORITIES,
  TASK_LABEL,
  TASK_STATUS,
  type IncidentStatus,
} from "../../shared/constants.js";
import type { IncidentsService } from "../incidents/incidents-service.js";
import type { TasksService } from "../tasks/tasks-service.js";
import { ANOMALY_TASK_LABEL } from "../../shared/metric-trends.js";

const incidentCard = (incident: IncidentSummaryView): BoardCardView => ({ kind: BOARD_CARD.incident, incident });
const taskCard = (task: TaskSummaryView): BoardCardView => ({ kind: BOARD_CARD.task, task });

const timeOf = (card: BoardCardView) =>
  card.kind === BOARD_CARD.incident ? card.incident.updatedAt : (card.task.closedAt ?? card.task.updatedAt);
const newestFirst = (first: BoardCardView, second: BoardCardView) => timeOf(second) - timeOf(first);

const autohealHas = (task: TaskSummaryView) => task.assignee?.kind === "agent";
const idsOf = (incidents: readonly IncidentSummaryView[]) => new Set(incidents.map((incident) => incident.id));
const linkedTo = (task: TaskSummaryView, incidentIds: ReadonlySet<string>) =>
  task.incidentId !== null && incidentIds.has(task.incidentId);

/**
 * The board: every open problem in the column of who has it now. Autoheal has what it is still
 * deciding or doing; a person has escalations, and their pressing tasks and updates waiting for a
 * click; the rest is noticed, and may still clear by itself. What was settled in the last day ends it.
 */
export class BoardService {
  constructor(
    private readonly incidents: Pick<IncidentsService, "list">,
    private readonly tasks: Pick<TasksService, "list">,
    private readonly clock: () => number = Date.now,
  ) {}

  board(viewerId: string): BoardView {
    const since = this.clock() - BOARD_DONE_WINDOW_MILLISECONDS;
    const waiting = this.incidentsIn([INCIDENT_STATUS.awaitingApproval]);
    const working = this.incidentsIn(INCIDENT_WORKING_STATUSES);
    const settled = this.incidentsIn(INCIDENT_SETTLED_STATUSES).filter((incident) => incident.updatedAt >= since);
    // An incident's own task would only say it twice while the incident is on the board. Once it
    // is settled, a task still open is somebody's work and shows on its own.
    const active = idsOf([...waiting, ...working]);
    const shown = idsOf([...waiting, ...working, ...settled]);
    const open = this.tasks.list({ status: TASK_FILTERS.open }, viewerId).filter((task) => !linkedTo(task, active));
    const closed = this.tasks
      .list({ status: TASK_STATUS.done }, viewerId)
      .filter((task) => !linkedTo(task, shown) && (task.closedAt ?? 0) >= since);
    const needsPerson = (task: TaskSummaryView) => this.needsPerson(task, viewerId);
    const noticed = (task: TaskSummaryView) => !autohealHas(task) && !needsPerson(task);
    return {
      needsYou: [...waiting.map(incidentCard), ...open.filter(needsPerson).map(taskCard)].slice(0, BOARD_COLUMN_LIMIT),
      autoheal: [...working.map(incidentCard), ...open.filter(autohealHas).map(taskCard)].slice(0, BOARD_COLUMN_LIMIT),
      noticed: open.filter(noticed).map(taskCard).slice(0, BOARD_COLUMN_LIMIT),
      done: [...settled.map(incidentCard), ...closed.map(taskCard)].sort(newestFirst).slice(0, BOARD_COLUMN_LIMIT),
    };
  }

  // Someone else's task stays theirs; the viewer's own and nobody's come to them when they press, unless
  // they put it off for now.
  private needsPerson(task: TaskSummaryView, viewerId: string): boolean {
    const someoneElses = task.assignee !== null && task.assignee.id !== viewerId;
    if (autohealHas(task) || someoneElses || task.snoozedUntil !== null) {
      return false;
    }
    // Updates, packages and anomaly observations need a person's review regardless of severity.
    const waitsForDecision =
      task.labels.includes(TASK_LABEL.update) ||
      task.labels.includes(TASK_LABEL.packages) ||
      task.labels.includes(ANOMALY_TASK_LABEL);
    return PRESSING_TASK_PRIORITIES.includes(task.priority) || waitsForDecision;
  }

  private incidentsIn(statuses: readonly IncidentStatus[]): IncidentSummaryView[] {
    return statuses
      .flatMap((status) => this.incidents.list({ status }))
      .sort((first, second) => second.updatedAt - first.updatedAt);
  }
}
