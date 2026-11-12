import { ResultJournal, type ResultReport } from "./result-journal.js";
import {
  JOB_OUTCOMES,
  RUNNER_MESSAGES,
  IMAGE_REMOVING_ACTIONS,
  OUTCOMES,
  RUNNER_JOB_CONCURRENCY,
  VERDICT_SKIPPED,
} from "../shared/constants.js";
import { validateAnswer } from "../shared/decision.js";
import { describeError } from "../shared/errors.js";
import { log } from "../shared/log.js";
import {
  isHostJob,
  type HostJob,
  type Job,
  type DockerJob,
  type IncidentNotice,
  type JobResult,
  type Outcome,
  type WorkItem,
} from "../shared/protocol.js";
import type { ContainerJobs } from "./container-jobs.js";
import { refusedForGood, type ControlPlaneClient } from "./control-plane-client.js";
import type { DockerClient } from "./docker-client.js";
import type { Executor } from "./executor.js";
import type { HostPackageJobs } from "./host-package-jobs.js";
import { isBroken, restartPolicyOf, summariseState } from "./incident-report.js";

// What a job without a container acts on, in the result journal: the host itself (its packages, its images).
const HOST_TARGET = "host";

export interface ApprovedWorkDependencies {
  maintenanceHeld?: (name: string) => boolean;
  controlPlane: Pick<ControlPlaneClient, "takeWork" | "reportWorkResult" | "reportJobResult">;
  docker: Pick<DockerClient, "inspect" | "containerNames">;
  executor: Pick<Executor, "carryOut">;
  jobs: Pick<ContainerJobs, "run">;
  hostJobs: Pick<HostPackageJobs, "run" | "followable">;
  notify: (notice: IncidentNotice) => Promise<void>;
  settings: { protectedContainers: ReadonlySet<string> };
}

/**
 * Runs what people decided in the dashboard: approved incident actions, and container actions.
 * Approval is not a bypass: the container is looked at again, and the menu, protected list,
 * restart budget and dry-run still apply here.
 */
export class ApprovedWork {
  private busy = false;
  private stopping = false;
  private poll: Promise<void> | null = null;
  // Results the control plane did not accept yet: reported again before new work is taken, so an
  // action that ran is never mistaken for one that did not and approved a second time.
  private readonly results: ResultJournal;
  // Approved actions still going on: a restart is watched for a minute afterwards, and the
  // dashboard's other actions do not wait for that.
  private readonly running = new Set<Promise<void>>();
  // The one sending of reports under way: jobs that end together each add theirs, and it takes them.
  private reporting: Promise<void> | null = null;
  // Each container's last job, the next one asked for it chained after it: a stop is done before a removal.
  private readonly chains = new Map<string, Promise<void>>();
  // Container jobs running now, whether an image removal runs (alone), and the jobs waiting for their turn.
  private jobsRunning = 0;
  private removingImages = false;
  private readonly waitingForTurn: (() => void)[] = [];

  constructor(
    private readonly dependencies: ApprovedWorkDependencies,
    results = new ResultJournal(),
  ) {
    this.results = results;
  }

  /** One poll; skipped while the previous one is still sending or taking. Container jobs go on in the background. */
  runOnce(): Promise<void> {
    if (this.stopping || this.busy) return Promise.resolve();
    this.poll = this.pollOnce().finally(() => {
      this.poll = null;
    });
    return this.poll;
  }

  private async pollOnce() {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      await this.reportPending();
      const { items, jobs } = await this.dependencies.controlPlane.takeWork();
      for (const item of items) {
        this.start(item);
      }
      for (const job of jobs.filter(isHostJob)) {
        this.startHostJob(job);
      }
      for (const job of jobs.filter((job): job is DockerJob => !isHostJob(job))) {
        this.startJob(job);
      }
    } finally {
      this.busy = false;
    }
  }

  get pendingResults(): number {
    return this.results.count(["work", "job"], true);
  }

  stop() {
    this.stopping = true;
  }

  /** Flush results without taking more work. Host systemd followers retain their own durable job IDs. */
  async flush() {
    await this.reportPending();
    if (this.results.count(["work", "job"], true) > 0)
      throw new Error(`${this.results.count(["work", "job"], true)} approved results remain unacknowledged.`);
  }

  /** Includes an admitted poll whose delivered work has not been dispatched yet. */
  async settled() {
    // A failed poll must not cut short jobs admitted by an earlier successful poll.
    await this.poll?.catch(() => undefined);
    while (this.running.size > 0) {
      await Promise.all([...this.running]);
    }
  }

  private start(item: WorkItem) {
    const action = this.run(item)
      .catch((error: unknown) => log(RUNNER_MESSAGES.couldNotHandle(item.containerName, describeError(error))))
      .finally(() => this.running.delete(action));
    this.running.add(action);
  }

  private async run(item: WorkItem) {
    if (!(await this.results.reserve("work", item.id, item.target))) return;
    const { docker, executor, notify, settings } = this.dependencies;
    const container = await docker.inspect(item.containerName);
    const approvedBy = OUTCOMES.approvedBy(item.approvedBy);
    const stillBroken = container !== null && isBroken(container.State, restartPolicyOf(container));
    const result: Outcome = stillBroken
      ? await executor.carryOut(
          validateAnswer(
            { action: item.action, target: item.target, diagnosis: approvedBy },
            item.containerName,
            await docker.containerNames(),
            settings.protectedContainers,
          ),
          item.containerName,
          true,
        )
      : { outcome: OUTCOMES.recovered(item.containerName), verdict: VERDICT_SKIPPED, executed: false };
    await this.results.complete({ kind: "work", id: item.id, result });
    await notify({
      notificationId: item.id,
      containerName: item.containerName,
      verdict: result.verdict,
      outcome: result.outcome,
      diagnosis: approvedBy,
      stateSummary: container === null ? "" : summariseState(container),
      incidentId: item.incidentId,
    });
  }

  /**
   * After the runner restarts: the package runs that were going on, reported once they end. A host job left behind
   * with no run to follow is reported failed, saying why: kept open, it would hold up every host job after it.
   */
  async resumeHostRuns() {
    for (const run of await this.dependencies.hostJobs.followable()) {
      await this.results.follow("job", run.jobId, HOST_TARGET);
      this.reportWhenDone(run.jobId, run.result, true);
    }
    for (const jobId of this.results.unfinished(HOST_TARGET)) {
      await this.results.follow("job", jobId, HOST_TARGET);
      const interrupted = { succeeded: false, outcome: JOB_OUTCOMES.interruptedByRestart, output: null };
      this.reportWhenDone(jobId, Promise.resolve(interrupted), true);
    }
  }

  // In the background, so a restart asked during a long update is not held up by it: several containers at once,
  // as a bulk action asks, each container's jobs in the order they were asked.
  private startJob(job: DockerJob) {
    const key = job.containerName;
    const chained = (this.chains.get(key) ?? Promise.resolve())
      .then(() => this.inTurn(IMAGE_REMOVING_ACTIONS.has(job.action), () => this.runJob(job)))
      .catch((error: unknown) => log(RUNNER_MESSAGES.couldNotHandle(key, describeError(error))));
    this.chains.set(key, chained);
    this.running.add(chained);
    void chained.finally(() => {
      this.running.delete(chained);
      if (this.chains.get(key) === chained) {
        this.chains.delete(key);
      }
    });
  }

  // ponytail: an image removal waits until no container job runs, so a steady stream of them could hold it back;
  // a queue that lets no newer job past a waiting removal if that ever shows.
  private async inTurn(alone: boolean, work: () => Promise<void>) {
    while (this.removingImages || (alone ? this.jobsRunning > 0 : this.jobsRunning >= RUNNER_JOB_CONCURRENCY)) {
      await new Promise<void>((resolve) => this.waitingForTurn.push(resolve));
    }
    if (alone) {
      this.removingImages = true;
    } else {
      this.jobsRunning += 1;
    }
    try {
      await work();
    } finally {
      if (alone) {
        this.removingImages = false;
      } else {
        this.jobsRunning -= 1;
      }
      for (const wake of this.waitingForTurn.splice(0)) {
        wake();
      }
    }
  }

  private async runJob(job: DockerJob) {
    if (!(await this.admitted(job))) return;
    const result =
      job.automatic && this.dependencies.maintenanceHeld?.(job.containerName)
        ? {
            succeeded: false,
            outcome: "Automatic work paused: maintenance policy is active or unavailable.",
            output: null,
          }
        : await this.dependencies.jobs.run(job);
    await this.results.complete({ kind: "job", id: job.id, result });
    log(RUNNER_MESSAGES.jobDone(job.action, job.containerName, job.requestedBy, result.outcome));
    await this.reportPending();
  }

  // An upgrade takes minutes: it runs in the background, and other work does not wait for it.
  private startHostJob(job: HostJob) {
    const launching = this.admitted(job)
      .then((admitted) => {
        if (admitted)
          this.reportWhenDone(
            job.id,
            job.automatic && this.dependencies.maintenanceHeld?.(job.containerName)
              ? Promise.resolve({
                  succeeded: false,
                  outcome: "Automatic work paused: maintenance policy is active or unavailable.",
                  output: null,
                })
              : this.dependencies.hostJobs.run(job),
          );
      })
      .catch((error: unknown) => log(describeError(error)))
      .finally(() => this.running.delete(launching));
    this.running.add(launching);
  }

  /**
   * Its reservation in the result journal: false for one already there. One the journal refuses (an interrupted action
   * on the same target) never starts, and is answered at once with why, rather than left for the control plane to
   * give up on.
   */
  private async admitted(job: Job): Promise<boolean> {
    try {
      return await this.results.reserve("job", job.id, job.containerName || HOST_TARGET);
    } catch (error) {
      const refused = { succeeded: false, outcome: describeError(error), output: null };
      await this.dependencies.controlPlane
        .reportJobResult(job.id, refused)
        .catch((reporting: unknown) => log(describeError(reporting)));
      return false;
    }
  }

  // Kept for the next poll to send, so two reports never go out at once.
  private reportWhenDone(jobId: string, running: Promise<JobResult>, followingHostRun = false) {
    void running
      .catch((error: unknown) => ({ succeeded: false, outcome: describeError(error), output: null }))
      .then(async (result) => {
        const saving = this.results.complete({ kind: "job", id: jobId, result }, followingHostRun);
        this.running.add(saving);
        try {
          await saving;
          log(RUNNER_MESSAGES.hostJobDone(jobId, result.outcome));
        } finally {
          this.running.delete(saving);
        }
      })
      .catch((error: unknown) => log(describeError(error)));
  }

  private send(report: ResultReport) {
    const { controlPlane } = this.dependencies;
    if (report.kind === "job") return controlPlane.reportJobResult(report.id, report.result);
    if (report.kind === "work") return controlPlane.reportWorkResult(report.id, report.result);
    throw new Error("Unexpected report kind");
  }

  private reportPending(): Promise<void> {
    this.reporting ??= this.sendPending().finally(() => {
      this.reporting = null;
    });
    return this.reporting;
  }

  private async sendPending() {
    await this.results.flush(["work", "job"], (report) => this.send(report), refusedForGood);
  }
}
