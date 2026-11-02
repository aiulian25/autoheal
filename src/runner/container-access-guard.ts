import { CONTAINER_ACCESS_REFUSALS, CONTAINER_STATE_RUNNING, isParkedContainer } from "../shared/constants.js";
import type { DockerClient } from "./docker-client.js";

/** What the host's own .env says about reaching inside its containers. */
export interface ContainerAccessSettings {
  containerAccess: boolean;
  dryRun: boolean;
  protectedContainers: ReadonlySet<string>;
  selfContainerName: string;
}

/**
 * Why this host will not let anyone reach inside a container, for a shell, its files or its settings; null when
 * it will. The host decides first, as for any action, whatever the dashboard asked. A shell and files need it
 * running; its settings do not, so a container that fails for a wrong setting can be put right.
 */
export async function containerAccessRefusal(
  name: string,
  settings: ContainerAccessSettings,
  docker: Pick<DockerClient, "inspect">,
  needs: { running: boolean } = { running: true },
): Promise<string | null> {
  if (!settings.containerAccess) {
    return CONTAINER_ACCESS_REFUSALS.off;
  }
  if (settings.dryRun) {
    return CONTAINER_ACCESS_REFUSALS.dryRun;
  }
  if (name === settings.selfContainerName) {
    return CONTAINER_ACCESS_REFUSALS.self;
  }
  if (settings.protectedContainers.has(name)) {
    return CONTAINER_ACCESS_REFUSALS.protected(name);
  }
  if (isParkedContainer(name)) {
    return CONTAINER_ACCESS_REFUSALS.parked(name);
  }
  const container = await docker.inspect(name);
  if (container === null) {
    return CONTAINER_ACCESS_REFUSALS.missing(name);
  }
  if (needs.running && container.State.Status !== CONTAINER_STATE_RUNNING) {
    return CONTAINER_ACCESS_REFUSALS.notRunning(name);
  }
  return null;
}
