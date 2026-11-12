import { API_ERRORS } from "../../shared/api.js";
import { DomainError } from "../domain-error.js";
import { PREEMPTED, PRIORITY_LIVE, PRIORITY_REPLAY } from "../../shared/constants.js";

export type JobPriority = typeof PRIORITY_LIVE | typeof PRIORITY_REPLAY;

interface Job {
  priority: JobPriority;
  // Whose work it is: the host it is for. Null for the control plane's own.
  owner: string | null;
  run: (signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export interface QueuedFor {
  owner?: string | null;
  // Aborts when whoever asked no longer waits: the work then leaves the queue at once, never run.
  signal?: AbortSignal;
}

/**
 * One model call at a time on one Ollama server: the Mini's iGPU is slow. Live incidents always
 * go first; a replay that is running when one arrives is stopped and re-run afterwards. Live work is taken in turn,
 * but never from the host just served while another host's waits, so one busy host cannot hold back the others.
 */
export class DecisionQueue {
  private readonly waiting: Record<JobPriority, Job[]> = { [PRIORITY_LIVE]: [], [PRIORITY_REPLAY]: [] };
  private paused = false;
  private running: { job: Job; controller: AbortController } | null = null;
  private lastOwner: string | null = null;

  enqueue<Result>(
    priority: JobPriority,
    run: (signal: AbortSignal) => Promise<Result>,
    { owner = null, signal }: QueuedFor = {},
  ): Promise<Result> {
    if (this.paused) return Promise.reject(new DomainError(API_ERRORS.restoreMaintenance));
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<Result>((resolve, reject) => {
      const job: Job = { priority, owner, run, resolve: resolve as (value: unknown) => void, reject };
      const waiting = this.waiting[priority];
      waiting.push(job);
      // Still waiting: it leaves the queue. Already running or done: the signal is its run's to hear, as before. Never
      // through a method: it is heard whenever, even after the database closed, and must not throw.
      signal?.addEventListener("abort", () => withdraw(waiting, job, signal.reason), { once: true });
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
    const job = nextLive(this.waiting[PRIORITY_LIVE], this.lastOwner) ?? this.waiting[PRIORITY_REPLAY].shift();
    if (job === undefined) {
      return;
    }
    const controller = new AbortController();
    this.running = { job, controller };
    this.lastOwner = job.owner;
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

// The first live work waiting, unless it is the host just served's while another host's waits.
function nextLive(live: Job[], lastOwner: string | null): Job | undefined {
  const another = live.findIndex(({ owner }) => owner !== lastOwner);
  return live.splice(another < 0 ? 0 : another, 1)[0];
}

function withdraw(waiting: Job[], job: Job, reason: unknown) {
  const at = waiting.indexOf(job);
  if (at < 0) return;
  waiting.splice(at, 1);
  job.reject(reason);
}
