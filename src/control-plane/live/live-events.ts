import type { ContainerUsageView, HostMetricsView } from "../../shared/api.js";
import { LIVE_EVENT } from "../../shared/constants.js";
import type { UpdateProgress } from "../../shared/protocol.js";

/**
 * What changed, for the dashboards open now: a host's containers, a job on its way, an update's progress, or the
 * board's tasks and incidents.
 */
export type LiveEvent =
  // A host reported; changed when the report moved anything tasks are opened from.
  | { kind: typeof LIVE_EVENT.inventory; hostId: string; changed: boolean }
  // A job moved on; output when all that changed is what a running one wrote, nothing of where it stands.
  | { kind: typeof LIVE_EVENT.job; hostId: string; jobId: string; output?: true }
  | { kind: typeof LIVE_EVENT.progress; hostId: string; jobId: string; progress: UpdateProgress }
  | { kind: typeof LIVE_EVENT.board }
  // A host's latest readings, as its pages show them; its containers' usage by name, or null when too many to carry.
  | {
      kind: typeof LIVE_EVENT.metrics;
      hostId: string;
      host: HostMetricsView | null;
      containers: Record<string, ContainerUsageView> | null;
    };

/** In memory only: a dashboard that connects later reads the current state, then hears what changes after. */
export class LiveEvents {
  private readonly listeners = new Set<(event: LiveEvent) => void>();

  publish(event: LiveEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /** Hears every event from now on, until the returned function is called. */
  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
