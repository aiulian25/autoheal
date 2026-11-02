import type { BoardCardView, TaskSummaryView } from "../../src/shared/api.js";
import { BOARD_CARD, TASK_LABEL } from "../../src/shared/constants.js";

export type IncidentCard = Extract<BoardCardView, { kind: typeof BOARD_CARD.incident }>;
export type TaskCard = Extract<BoardCardView, { kind: typeof BOARD_CARD.task }>;

export const isIncident = (card: BoardCardView): card is IncidentCard => card.kind === BOARD_CARD.incident;
export const isTask = (card: BoardCardView): card is TaskCard => card.kind === BOARD_CARD.task;
// Image updates and a host's own packages go under Updates; every other task is a problem to fix.
export const isUpdateTask = (task: TaskSummaryView) =>
  task.labels.includes(TASK_LABEL.update) || task.labels.includes(TASK_LABEL.packages);

/** What needs a person, sorted the way the Attention page shows it: decisions to take, and problems to fix. */
export function whatNeedsYou(needsYou: readonly BoardCardView[]) {
  return {
    decisions: needsYou.filter(isIncident),
    problems: needsYou.filter(isTask).filter((card) => !isUpdateTask(card.task)),
  };
}
