import { readFileSync } from "node:fs";
import { uptime } from "node:os";
import { z } from "zod";
import {
  DELIBERATE_STOP_WINDOW_SECONDS,
  HANDLE_COOLDOWN_SECONDS,
  MAX_RESTARTS_PER_WINDOW,
  MILLISECONDS_PER_SECOND,
  RECOVERY_HOLD,
  RESTART_WINDOW_SECONDS,
} from "../shared/constants.js";
import { log } from "../shared/log.js";
import type { RecoveryHold } from "../shared/protocol.js";
import type { DockerClient } from "./docker-client.js";

const LABEL = "autoheal.guard.state";
const RECORD = "autoheal.guard.record";
const PREFIX = "autoheal-guard-";
const MAX_ENTRIES = 4096;
const MAX_BYTES = 1024 * 1024;
const timestamp = z.number().finite().nonnegative();
const schema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative().safe(),
    bootId: z.string().min(1).max(64),
    savedAt: timestamp,
    uptime: timestamp,
    uncertainAt: timestamp.nullable(),
    entries: z
      .array(
        z
          .object({
            name: z.string().min(1).max(256),
            killed: timestamp.nullable(),
            handled: timestamp.nullable(),
            restarts: z.array(timestamp).max(MAX_RESTARTS_PER_WINDOW),
          })
          .strict(),
      )
      .max(MAX_ENTRIES),
  })
  .strict();
type Record = z.infer<typeof schema>;
// More live entries than one saved record holds: a full state, not a store that refused a write.
class GuardStateFull extends Error {
  constructor() {
    super("Guard state capacity exceeded.");
  }
}
type Store = Pick<DockerClient, "volumes" | "createVolume" | "removeVolume">;
export interface GuardTiming {
  clock: () => number;
  wall: () => number;
  uptime: () => number;
  bootId: () => string;
}
export const monotonicSeconds = () => performance.now() / 1000;
// The kernel's id for this boot: the host's, even inside the runner's container.
const KERNEL_BOOT_ID = "/proc/sys/kernel/random/boot_id";
/** The host's boot id now, or null where it cannot be read. */
export function kernelBootId(): string | null {
  try {
    return readFileSync(KERNEL_BOOT_ID, "utf8").trim() || null;
  } catch {
    return null;
  }
}
const timing: GuardTiming = {
  clock: monotonicSeconds,
  wall: () => Date.now() / 1000,
  uptime,
  bootId: () => readFileSync(KERNEL_BOOT_ID, "utf8").trim(),
};

/** Bounded engine metadata, shared with the runner's existing Docker trust boundary. No new host mount. */
export class GuardState {
  readonly lastKill = new Map<string, number>();
  readonly lastHandled = new Map<string, number>();
  readonly restartTimes = new Map<string, number[]>();
  private uncertainAt: number | null = null;
  private revision = 0;
  private names: string[] = [];
  private dirty = false;
  private writing: Promise<void> | null = null;
  private failure: typeof RECOVERY_HOLD.saveFailed | typeof RECOVERY_HOLD.stateFull | null = null;
  private readonly bootId: string;
  readonly clock: () => number;

  private constructor(
    private readonly store: Store,
    private readonly time: GuardTiming,
  ) {
    this.clock = time.clock;
    this.bootId = time.bootId();
  }

  static async open(store: Store, time: GuardTiming = timing): Promise<GuardState> {
    try {
      const state = new GuardState(store, time);
      const volumes = await store.volumes(LABEL);
      if (volumes.length > 32) throw new Error("Too many retained guard records.");
      let latest: Record | null = null;
      for (const volume of volumes) {
        const text = volume.Labels?.[RECORD] ?? "";
        if (volume.Labels?.[LABEL] !== "1" || Buffer.byteLength(text) > MAX_BYTES)
          throw new Error("Invalid guard record.");
        const record = schema.parse(JSON.parse(text));
        if (
          volume.Name !== `${PREFIX}${record.revision}` ||
          new Set(record.entries.map(({ name }) => name)).size !== record.entries.length ||
          [
            record.uncertainAt,
            ...record.entries.flatMap(({ killed, handled, restarts }) => [killed, handled, ...restarts]),
          ].some((at) => at !== null && at > record.savedAt)
        )
          throw new Error("Invalid guard identity or timestamps.");
        state.names.push(volume.Name);
        if (latest === null || latest.revision < record.revision) latest = record;
      }
      const now = time.clock();
      if (latest === null) {
        // A fresh install and erased state are indistinguishable: neither grants immediate restart credits.
        state.uncertainAt = now;
        log("No saved runner safety state: automatic recovery is held for one restart window (one hour).");
      } else {
        state.revision = latest.revision;
        const currentUptime = time.uptime();
        const elapsed =
          latest.bootId === state.bootId
            ? Math.max(0, currentUptime - latest.uptime - 1)
            : Math.max(0, time.wall() - latest.savedAt);
        const restored = (at: number) => now - (latest.savedAt - at + elapsed);
        state.uncertainAt = latest.uncertainAt === null ? null : restored(latest.uncertainAt);
        for (const entry of latest.entries) {
          if (entry.killed !== null) state.lastKill.set(entry.name, restored(entry.killed));
          if (entry.handled !== null) state.lastHandled.set(entry.name, restored(entry.handled));
          if (entry.restarts.length) state.restartTimes.set(entry.name, entry.restarts.map(restored));
        }
      }
      state.changed();
      await state.flush();
      return state;
    } catch {
      throw new Error(
        "Runner safety state is unreadable or invalid; preserve autoheal-guard-* volumes and review recovery before starting the runner.",
      );
    }
  }

  unavailable() {
    return this.failure !== null;
  }

  blocked() {
    return this.recoveryHold() !== null;
  }

  /** Why automatic recovery is held now, and when that ends by itself; null while it may act. */
  recoveryHold(): RecoveryHold | null {
    if (this.failure !== null) {
      return { reason: this.failure, until: null };
    }
    const heldFor = this.uncertainAt === null ? null : this.clock() - this.uncertainAt;
    if (heldFor === null || heldFor >= RESTART_WINDOW_SECONDS) {
      return null;
    }
    const endsAt = this.time.wall() + RESTART_WINDOW_SECONDS - heldFor;
    return { reason: RECOVERY_HOLD.noSavedState, until: Math.round(endsAt * MILLISECONDS_PER_SECOND) };
  }

  /** Persist before a caller may actuate a restart or acknowledge a managed change/event. */
  async flush() {
    while (this.writing !== null) await this.writing;
    if (this.failure !== null)
      throw new Error("Runner safety state could not be persisted; automatic recovery is blocked.");
  }

  changed() {
    if (this.failure !== null) return;
    if (this.lastKill.size + this.lastHandled.size + this.restartTimes.size > MAX_ENTRIES * 3) {
      this.failure = RECOVERY_HOLD.stateFull;
      log("Runner safety state capacity exceeded; recovery is blocked.");
      return;
    }
    this.dirty = true;
    if (this.writing !== null) return;
    this.writing = Promise.resolve()
      .then(async () => {
        while (this.dirty) {
          this.dirty = false;
          await this.save();
        }
      })
      .catch((error: unknown) => {
        if (error instanceof GuardStateFull) {
          this.failure = RECOVERY_HOLD.stateFull;
          log("Runner safety state capacity exceeded; recovery is blocked.");
          return;
        }
        this.failure = RECOVERY_HOLD.saveFailed;
        log("Runner safety state persistence failed; recovery is blocked until the saved state is reviewed.");
      })
      .finally(() => {
        this.writing = null;
        if (this.dirty && this.failure === null) this.changed();
      });
  }

  expire() {
    if (this.prune()) this.changed();
  }

  private prune(): boolean {
    const now = this.clock();
    let changed = false;
    for (const [map, window] of [
      [this.lastKill, DELIBERATE_STOP_WINDOW_SECONDS],
      [this.lastHandled, HANDLE_COOLDOWN_SECONDS],
    ] as const) {
      for (const [name, at] of map)
        if (now - at >= window) {
          map.delete(name);
          changed = true;
        }
    }
    for (const [name, times] of this.restartTimes) {
      const recent = times.filter((at) => now - at < RESTART_WINDOW_SECONDS);
      if (recent.length !== times.length) changed = true;
      if (recent.length) this.restartTimes.set(name, recent);
      else this.restartTimes.delete(name);
    }
    if (this.uncertainAt !== null && now - this.uncertainAt >= RESTART_WINDOW_SECONDS) {
      this.uncertainAt = null;
      changed = true;
    }
    return changed;
  }

  private async save() {
    this.prune();
    const now = this.clock();
    const wall = this.time.wall();
    const at = (value: number) => wall - (now - value);
    const names = new Set([...this.lastKill.keys(), ...this.lastHandled.keys(), ...this.restartTimes.keys()]);
    if (names.size > MAX_ENTRIES) throw new GuardStateFull();
    const record = schema.parse({
      version: 1,
      revision: this.revision + 1,
      bootId: this.bootId,
      savedAt: wall,
      uptime: this.time.uptime(),
      uncertainAt: this.uncertainAt === null ? null : at(this.uncertainAt),
      entries: [...names].map((name) => ({
        name,
        killed: this.lastKill.has(name) ? at(this.lastKill.get(name)!) : null,
        handled: this.lastHandled.has(name) ? at(this.lastHandled.get(name)!) : null,
        restarts: (this.restartTimes.get(name) ?? []).map(at),
      })),
    });
    const text = JSON.stringify(record);
    if (Buffer.byteLength(text) > MAX_BYTES) throw new GuardStateFull();
    const name = `${PREFIX}${record.revision}`;
    await this.store.createVolume(name, { [LABEL]: "1", [RECORD]: text });
    const published = (await this.store.volumes(LABEL)).find((volume) => volume.Name === name);
    if (published?.Labels?.[LABEL] !== "1" || published.Labels[RECORD] !== text) {
      throw new Error("Guard state publication could not be verified.");
    }
    this.revision = record.revision;
    const before = this.names;
    this.names = [name];
    // Publish first; only then remove older snapshots. A cleanup failure blocks further recovery, not safety reads.
    for (const previous of before) await this.store.removeVolume(previous);
  }
}
