import { hasUpdate, type BoardCardView, type ContainerView, type TaskSummaryView } from "../../src/shared/api.js";
import { BOARD_CARD, TASK_ABOUT, TASK_LABEL, TASK_RESOURCE } from "../../src/shared/constants.js";

export type IncidentCard = Extract<BoardCardView, { kind: typeof BOARD_CARD.incident }>;
export type TaskCard = Extract<BoardCardView, { kind: typeof BOARD_CARD.task }>;

export const isIncident = (card: BoardCardView): card is IncidentCard => card.kind === BOARD_CARD.incident;
export const isTask = (card: BoardCardView): card is TaskCard => card.kind === BOARD_CARD.task;
// Image updates and a host's own packages go under Updates; every other task is a problem to fix.
export const isUpdateTask = (task: TaskSummaryView) =>
  task.labels.includes(TASK_LABEL.update) || task.labels.includes(TASK_LABEL.packages);

// A host's package tasks its group under Updates draws; the one about its updates stands behind its package list.
const HOST_PACKAGE_TASKS: ReadonlySet<string | null> = new Set([
  TASK_ABOUT.osUpdates,
  TASK_ABOUT.reboot,
  TASK_ABOUT.lifecycle,
]);
export const isHostPackageTask = (task: TaskSummaryView) =>
  task.labels.includes(TASK_LABEL.packages) && HOST_PACKAGE_TASKS.has(task.about);
const drawnUnderUpdates = (task: TaskSummaryView) => task.labels.includes(TASK_LABEL.update) || isHostPackageTask(task);

/**
 * What needs a person, sorted the way the Attention page shows it: decisions to take, and problems to fix, which are
 * every task the Updates card does not draw, so all that is counted is somewhere to see.
 */
export function whatNeedsYou(needsYou: readonly BoardCardView[]) {
  return {
    decisions: needsYou.filter(isIncident),
    problems: needsYou.filter(isTask).filter((card) => !drawnUnderUpdates(card.task)),
  };
}

// The container an update task is about: the one a run updates.
export const containerOf = (task: TaskSummaryView) =>
  task.resource?.kind === TASK_RESOURCE.container ? task.resource.id : null;

// As its host last reported it, the container still has its new image waiting: its task is no history.
export const stillWaits = (task: TaskSummaryView, containers: readonly ContainerView[]) =>
  containers.some(
    (container) => container.hostId === task.hostId && container.name === containerOf(task) && hasUpdate(container),
  );
