import { DockerClient, type DockerConnection } from "../../runner/docker-client.js";
import { AUTOHEAL_RUNNER_COMMAND, CONTAINER_STATE_RUNNING } from "../../shared/constants.js";

/**
 * Whether an Autoheal runner container runs on this Docker: a host the control plane looks after itself, over SSH or
 * in place, waits until it is gone, so two never look after the same containers.
 */
export async function runnerContainerRunning(connection: DockerConnection): Promise<boolean> {
  const containers = await new DockerClient(connection).containerSummaries();
  return containers.some(
    (container) => container.State === CONTAINER_STATE_RUNNING && AUTOHEAL_RUNNER_COMMAND.test(container.Command ?? ""),
  );
}
