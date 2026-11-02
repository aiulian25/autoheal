import type { ContainerDetails } from "./incident-report.js";

export interface OperationLease {
  release(): void;
}

// null means the whole host, including jobs not yet discovered when the request was made.
type Resources = readonly string[] | null;
interface Waiting {
  resources: Resources;
  resolve: (lease: OperationLease) => void;
}

const normalized = (resources: readonly string[]) => [...new Set(resources)].sort();
const conflicts = (a: Resources, b: Resources) => a === null || b === null || a.some((key) => b.includes(key));

export const sameResources = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));

/** IDs identify the instance; names reserve its replacement too, and make name/ID callers conflict. */
export function containerResources(name: string, details: ContainerDetails | null): string[] {
  return normalized([
    `name:${name.replace(/^\//, "")}`,
    ...(details === null ? [] : [`name:${details.Name.replace(/^\//, "")}`]),
    ...(details?.Id === undefined ? [] : [`id:${details.Id}`]),
  ]);
}

/** One per runner. Resource sets are acquired atomically, never upgraded while partly held. */
export class OperationCoordinator {
  private readonly active = new Map<symbol, Resources>();
  private readonly waiting: Waiting[] = [];

  acquire(resources: Resources, onWait?: () => void): Promise<OperationLease> {
    const keys = resources === null ? null : normalized(resources);
    if (this.available(keys) && !this.waiting.some((item) => conflicts(keys, item.resources))) {
      return Promise.resolve(this.grant(keys));
    }
    // Reporting is best effort; do it before enqueueing so a thrown callback cannot leave an orphan request.
    onWait?.();
    return new Promise((resolve) => {
      this.waiting.push({ resources: keys, resolve });
      this.drain();
    });
  }

  /** Healing skips busy work instead of queueing a diagnosis that may be stale when it gets its turn. */
  tryAcquire(resources: readonly string[]): OperationLease | null {
    const keys = normalized(resources);
    return this.available(keys) && !this.waiting.some((item) => conflicts(keys, item.resources))
      ? this.grant(keys)
      : null;
  }

  private available(resources: Resources) {
    return ![...this.active.values()].some((held) => conflicts(resources, held));
  }

  private grant(resources: Resources): OperationLease {
    const owner = Symbol();
    this.active.set(owner, resources);
    return {
      release: () => {
        if (!this.active.delete(owner)) {
          return;
        }
        this.drain();
      },
    };
  }

  private drain() {
    for (let index = 0; index < this.waiting.length;) {
      const request = this.waiting[index]!;
      const earlier = this.waiting.slice(0, index);
      if (this.available(request.resources) && !earlier.some((item) => conflicts(request.resources, item.resources))) {
        this.waiting.splice(index, 1);
        request.resolve(this.grant(request.resources));
      } else {
        index += 1;
      }
    }
  }

  async host<Result>(work: () => Promise<Result>, onWait?: () => void): Promise<Result> {
    const lease = await this.acquire(null, onWait);
    try {
      return await work();
    } finally {
      lease.release();
    }
  }

  /** Re-discover after waiting; a changed graph releases its whole lease and starts over without lock upgrades. */
  async containers<Snapshot extends { resources: readonly string[] }, Result>(
    discover: () => Promise<Snapshot>,
    work: (snapshot: Snapshot) => Promise<Result>,
    onWait?: () => void,
  ): Promise<Result> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = await discover();
      const lease = await this.acquire(before.resources, onWait);
      try {
        const current = await discover();
        if (sameResources(before.resources, current.resources)) {
          return await work(current);
        }
      } finally {
        lease.release();
      }
    }
    throw new Error("The affected containers kept changing; no operation was started. Try again after they settle.");
  }
}
