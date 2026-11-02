import {
  HANDLE_COOLDOWN_SECONDS,
  MAX_RESTARTS_PER_WINDOW,
  MILLISECONDS_PER_SECOND,
  RESTART_WINDOW_SECONDS,
} from "../shared/constants.js";
import type { RecoveryHold, RestartWait } from "../shared/protocol.js";
import {
  recoveryGuardTransition,
  recentRestartTimes,
  type RecoveryGuardState,
} from "../shared/recovery-policy-simulator.js";
import { type GuardState, monotonicSeconds } from "./guard-state.js";
import type { OperationJournal } from "./operation-journal.js";
import { OperationCoordinator } from "./operation-coordinator.js";

export type Clock = () => number;

/** Remembers what happened recently so a crash loop can't turn into a restart storm. */
export class RemedyGuard {
  readonly operations = new OperationCoordinator();
  // Containers a person's action is working on right now: healing waits until it is done.
  private readonly held = new Map<string, number>();
  // Package runs on the host: anything may stop and start (Docker itself, when it is upgraded). A count,
  // as a runner that restarted follows several runs at once, finished ones included.
  private hostHolds = 0;
  externalRecoveryBlocked: (name: string, id?: string) => boolean = () => false;
  maintenanceHeld: (name: string) => boolean = () => false;
  private readonly lastKill = new Map<string, number>();
  private readonly lastHandled = new Map<string, number>();
  private readonly restartTimes = new Map<string, number[]>();

  constructor(
    private readonly protectedContainers: ReadonlySet<string>,
    private readonly clock: Clock = monotonicSeconds,
    private readonly journal: Pick<OperationJournal, "find" | "pending"> | null = null,
    private readonly state: GuardState | null = null,
  ) {
    if (state !== null) {
      this.clock = state.clock;
      this.lastKill = state.lastKill;
      this.lastHandled = state.lastHandled;
      this.restartTimes = state.restartTimes;
    }
  }

  persisted() {
    return this.state?.flush() ?? Promise.resolve();
  }
  /** Why this runner restarts nothing on its own just now, for its heartbeat; null while it may. */
  recoveryHold(): RecoveryHold | null {
    return this.state?.recoveryHold() ?? null;
  }
  stateBlocked() {
    return this.state?.blocked() ?? false;
  }

  rollbackOf(name: string, id?: string) {
    return this.journal?.find(name, id) ?? Promise.resolve(null);
  }

  recoveries() {
    return this.journal?.pending() ?? Promise.resolve([]);
  }

  noteKill(name: string) {
    if (name.length === 0 || this.state?.unavailable()) return;
    this.lastKill.set(name, this.clock());
    this.state?.changed();
  }

  hold(name: string) {
    this.held.set(name, (this.held.get(name) ?? 0) + 1);
  }

  /** What a person's action is changing right now, which a reboot must not cut short. */
  heldContainers(): string[] {
    return [...this.held.keys()];
  }

  isHeld(name: string): boolean {
    return this.hostHolds > 0 || this.held.has(name) || this.maintenanceHeld(name);
  }

  holdHost() {
    this.hostHolds += 1;
  }

  /** A package run is over: once none is left, a container that stops is a failure again. */
  releaseHost() {
    this.hostHolds = Math.max(0, this.hostHolds - 1);
  }

  /** The action is over; whatever it stopped on purpose still counts as deliberate for a while. */
  release(name: string) {
    const count = this.held.get(name) ?? 0;
    if (count > 1) {
      this.held.set(name, count - 1);
    } else {
      this.held.delete(name);
    }
    this.noteKill(name);
  }

  /** True once per cooldown for a container that is worth looking at. */
  claim(name: string): boolean {
    const decision = recoveryGuardTransition("claim", this.stateOf(name), {
      name,
      now: this.clock(),
      safetyBlocked: this.stateBlocked() || this.externalRecoveryBlocked(name),
      protected: this.protectedContainers.has(name),
      held: this.hostHolds > 0 || this.held.has(name),
      maintenance: this.maintenanceHeld(name),
    });
    if (!decision.allowed) return false;
    this.lastHandled.set(name, decision.state.lastHandled!);
    this.state?.changed();
    return true;
  }

  /** Reserve one restart credit; callers must await persisted() before asking Docker to restart. */
  takeRestart(name: string): boolean {
    const decision = recoveryGuardTransition("restart", this.stateOf(name), {
      name,
      now: this.clock(),
      safetyBlocked: this.stateBlocked() || this.externalRecoveryBlocked(name),
      protected: false,
      held: false,
      maintenance: this.maintenanceHeld(name),
    });
    if (!decision.allowed) {
      if (decision.reason === "restart-budget") this.restartTimes.set(name, [...decision.state.restartTimes]);
      return false;
    }
    this.restartTimes.set(name, [...decision.state.restartTimes]);
    this.lastKill.set(name, decision.state.lastKill!);
    this.state?.changed();
    return true;
  }

  /** Now, on the guard's own clock: a moment to ask `stoppedOnPurposeSince` about later. */
  now(): number {
    return this.clock();
  }

  /** Someone stopped it, or is changing it, since that moment: a person's action or a package run, not a failure. */
  stoppedOnPurposeSince(name: string, moment: number): boolean {
    return this.isHeld(name) || (this.lastKill.get(name) ?? -Infinity) > moment;
  }

  /** Restarts used per container in the current window, for the heartbeat. */
  restartsUsed(): Record<string, number> {
    this.state?.expire();
    const now = this.clock();
    const used = [...this.restartTimes.keys()].map((name): [string, number] => [
      name,
      this.recentRestarts(name, now).length,
    ]);
    return Object.fromEntries(used.filter(([, count]) => count > 0));
  }

  /** When each container's used-up restarts free again and the wait after its last failure ends, on the wall clock. */
  restartWait(wallNow: number): Record<string, RestartWait> {
    const now = this.clock();
    const wall = (moment: number) => Math.round(wallNow + (moment - now) * MILLISECONDS_PER_SECOND);
    const waits: [string, RestartWait][] = [];
    for (const name of new Set([...this.restartTimes.keys(), ...this.lastHandled.keys()])) {
      const recent = this.recentRestarts(name, now);
      const spent = recent.length >= MAX_RESTARTS_PER_WINDOW;
      const handled = this.lastHandled.get(name);
      const waiting = handled !== undefined && now - handled < HANDLE_COOLDOWN_SECONDS;
      if (!spent && !waiting) continue;
      waits.push([
        name,
        {
          againAt: spent ? wall(Math.min(...recent) + RESTART_WINDOW_SECONDS) : null,
          looksAgainAt: waiting ? wall(handled + HANDLE_COOLDOWN_SECONDS) : null,
        },
      ]);
    }
    return Object.fromEntries(waits);
  }

  /**
   * An admin cleared these containers' restarts and the wait on them, at these moments on the wall clock: what came
   * before no longer counts. The same reset heard again changes nothing. True when something was forgotten.
   */
  resetRestarts(resets: Readonly<Record<string, number>> | undefined, wallNow: number): boolean {
    const now = this.clock();
    let forgot = false;
    for (const [name, at] of Object.entries(resets ?? {})) {
      const moment = now - (wallNow - at) / MILLISECONDS_PER_SECOND;
      const times = this.restartTimes.get(name) ?? [];
      const kept = times.filter((time) => time > moment);
      const handledBefore = (this.lastHandled.get(name) ?? Infinity) <= moment;
      if (kept.length === times.length && !handledBefore) continue;
      this.restartTimes.set(name, kept);
      if (handledBefore) this.lastHandled.delete(name);
      forgot = true;
    }
    if (forgot) this.state?.changed();
    return forgot;
  }

  private stateOf(name: string): RecoveryGuardState {
    return {
      lastKill: this.lastKill.get(name) ?? null,
      lastHandled: this.lastHandled.get(name) ?? null,
      restartTimes: this.restartTimes.get(name) ?? [],
    };
  }

  private recentRestarts(name: string, now: number) {
    return recentRestartTimes(this.restartTimes.get(name) ?? [], now);
  }
}
