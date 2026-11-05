import { apiPath, type TaskSummaryView } from "../../src/shared/api.js";
import { HOST_SECTIONS, TASK_LABEL, TASK_RESOURCE } from "../../src/shared/constants.js";
import { PATHS, SEARCH_PARAMETERS } from "./constants.js";

type HostSection = (typeof HOST_SECTIONS)[keyof typeof HOST_SECTIONS];

export const hostLink = (hostId: string) => apiPath(PATHS.host, { hostId });

/** The host's page with that container's row open and in view. */
export const containerLink = (hostId: string, name: string) =>
  `${hostLink(hostId)}?${new URLSearchParams({ [SEARCH_PARAMETERS.container]: name })}`;

export const hostSectionLink = (hostId: string, section: HostSection) => `${hostLink(hostId)}#${section}`;

/** Where on its host a task is looked at: its container's row, the disks, the updates, else the host itself. */
export function taskPlaceLink(task: TaskSummaryView): string | null {
  if (task.hostId === null) return null;
  if (task.resource?.kind === TASK_RESOURCE.container) return containerLink(task.hostId, task.resource.id);
  if (task.resource?.kind === TASK_RESOURCE.disk) return hostSectionLink(task.hostId, HOST_SECTIONS.overview);
  const isUpdate = task.labels.includes(TASK_LABEL.packages) || task.labels.includes(TASK_LABEL.update);
  if (isUpdate) return hostSectionLink(task.hostId, HOST_SECTIONS.updates);
  return hostLink(task.hostId);
}
