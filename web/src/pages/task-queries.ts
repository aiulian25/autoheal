import { TASK_FILTERS, TASK_QUERY, apiPath } from "../../../src/shared/api.js";
import { AGENT_AUTOHEAL, TASK_LABEL } from "../../../src/shared/constants.js";
import { PATHS, TASK_SHOW } from "../constants.js";

export type Show = (typeof TASK_SHOW)[keyof typeof TASK_SHOW];

export const taskLink = (taskId: string) => apiPath(PATHS.task, { taskId });

// Each quick filter is a question the list answers: what is open, what is mine, what Autoheal is doing.
const SHOW_QUERIES: Record<Show, Record<string, string>> = {
  [TASK_SHOW.open]: { [TASK_QUERY.status]: TASK_FILTERS.open },
  [TASK_SHOW.mine]: { [TASK_QUERY.status]: TASK_FILTERS.open, [TASK_QUERY.assignee]: TASK_FILTERS.me },
  [TASK_SHOW.autoheal]: { [TASK_QUERY.status]: TASK_FILTERS.open, [TASK_QUERY.assignee]: AGENT_AUTOHEAL },
  [TASK_SHOW.updates]: { [TASK_QUERY.status]: TASK_FILTERS.open, [TASK_QUERY.label]: TASK_LABEL.update },
  [TASK_SHOW.closed]: { [TASK_QUERY.status]: TASK_FILTERS.closed },
};

export function listQuery(show: Show, search: string) {
  const query = new URLSearchParams(SHOW_QUERIES[show]);
  if (search.trim() !== "") {
    query.set(TASK_QUERY.search, search.trim());
  }
  return query.toString();
}
