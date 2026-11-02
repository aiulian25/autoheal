import { API_ERRORS } from "../../shared/api.js";
import { DomainError } from "../domain-error.js";
import { PREEMPTED, PRIORITY_LIVE, PRIORITY_REPLAY } from "../../shared/constants.js";

export type JobPriority = typeof PRIORITY_LIVE | typeof PRIORITY_REPLAY;

interface Job {
  priority: JobPriority;
  run: (signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/**
 * One model call at a time on one Ollama server: the Mini's iGPU is slow. Live incidents always
 * go first; a replay that is running when one arrives is stopped and re-run afterwards.
 */
export class DecisionQueue {
  private readonly waiting: Record<JobPriority, Job[]> = { [PRIORITY_LIVE]: [], [PRIORITY_REPLAY]: [] };
  private paused = false;
  private running: { job: Job; controller: AbortController } | null = null;

  enqueue<Result>(priority: JobPriority, run: (signal: AbortSignal) => Promise<Result>): Promise<Result> {
    if (this.paused) return Promise.reject(new DomainError(API_ERRORS.restoreMaintenance));
    return new Promise<Result>((resolve, reject) => {
      this.waiting[priority].push({ priority, run, resolve: resolve as (value: unknown) => void, reject });
      if (priority === PRIORITY_LIVE && this.running?.job.priority === PRIORITY_REPLAY) {
        this.running.controller.abort(PREEMPTED);
      }
      this.next();
    });
  }

  cancelAll() {
    this.paused = true;
    const reason = new DomainError(API_ERRORS.restoreMaintenance);
    for (const priority of [PRIORITY_LIVE, PRIORITY_REPLAY] as const) {
      for (const job of this.waiting[priority].splice(0)) job.reject(reason);
    }
    const running = this.running;
    this.running = null;
    running?.job.reject(reason);
    running?.controller.abort(reason);
  }

  resume() {
    this.paused = false;
    this.next();
  }

  get pending(): number {
    return this.waiting[PRIORITY_LIVE].length + this.waiting[PRIORITY_REPLAY].length;
  }

  private next() {
    if (this.paused || this.running !== null) {
      return;
    }
    const job = this.waiting[PRIORITY_LIVE].shift() ?? this.waiting[PRIORITY_REPLAY].shift();
    if (job === undefined) {
      return;
    }
    const controller = new AbortController();
    this.running = { job, controller };
    job
      .run(controller.signal)
      .then(job.resolve, (error: unknown) => {
        const preempted = controller.signal.aborted && controller.signal.reason === PREEMPTED;
        if (preempted) {
          this.waiting[PRIORITY_REPLAY].unshift(job);
          return;
        }
        job.reject(error);
      })
      .finally(() => {
        // A cancelled old-generation callback must not clear or restart the new generation's queue.
        if (this.running?.job !== job) return;
        this.running = null;
        this.next();
      });
  }
}
