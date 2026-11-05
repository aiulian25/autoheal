import {
  DEFAULT_HEALTH_SHELL,
  HEALTH_HEALTHY,
  HEALTH_PROBE_OUTPUT_BYTES,
  HEALTH_STARTING,
  HEALTH_TEST,
  HEALTH_UNHEALTHY,
  RESTART_POLICY_NONE,
} from "../shared/constants.js";
import type { DockerClient } from "./docker-client.js";
import {
  restartPolicyOf,
  type ContainerConfig,
  type ContainerDetails,
  type ContainerState,
} from "./incident-report.js";

/** Whether a container that is still starting already passes its own health check. */
export type HealthProbe = (container: ContainerDetails) => Promise<boolean>;

/** The command Docker runs as a container's health check, as arguments; null where it has none. */
export function healthCommandOf(config: ContainerConfig): string[] | null {
  const [kind, ...rest] = (config.Healthcheck as { Test?: string[] } | undefined)?.Test ?? [];
  if (kind === HEALTH_TEST.command && rest.length > 0) return rest;
  if (kind !== HEALTH_TEST.shell || rest[0] === undefined) return null;
  const shell = (config.Shell as string[] | null | undefined) ?? DEFAULT_HEALTH_SHELL;
  return [...shell, rest[0]];
}

/**
 * Runs a container's own health check now, as Docker would, instead of waiting for Docker's first one, which comes
 * only after the image's interval (30 seconds unless it says otherwise). Changes nothing on the container.
 */
export const healthProbe =
  (docker: Pick<DockerClient, "runCommand">): HealthProbe =>
  async (container) => {
    const command = healthCommandOf(container.Config);
    if (command === null || container.Id === undefined) return false;
    const result = await docker.runCommand(container.Id, command, HEALTH_PROBE_OUTPUT_BYTES).catch(() => null);
    return result?.exitCode === 0;
  };

/** How long to watch a container that was just started, and how often to look. */
export interface SettleTiming {
  pollMilliseconds: number;
  // Running this long without a health check counts as settled.
  settleMilliseconds: number;
  // A passing health check counts once it has run this long too.
  healthySettleMilliseconds: number;
  timeoutMilliseconds: number;
}

/** What to say about a container that did not settle. */
export interface SettleProblems {
  gone: string;
  stopped: (exitCode: number | undefined) => string;
  restarting: string;
  unhealthy: string;
  slow: string;
}

// One look: settled (null), what is wrong, or undefined while it is too early to say.
function problemOf(
  state: ContainerState,
  elapsed: number,
  timing: SettleTiming,
  problems: SettleProblems,
): string | null | undefined {
  if (state.Restarting) {
    return problems.restarting;
  }
  if (!state.Running) {
    return problems.stopped(state.ExitCode);
  }
  const health = state.Health?.Status;
  if (health === HEALTH_UNHEALTHY) {
    return problems.unhealthy;
  }
  if (health === undefined) {
    return elapsed >= timing.settleMilliseconds ? null : undefined;
  }
  return health === HEALTH_HEALTHY && elapsed >= timing.healthySettleMilliseconds ? null : undefined;
}

/**
 * Null once a container just started has run for a while (or turned healthy); otherwise what is wrong. With a
 * probe, a container still starting counts as healthy as soon as its own health check passes.
 */
export async function untilSettled(
  inspect: (container: string) => Promise<ContainerDetails | null>,
  container: string,
  timing: SettleTiming,
  problems: SettleProblems,
  wait: (milliseconds: number) => Promise<unknown>,
  clock: () => number,
  probe: HealthProbe | null = null,
): Promise<string | null> {
  const started = clock();
  while (clock() - started < timing.timeoutMilliseconds) {
    await wait(timing.pollMilliseconds);
    const details = await inspect(container);
    const state = details?.State;
    const problem = state === undefined ? problems.gone : problemOf(state, clock() - started, timing, problems);
    if (problem !== undefined) {
      return problem;
    }
    const stillStarting = details !== null && state?.Health?.Status === HEALTH_STARTING;
    if (stillStarting && probe !== null && (await probe(details))) {
      return null;
    }
  }
  return problems.slow;
}

/** How long a container that failed gets to come back, how long it must then stay up, and how often to look. */
export interface BackTiming {
  pollMilliseconds: number;
  upMilliseconds: number;
  timeoutMilliseconds: number;
}

/** What to say about a container that failed and did not come back. */
export interface BackProblems {
  gone: string;
  notRestarted: string;
  notBack: string;
}

// Running, not between two of Docker's restarts, and healthy if it has a health check.
const isUp = (state: ContainerState) =>
  state.Running === true && !state.Restarting && (state.Health === undefined || state.Health.Status === HEALTH_HEALTHY);

/**
 * Null once a container that failed is up again and has stayed up for a while; otherwise why it is not back.
 * Down at first is expected, as Docker's restart policy may take a minute to start it again; one whose policy
 * never starts it again is not waited for.
 */
export async function untilBack(
  inspect: (container: string) => Promise<ContainerDetails | null>,
  container: string,
  timing: BackTiming,
  problems: BackProblems,
  wait: (milliseconds: number) => Promise<unknown>,
  clock: () => number,
): Promise<string | null> {
  const started = clock();
  let upSince: number | null = null;
  while (clock() - started < timing.timeoutMilliseconds) {
    await wait(timing.pollMilliseconds);
    const details = await inspect(container);
    if (details === null) {
      return problems.gone;
    }
    const down = !details.State.Running && !details.State.Restarting;
    if (down && restartPolicyOf(details) === RESTART_POLICY_NONE) {
      return problems.notRestarted;
    }
    upSince = isUp(details.State) ? (upSince ?? clock()) : null;
    if (upSince !== null && clock() - upSince >= timing.upMilliseconds) {
      return null;
    }
  }
  return problems.notBack;
}
