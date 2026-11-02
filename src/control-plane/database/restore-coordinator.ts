import { AsyncLocalStorage } from "node:async_hooks";
import { API_ERRORS } from "../../shared/api.js";
import { RESTORE_DRAIN_MILLISECONDS } from "../../shared/constants.js";
import { DomainError } from "../domain-error.js";

interface Context {
  generation: number;
  owner?: symbol;
}
/** One per shared database. Drains admitted work; late callbacks cannot enter a replaced generation. */
export class RestoreCoordinator {
  private readonly context = new AsyncLocalStorage<Context>();
  private readonly active = new Set<Promise<unknown>>();
  private readonly paused = new Set<() => void>();
  private readonly resumed = new Set<() => void>();
  private owner: symbol | null = null;
  private generation = 0;
  private reconciled = false;
  private stopping = false;
  private closed = false;
  private restoring: Promise<unknown> | null = null;
  get shuttingDown() {
    return this.stopping;
  }
  get busy() {
    return this.stopping || this.owner !== null;
  }

  assertCurrent() {
    if (this.closed) throw new DomainError(API_ERRORS.restoreMaintenance);
    const context = this.context.getStore();
    if (context?.owner === this.owner && this.owner !== null) return;
    if ((context !== undefined && context.generation !== this.generation) || (this.busy && context === undefined)) {
      throw new DomainError(API_ERRORS.restoreMaintenance);
    }
  }

  run<Result>(work: () => Result): Result {
    this.assertCurrent();
    const invoke = () => {
      const result = work();
      if (result instanceof Promise && this.context.getStore()?.owner !== this.owner) this.track(result);
      return result;
    };
    return this.context.getStore() === undefined ? this.context.run({ generation: this.generation }, invoke) : invoke();
  }

  /** Capture complete async service methods, including their private/fire-and-forget child methods. */
  wrap<Service extends object>(service: Service, excluded: readonly string[] = []): Service {
    const methods = new Map<PropertyKey, { original: unknown; wrapped: unknown }>();
    const coordinator = this;
    return new Proxy(service, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== "function" || key === "constructor") return value;
        const cached = methods.get(key);
        if (cached?.original === value) return cached.wrapped;
        const wrapped = excluded.includes(String(key))
          ? value.bind(receiver)
          : (...args: unknown[]) => coordinator.run(() => Reflect.apply(value, receiver, args));
        methods.set(key, { original: value, wrapped });
        return wrapped;
      },
    });
  }

  onPause(work: () => void) {
    this.paused.add(work);
    return () => {
      this.paused.delete(work);
    };
  }
  onResume(work: () => void) {
    this.resumed.add(work);
  }
  reconcile() {
    for (const work of this.resumed) work();
    this.reconciled = true;
  }

  /** HTTP handlers are tracked until headers/payload are ready, not for an SSE stream's lifetime. */
  request(next: (finish: () => void) => void, tracked = true): () => void {
    if (this.busy) throw new DomainError(API_ERRORS.restoreMaintenance);
    let finish = () => {};
    if (tracked)
      this.track(
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      );
    this.context.run({ generation: this.generation }, () => next(finish));
    return finish;
  }

  replaced() {
    this.generation += 1;
    const context = this.context.getStore();
    if (context?.owner === this.owner && this.owner !== null) context.generation = this.generation;
  }

  async exclusive<Result>(
    work: () => Promise<Result>,
    timeoutMilliseconds = RESTORE_DRAIN_MILLISECONDS,
  ): Promise<Result> {
    if (this.busy) throw new DomainError(API_ERRORS.restoreBusy);
    const owner = Symbol();
    this.owner = owner;
    this.reconciled = false;
    const operation = this.context.run({ generation: this.generation, owner }, async () => {
      try {
        for (const pause of this.paused) pause();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new DomainError(API_ERRORS.restoreDrainBusy)), timeoutMilliseconds);
        });
        try {
          const drain = async () => {
            while (this.active.size > 0) await Promise.allSettled([...this.active]);
          };
          await Promise.race([drain(), timeout]);
        } finally {
          clearTimeout(timer);
        }
        return await work();
      } finally {
        try {
          if (!this.reconciled) this.reconcile();
        } finally {
          this.owner = null;
        }
      }
    });
    this.restoring = operation;
    void operation.then(
      () => {
        if (this.restoring === operation) this.restoring = null;
      },
      () => {
        if (this.restoring === operation) this.restoring = null;
      },
    );
    return operation;
  }

  /** Permanently stop admission, quiesce streams/connectors and drain before SQLite is closed. */
  async shutdown() {
    return this.context.run({ generation: this.generation }, async () => {
      if (!this.stopping) {
        this.stopping = true;
        for (const pause of this.paused) pause();
      }
      await this.restoring;
      while (this.active.size > 0) await Promise.allSettled([...this.active]);
      this.closed = true;
      this.generation += 1;
    });
  }

  private track(promise: Promise<unknown>) {
    this.active.add(promise);
    void promise.then(
      () => this.active.delete(promise),
      () => this.active.delete(promise),
    );
  }
}
