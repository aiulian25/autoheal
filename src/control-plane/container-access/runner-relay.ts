import { API_ERRORS } from "../../shared/api.js";
import { RUNNER_ANSWER_WAIT_MILLISECONDS } from "../../shared/constants.js";
import { DomainError } from "../domain-error.js";
import type { WaitingRunners } from "./waiting-runners.js";

interface Pending<Request, Answer> {
  hostId: string;
  request: Request;
  handedOver: boolean;
  answer: (answer: Answer) => void;
  reject: () => void;
}

/**
 * Requests a person makes of a host's runner, held in memory: the runner hears of each at once and answers,
 * and the person's request waits for that answer, or a while. Nothing in them is kept.
 */
export class RunnerRelay<Request extends { id: string }, Answer> {
  private readonly pending = new Map<string, Pending<Request, Answer>>();

  constructor(private readonly runners: Pick<WaitingRunners, "wake">) {}

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
        handedOver: false,
        answer,
        reject: () => {
          clearTimeout(timer);
          this.pending.delete(request.id);
          reject(new DomainError(API_ERRORS.restoreMaintenance));
        },
      });
      this.runners.wake(hostId);
    });
  }

  reset() {
    for (const entry of [...this.pending.values()]) entry.reject();
  }

  /** The requests waiting for this host's runner; each is handed over once. */
  take(hostId: string, accepts: (request: Request) => boolean = () => true): Request[] {
    const waiting = [...this.pending.values()].filter(
      (entry) => entry.hostId === hostId && !entry.handedOver && accepts(entry.request),
    );
    return waiting.map((entry) => {
      entry.handedOver = true;
      return entry.request;
    });
  }

  answer(hostId: string, requestId: string, answer: Answer) {
    const entry = this.pending.get(requestId);
    if (entry === undefined || entry.hostId !== hostId) {
      throw new DomainError(API_ERRORS.runnerRequestNotFound);
    }
    entry.answer(answer);
  }
}
