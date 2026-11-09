import { API_ERRORS, type ApiErrorCode } from "../../shared/api.js";
import { RUNNER_ANSWER_WAIT_MILLISECONDS, RUNNER_REHAND_MILLISECONDS } from "../../shared/constants.js";
import { DomainError } from "../domain-error.js";
import type { WaitingRunners } from "./waiting-runners.js";

interface Pending<Request, Answer> {
  hostId: string;
  request: Request;
  // How often a poll took it, and when it last did.
  handOvers: number;
  handedOverAt: number;
  answer: (answer: Answer) => void;
  reject: (code: ApiErrorCode) => void;
}

/**
 * Requests a person makes of a host's runner, held in memory: the runner hears of each at once and answers,
 * and the person's request waits for that answer, or a while. Nothing in them is kept.
 */
export class RunnerRelay<Request extends { id: string }, Answer> {
  private readonly pending = new Map<string, Pending<Request, Answer>>();

  constructor(
    private readonly runners: Pick<WaitingRunners, "wake">,
    // A request this says only reads goes out once more when its runner has not answered it a while after a poll took
    // it, as that poll's answer may never have reached the runner. One that changes anything is never sent twice.
    private readonly onlyReads: (request: Request) => boolean = () => false,
  ) {}

  ask(hostId: string, request: Request): Promise<Answer> {
    return new Promise<Answer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new DomainError(API_ERRORS.runnerNoAnswer));
      }, RUNNER_ANSWER_WAIT_MILLISECONDS);
      const answer = (given: Answer) => {
        clearTimeout(timer);
        this.pending.delete(request.id);
        resolve(given);
      };
      this.pending.set(request.id, {
        hostId,
        request,
        handOvers: 0,
        handedOverAt: 0,
        answer,
        reject: (code) => {
          clearTimeout(timer);
          this.pending.delete(request.id);
          reject(new DomainError(code));
        },
      });
      this.runners.wake(hostId);
    });
  }

  reset() {
    for (const entry of [...this.pending.values()]) entry.reject(API_ERRORS.restoreMaintenance);
  }

  /** A revoked host's runner is handed none of what was asked of it, and nobody waits on that any more. */
  resetHost(hostId: string) {
    for (const entry of [...this.pending.values()].filter((each) => each.hostId === hostId)) {
      entry.reject(API_ERRORS.hostRevoked);
    }
  }

  /** The requests waiting for this host's runner; each is handed over once, a read twice if the first went unanswered. */
  take(hostId: string, accepts: (request: Request) => boolean = () => true): Request[] {
    const now = Date.now();
    const due = (entry: Pending<Request, Answer>) =>
      entry.handOvers === 0 || (this.again(entry) && now - entry.handedOverAt >= RUNNER_REHAND_MILLISECONDS);
    const waiting = [...this.pending.values()].filter(
      (entry) => entry.hostId === hostId && due(entry) && accepts(entry.request),
    );
    return waiting.map((entry) => {
      entry.handOvers += 1;
      entry.handedOverAt = now;
      if (this.again(entry)) this.wakeWhenDue(entry);
      return entry.request;
    });
  }

  private again(entry: Pending<Request, Answer>) {
    return entry.handOvers === 1 && this.onlyReads(entry.request);
  }

  // The poll waiting meanwhile is woken for it, so a lost hand-over goes out again then, not at the next poll.
  private wakeWhenDue(entry: Pending<Request, Answer>) {
    const { handedOverAt } = entry;
    setTimeout(() => {
      if (this.pending.get(entry.request.id)?.handedOverAt === handedOverAt) this.runners.wake(entry.hostId);
    }, RUNNER_REHAND_MILLISECONDS).unref();
  }

  answer(hostId: string, requestId: string, answer: Answer) {
    const entry = this.pending.get(requestId);
    if (entry === undefined || entry.hostId !== hostId) {
      throw new DomainError(API_ERRORS.runnerRequestNotFound);
    }
    entry.answer(answer);
  }
}
