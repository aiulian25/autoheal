import { HEALTH_HEALTHY, HEALTH_UNHEALTHY, RESTART_POLICY_NONE } from "../shared/constants.js";
import { restartPolicyOf, type ContainerDetails, type ContainerState } from "./incident-report.js";

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

/** Null once a container just started has run for a while (or turned healthy); otherwise what is wrong. */
export async function untilSettled(
  inspect: (container: string) => Promise<ContainerDetails | null>,
  container: string,
  timing: SettleTiming,
  problems: SettleProblems,
  wait: (milliseconds: number) => Promise<unknown>,
  clock: () => number,
): Promise<string | null> {
  const started = clock();
  while (clock() - started < timing.timeoutMilliseconds) {
    await wait(timing.pollMilliseconds);
    const state = (await inspect(container))?.State;
    const problem = state === undefined ? problems.gone : problemOf(state, clock() - started, timing, problems);
    if (problem !== undefined) {
      return problem;
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
