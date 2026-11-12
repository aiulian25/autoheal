import {
  RUNNER_MESSAGES,
  CATCH_UP_WINDOW_MILLISECONDS,
  CONTAINER_STATE_RUNNING,
  EVENT_KILL,
  EXIT_CODE_SUCCESS,
  OUTCOMES,
  RESTARTING_ACTIONS,
  TRIGGER_BY_EVENT,
  VERDICT_SKIPPED,
  isAutohealHelper,
  isParkedContainer,
  type Trigger,
} from "../shared/constants.js";
import { containerProblem } from "../shared/container-problem.js";
import { modelDecision } from "../shared/decision.js";
import { describeError } from "../shared/errors.js";
import { log } from "../shared/log.js";
import type { DecisionOutcome } from "./decider.js";
import type { DockerClient, DockerEvent } from "./docker-client.js";
import type { Executor } from "./executor.js";
import {
  buildIncidentReport,
  composeProjectOf,
  containerNameOf,
  isBroken,
  restartPolicyOf,
  summariseState,
  triggerOf,
  type ContainerDetails,
} from "./incident-report.js";
import { neighboursOf } from "./neighbours.js";
import type { RemedyGuard } from "./remedy-guard.js";
import type { ContainerSnapshot, IncidentNotice, IncidentSubmission, Outcome } from "../shared/protocol.js";

export interface WatcherDependencies {
  docker: Pick<
    DockerClient,
    "inspect" | "containerNames" | "composeProjectNames" | "containerSummaries" | "logs" | "allEnvironmentEntries"
  >;
  guard: RemedyGuard;
  decider: {
    decide(submission: IncidentSubmission): Promise<DecisionOutcome>;
    prepareOutcome?(submission: IncidentSubmission, decided: DecisionOutcome): Promise<void>;
    recordOutcome(submission: IncidentSubmission, decided: DecisionOutcome, result: Outcome): Promise<void>;
  };
  executor: Pick<Executor, "carryOut" | "watches">;
  notify: (notice: IncidentNotice) => Promise<void>;
  settings: { protectedContainers: ReadonlySet<string> };
  settleMilliseconds: number;
  clock?: () => number;
}

// Broken now and, if it has stopped, stopped since then. A running container has no moment it turned unhealthy.
function brokeSince(snapshot: ContainerSnapshot, since: number): boolean {
  if (containerProblem(snapshot) === null) {
    return false;
  }
  const stoppedSince = snapshot.finishedAt !== null && snapshot.finishedAt >= since;
  return snapshot.state === CONTAINER_STATE_RUNNING || stoppedSince;
}

/** Turns Docker events into handled incidents: wait, look again, decide, act, tell the owner. */
export class Watcher {
  private stopping = false;
  private readonly settling = new Set<() => void>();
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly dependencies: WatcherDependencies) {}

  stop() {
    this.stopping = true;
    for (const wake of this.settling) wake();
    this.settling.clear();
  }

  async handleEvent(event: DockerEvent) {
    if (this.stopping) return;
    if (isAutohealHelper(event.Actor?.Attributes)) return;
    const action = event.Action ?? "";
    const name = event.Actor?.Attributes?.name ?? "";
    if (action === EVENT_KILL) {
      this.dependencies.guard.noteKill(name);
      // Saved beside the stream, not before the next event: the stops of a burst (a stack taken down) go in one save.
      // What depends on it waits for it all the same, as a failure is handled only once the state is saved. A save
      // that can no longer happen is the guard's hold (logged once, sent with every heartbeat, every claim refused
      // meanwhile), no reason to drop Docker's event stream.
      void this.dependencies.guard.persisted().catch(() => undefined);
      return;
    }
    const trigger = TRIGGER_BY_EVENT.get(action);
    if (trigger !== undefined) {
      this.track(name, trigger);
    }
  }

  /**
   * The event stream has connected: the containers that broke while nobody listened are handled as if their events
   * had come. Stopped ones count from when the stream was lost (null: never connected before), at most an hour
   * back; the old container an update keeps aside is a person's. Returns how many the guard let it take on.
   */
  catchUp(snapshots: readonly ContainerSnapshot[], now: number, streamLostAt: number | null): number {
    const since = Math.max(streamLostAt ?? -Infinity, now - CATCH_UP_WINDOW_MILLISECONDS);
    const missed = snapshots.filter((snapshot) => brokeSince(snapshot, since) && !isParkedContainer(snapshot.name));
    const takenOn = missed.map((snapshot) => this.track(snapshot.name, triggerOf(snapshot)));
    return takenOn.filter((taken) => taken).length;
  }

  /** Resolves when every incident seen so far has been handled; for tests and shutdown. */
  async settled() {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  // Waits for Docker's restart policy, then handles what is still broken; false when the guard leaves it alone.
  private track(name: string, trigger: Trigger): boolean {
    if (this.stopping) return false;
    const { guard, settleMilliseconds } = this.dependencies;
    if (!guard.claim(name)) {
      return false;
    }
    log(RUNNER_MESSAGES.lookingAgain(name, trigger));
    const detectedAt = (this.dependencies.clock ?? Date.now)();
    // unref: a docker stop of the runner itself must not wait out the settle time.
    const handled = new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.settling.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, settleMilliseconds).unref();
      this.settling.add(wake);
    })
      .then(() => guard.persisted())
      .then(() => this.handleFailure(name, trigger, detectedAt))
      .catch((error: unknown) => log(RUNNER_MESSAGES.couldNotHandle(name, describeError(error))))
      .finally(() => this.pending.delete(handled));
    this.pending.add(handled);
    return true;
  }

  private async handleFailure(name: string, trigger: Trigger, detectedAt: number) {
    if (this.stopping) return;
    const { docker, decider, executor, guard, settings } = this.dependencies;
    // A person's action started while this waited to settle: it is not a failure to heal.
    if (guard.isHeld(name)) {
      log(RUNNER_MESSAGES.standingAside(name));
      return;
    }
    // Its host's page leaves it unwatched: no incident, no notice.
    if (!executor.watches(name)) {
      log(RUNNER_MESSAGES.notWatched(name));
      return;
    }
    const container = await docker.inspect(name);
    if (container === null) {
      return;
    }
    const restartPolicy = restartPolicyOf(container);
    if (!isBroken(container.State, restartPolicy)) {
      const exitedCleanly = !container.State.Running && container.State.ExitCode === EXIT_CODE_SUCCESS;
      log(exitedCleanly ? RUNNER_MESSAGES.exitedByDesign(name) : RUNNER_MESSAGES.recovered(name));
      return;
    }
    const knownContainers = await docker.containerNames();
    const project = composeProjectOf(container);
    const projectContainers = project === null ? new Set<string>() : await docker.composeProjectNames(project);
    const logs = await docker.logs(name, container.Config.Tty ?? false);
    // Its neighbours are evidence, not a condition: without them the incident goes on as before.
    const neighbours = await neighboursOf(docker, container).catch(() => []);
    const otherEnvironment = await docker.allEnvironmentEntries();
    const report = buildIncidentReport(
      container,
      trigger,
      logs,
      knownContainers,
      settings.protectedContainers,
      otherEnvironment,
      projectContainers,
      neighbours,
    );
    const submission = { report, detectedAt };
    const decided = await decider.decide(submission);
    // The decision may come from the control plane: check it here again, against what this host reported.
    if (this.stopping) return;
    const decision = modelDecision({ ...decided.decision }, report);
    const finalDecision = { ...decided, decision };
    await decider.prepareOutcome?.(submission, finalDecision);
    // A model can take a while: a restart is carried out only while the container it was decided about still fails.
    const stale = RESTARTING_ACTIONS.has(decision.action) && !(await this.stillFailing(name, container));
    const result: Outcome = stale
      ? { outcome: OUTCOMES.decidedTooLate(name), verdict: VERDICT_SKIPPED, executed: false }
      : await executor.carryOut(decision, report.containerName);
    await decider.recordOutcome(submission, finalDecision, result);
    await this.tellOwner(
      containerNameOf(container),
      summariseState(container),
      decision.diagnosis,
      result,
      finalDecision,
    );
  }

  // The same container, not one made since under its name, and still broken.
  private async stillFailing(name: string, seen: ContainerDetails): Promise<boolean> {
    const now = await this.dependencies.docker.inspect(name);
    return now !== null && now.Id === seen.Id && isBroken(now.State, restartPolicyOf(now));
  }

  private tellOwner(container: string, summary: string, diagnosis: string, result: Outcome, decided: DecisionOutcome) {
    return this.dependencies.notify({
      ...(decided.resultId === undefined ? {} : { notificationId: decided.resultId }),
      containerName: container,
      verdict: result.verdict,
      outcome: result.outcome,
      diagnosis,
      stateSummary: summary,
      incidentId: decided.incidentId,
    });
  }
}
