import {
  CONTAINER_PROBLEMS,
  CONTAINER_STATE_DEAD,
  CONTAINER_STATE_EXITED,
  CONTAINER_STATE_RESTARTING,
  DELIBERATE_EXIT_CODES,
  HEALTH_UNHEALTHY,
  type ContainerProblem,
} from "./constants.js";
import type { ContainerSnapshot } from "./protocol.js";

type ProblemSignals = Pick<ContainerSnapshot, "state" | "health" | "exitCode" | "oomKilled">;

// How a stopped container stopped. A stop on purpose is not a problem; a crash is.
function exitProblem(container: ProblemSignals): ContainerProblem | null {
  if (container.oomKilled) {
    return CONTAINER_PROBLEMS.outOfMemory;
  }
  const crashed = container.exitCode !== null && !DELIBERATE_EXIT_CODES.has(container.exitCode);
  return crashed ? CONTAINER_PROBLEMS.crashed : null;
}

/**
 * Why a container needs attention, or null: the dashboard shows it, and a runner that was not listening heals by
 * it. Its state comes first: Docker keeps the last health status of a container that has stopped, and that stale
 * "unhealthy" says less than the crash.
 */
export function containerProblem(container: ProblemSignals): ContainerProblem | null {
  if (container.state === CONTAINER_STATE_RESTARTING) {
    return CONTAINER_PROBLEMS.restarting;
  }
  if (container.state === CONTAINER_STATE_DEAD) {
    return CONTAINER_PROBLEMS.dead;
  }
  if (container.state === CONTAINER_STATE_EXITED) {
    return exitProblem(container);
  }
  return container.health === HEALTH_UNHEALTHY ? CONTAINER_PROBLEMS.unhealthy : null;
}
