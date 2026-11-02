import { setTimeout as sleep } from "node:timers/promises";
import {
  BACK_PROBLEMS,
  BACK_VERIFY,
  OUTCOMES,
  JOB_OUTCOMES,
  RESTART_CHOICE,
  RESTART_CHOICES,
  RESTART_PROBLEMS,
  RESTART_VERIFY,
  RUNNER_MESSAGES,
  VERDICT_DRY_RUN,
  VERDICT_ESCALATED,
  VERDICT_FIXED,
  VERDICT_LEFT_ALONE,
  VERDICT_SKIPPED,
  isParkedContainer,
  type RestartChoice,
} from "../shared/constants.js";
import { isRestart, type Decision } from "../shared/decision.js";
import { describeError } from "../shared/errors.js";
import { log } from "../shared/log.js";
import type { HeartbeatResponse, Outcome } from "../shared/protocol.js";
import type { DockerClient } from "./docker-client.js";
import type { ContainerDetails } from "./incident-report.js";
import type { RemedyGuard } from "./remedy-guard.js";
import { untilBack, untilSettled } from "./settle-check.js";
import { containerResources, sameResources } from "./operation-coordinator.js";

const escalated = (outcome: string): Outcome => ({ outcome, verdict: VERDICT_ESCALATED, executed: false });

// A stopping runner does not wait for a restart it is still watching.
const unheldSleep = (milliseconds: number) => sleep(milliseconds, undefined, { ref: false });

/**
 * What Autoheal does about this container when it fails: restart it, ask a person first, or only tell. The
 * host's page decides, in the control plane's last answer. A runner without a control plane, or with one
 * from before that page, restarts as before; until the control plane first answers, it asks first.
 */
export function restartChoiceOf(
  hasControlPlane: boolean,
  answer: HeartbeatResponse | null,
  name: string,
): RestartChoice {
  if (!hasControlPlane) {
    return RESTART_CHOICE.restart;
  }
  if (answer === null) {
    return RESTART_CHOICE.ask;
  }
  const control = answer.control;
  if (control === undefined) {
    return RESTART_CHOICE.restart;
  }
  // An answer this runner does not know, from a newer control plane, asks first.
  const answered = control.whenFailing?.[name] ?? control.whenFailingByDefault;
  if (answered !== undefined) {
    return RESTART_CHOICES.includes(answered) ? answered : RESTART_CHOICE.ask;
  }
  return (control.restart[name] ?? control.restartByDefault) ? RESTART_CHOICE.restart : RESTART_CHOICE.ask;
}

/**
 * Carries out a healing decision, and all it can do is `docker restart`. It re-checks the
 * protected list, the host's page and the hourly budget itself, whoever made the decision, and watches
 * the container afterwards: a restart that did not hold comes back to a person. (Actions a person asks
 * for in the dashboard go through ContainerJobs instead.)
 */
export class Executor {
  constructor(
    private readonly docker: Pick<DockerClient, "restart" | "inspect">,
    private readonly guard: RemedyGuard,
    private readonly settings: { dryRun: boolean; protectedContainers: ReadonlySet<string> },
    // What the host's page answers for a container: restart it, ask a person first, or only tell.
    private readonly restartChoice: (name: string) => RestartChoice = () => RESTART_CHOICE.restart,
    private readonly wait: (milliseconds: number) => Promise<unknown> = unheldSleep,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Whether a failure of this container is handled at all: a container left unwatched is not. */
  watches(name: string): boolean {
    return this.restartChoice(name) !== RESTART_CHOICE.ignore;
  }

  /**
   * `failed`: the container the incident is about, which a dependency restart has to bring back. `approved`: a
   * person chose this restart on the board, so the container's tick has had its say.
   */
  async carryOut(decision: Decision, failed: string, approved = false): Promise<Outcome> {
    // Only to be told about: nothing is changed, and nothing waits for a person.
    if (!approved && this.restartChoice(failed) === RESTART_CHOICE.tell) {
      return { outcome: OUTCOMES.onlyTell(failed), verdict: VERDICT_LEFT_ALONE, executed: false };
    }
    if (!isRestart(decision)) {
      return escalated(OUTCOMES.escalated);
    }
    const target = decision.target;
    if (this.settings.protectedContainers.has(target)) {
      return escalated(OUTCOMES.protectedTarget(target));
    }
    if (isParkedContainer(target)) {
      return escalated(OUTCOMES.parkedTarget(target));
    }
    if (!approved && this.restartChoice(target) !== RESTART_CHOICE.restart) {
      return escalated(OUTCOMES.asksFirst(target));
    }
    // An update or a stop is under way: restarting now would fight it.
    if (this.guard.isHeld(target)) {
      return { outcome: OUTCOMES.actionRunning(target), verdict: VERDICT_SKIPPED, executed: false };
    }
    if (this.guard.stateBlocked()) return escalated(OUTCOMES.safetyStateUnavailable);
    if (this.settings.dryRun) {
      const allowed = this.guard.takeRestart(target);
      await this.guard.persisted();
      return allowed
        ? { outcome: OUTCOMES.dryRun(target), verdict: VERDICT_DRY_RUN, executed: false }
        : escalated(OUTCOMES.budgetUsed(target));
    }
    const resources = async () =>
      (
        await Promise.all(
          [...new Set([target, failed])].map(async (name) => containerResources(name, await this.docker.inspect(name))),
        )
      ).flat();
    let lease;
    try {
      const before = await resources();
      lease = this.guard.operations.tryAcquire(before);
      if (
        lease === null ||
        !sameResources(before, await resources()) ||
        this.guard.isHeld(target) ||
        this.guard.isHeld(failed)
      ) {
        return { outcome: OUTCOMES.actionRunning(target), verdict: VERDICT_SKIPPED, executed: false };
      }
      for (const identity of [
        target,
        failed,
        ...before.filter((key) => key.startsWith("id:")).map((key) => key.slice(3)),
      ]) {
        const recovery = await this.guard.rollbackOf(identity);
        if (recovery !== null)
          return { outcome: JOB_OUTCOMES.rollbackPending(recovery.owner), verdict: VERDICT_SKIPPED, executed: false };
      }
      if (!this.guard.takeRestart(target)) {
        return escalated(this.guard.stateBlocked() ? OUTCOMES.safetyStateUnavailable : OUTCOMES.budgetUsed(target));
      }
      await this.guard.persisted();
      try {
        await this.docker.restart(target);
      } catch (error) {
        return escalated(OUTCOMES.restartFailed(target, describeError(error)));
      }
      return await this.watched(target, failed);
    } catch (error) {
      return escalated(OUTCOMES.restartFailed(target, describeError(error)));
    } finally {
      lease?.release();
    }
  }

  /**
   * The restarted container is watched for as long as the guard takes its stops for this restart (and so
   * drops their die events), longer while its health check has not passed. A dependency that held is then
   * followed by the container that failed, which has to come back. A stop someone asked for meanwhile is
   * theirs, not a restart that failed to hold.
   */
  private async watched(target: string, failed: string): Promise<Outcome> {
    const restartedAt = this.guard.now();
    const restarted: Outcome = { outcome: OUTCOMES.restarted(target), verdict: VERDICT_FIXED, executed: true };
    const problem = await this.watching(target, (inspect) =>
      untilSettled(inspect, target, RESTART_VERIFY, RESTART_PROBLEMS, this.wait, this.clock),
    );
    if (problem === undefined) {
      return restarted;
    }
    if (problem !== null) {
      return this.guard.stoppedOnPurposeSince(target, restartedAt)
        ? restarted
        : { outcome: OUTCOMES.didNotHold(target, problem), verdict: VERDICT_ESCALATED, executed: true };
    }
    if (target === failed) {
      return restarted;
    }
    const notBack = await this.watching(failed, (inspect) =>
      untilBack(inspect, failed, BACK_VERIFY, BACK_PROBLEMS, this.wait, this.clock),
    );
    if (notBack === null) {
      return { outcome: OUTCOMES.backAfterDependency(target, failed), verdict: VERDICT_FIXED, executed: true };
    }
    // It could not look, or someone stopped or changed it meanwhile: the outcome says what was done, no more.
    if (notBack === undefined || this.guard.stoppedOnPurposeSince(failed, restartedAt)) {
      return restarted;
    }
    return { outcome: OUTCOMES.notBack(target, failed, notBack), verdict: VERDICT_ESCALATED, executed: true };
  }

  /**
   * What watching found: null when all is well, what is wrong otherwise, and undefined when Docker could not be
   * asked. Then the outcome says only what was done, and the log says why.
   */
  private watching(
    container: string,
    watch: (inspect: (name: string) => Promise<ContainerDetails | null>) => Promise<string | null>,
  ): Promise<string | null | undefined> {
    return watch((name) => this.docker.inspect(name)).catch((error: unknown) => {
      log(RUNNER_MESSAGES.couldNotWatch(container, describeError(error)));
      return undefined;
    });
  }
}
