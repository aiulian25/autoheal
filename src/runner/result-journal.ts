import { JOB_OUTCOMES, RUNNER_BODY_LIMIT_BYTES, RUNNER_MESSAGES, VERDICT_ESCALATED } from "../shared/constants.js";
import { z } from "zod";
import { handledIncidentSchema, outcomeSchema, jobResultSchema, type Outcome } from "../shared/protocol.js";
import { describeError } from "../shared/errors.js";
import { log } from "../shared/log.js";
import type { DockerClient } from "./docker-client.js";

const LABEL = "autoheal.result.journal";
const RECORD = "autoheal.result.record";
const PREFIX = "autoheal-results-";
const MAX_BYTES = 256 * RUNNER_BODY_LIMIT_BYTES;
// Snapshots on the engine at once; reaching this many, something keeps refusing their removal, and actions stop.
const MAX_SNAPSHOTS = 32;
const identity = { id: z.string().min(1).max(128) };
const reportSchema = z.discriminatedUnion("kind", [
  z.object({ ...identity, kind: z.literal("incident"), result: outcomeSchema }),
  z.object({ ...identity, kind: z.literal("handled"), result: handledIncidentSchema }),
  z.object({ ...identity, kind: z.literal("work"), result: outcomeSchema }),
  z.object({ ...identity, kind: z.literal("job"), result: jobResultSchema }),
]);
export type ResultReport = z.infer<typeof reportSchema>;
export type ResultKind = ResultReport["kind"];
const entrySchema = z.object({
  id: identity.id,
  target: z.string().min(1).max(256),
  kind: z.enum(["incident", "handled", "work", "job"]),
  report: reportSchema.nullable(),
});
const schema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative().safe(),
  entries: z.array(entrySchema).max(256),
});
type Entry = z.infer<typeof entrySchema>;
type Store = Pick<DockerClient, "volumes" | "createVolume" | "removeVolume">;
const keyOf = (entry: Pick<Entry, "kind" | "id">) => `${entry.kind}:${entry.id}`;
const INTERRUPTED: Outcome = { outcome: JOB_OUTCOMES.actionInterrupted, verdict: VERDICT_ESCALATED, executed: false };

/**
 * The result an interrupted action is closed with, so its id never runs again and its container may be acted on.
 * Null for an incident this runner decided alone, which can never be sent again by id: its reservation just goes.
 */
function interruptedReport(entry: Entry): ResultReport | null {
  if (entry.kind === "job") {
    return {
      kind: "job",
      id: entry.id,
      result: { succeeded: false, outcome: JOB_OUTCOMES.interruptedByRestart, output: null },
    };
  }
  if (entry.kind === "incident") return { kind: "incident", id: entry.id, result: INTERRUPTED };
  if (entry.kind === "work") return { kind: "work", id: entry.id, result: INTERRUPTED };
  return null;
}

/** Result delivery only. Reservations left by interrupted execution are never replayed as actions.
 * Payloads share the existing Docker administrator trust boundary; terminal/file traffic is excluded.
 */
export class ResultJournal {
  private entries = new Map<string, Entry>();
  private revision = 0;
  private names: string[] = [];
  private writing: Promise<unknown> = Promise.resolve();
  private sending: Promise<void> | null = null;
  private failed = false;
  private readonly owned = new Set<string>();

  // An in-memory adapter for isolated users/tests; the runner always opens durable storage.
  constructor(
    private readonly store: Store | null = null,
    private readonly capacity = 256,
  ) {}

  static async open(store: Store, capacity = 256) {
    const journal = new ResultJournal(store, capacity);
    const volumes = await store.volumes(LABEL).catch((error: unknown) => {
      throw new Error(RUNNER_MESSAGES.resultJournalUnread(describeError(error)));
    });
    try {
      if (volumes.length > MAX_SNAPSHOTS) throw new Error("Excess retained snapshots");
      for (const volume of volumes) {
        const text = volume.Labels?.[RECORD] ?? "";
        if (Buffer.byteLength(text) > MAX_BYTES || volume.Labels?.[LABEL] !== "1") throw new Error("Invalid snapshot");
        const snapshot = schema.parse(JSON.parse(text));
        if (volume.Name !== `${PREFIX}${snapshot.revision}`) throw new Error("Invalid identity");
        journal.names.push(volume.Name);
        const entries = new Map(snapshot.entries.map((entry) => [keyOf(entry), entry]));
        if (
          entries.size !== snapshot.entries.length ||
          snapshot.entries.some((entry) => entry.report !== null && keyOf(entry.report) !== keyOf(entry))
        )
          throw new Error("Invalid entries");
        if (snapshot.revision >= journal.revision) {
          journal.revision = snapshot.revision;
          journal.entries = entries;
        }
      }
      const interrupted = [...journal.entries.values()].filter((entry) => entry.report === null).length;
      if (interrupted > 0)
        log(
          `${interrupted} interrupted actions have result reservations. Reconcile them using operation records; they will not be executed again for result delivery.`,
        );
      await journal.change(() => undefined); // Verify writable storage before admitting actions.
      return journal;
    } catch {
      throw new Error(
        "Runner result journal is unavailable or corrupt. Preserve autoheal-results-* volumes and recover reports before admitting actions.",
      );
    }
  }

  count(kinds: readonly ResultKind[], readyOnly = false) {
    return [...this.entries.values()].filter(
      (entry) => kinds.includes(entry.kind) && (!readyOnly || entry.report !== null),
    ).length;
  }

  /** Jobs on this target an earlier runner reserved and never finished: what a restart or a reboot left behind. */
  unfinished(target: string): string[] {
    return [...this.entries.values()]
      .filter(
        (entry) =>
          entry.kind === "job" && entry.target === target && entry.report === null && !this.owned.has(keyOf(entry)),
      )
      .map((entry) => entry.id);
  }

  /**
   * Actions an earlier runner reserved and never finished, once its shutdown journal holds nothing half done: each
   * gets a result saying its end is unknown, for a person to look at. Its id still never runs again, and its
   * container may be acted on again, instead of every later action on it being refused with no way out.
   */
  async settleInterrupted() {
    const interrupted = [...this.entries.values()].filter(
      (entry) => entry.report === null && !this.owned.has(keyOf(entry)),
    );
    if (interrupted.length === 0) return;
    await this.change(() => {
      for (const entry of interrupted) {
        const report = interruptedReport(entry);
        if (report === null) this.entries.delete(keyOf(entry));
        else entry.report = report;
      }
    });
    log(RUNNER_MESSAGES.interruptedJobsSettled(interrupted.length));
  }

  /** False means an existing action/result: do not execute it again. */
  reserve(kind: ResultKind, id: string, target = id): Promise<boolean> {
    return this.change(() => {
      const key = keyOf({ kind, id });
      if (this.entries.has(key)) return false;
      if (
        [...this.entries.values()].some(
          (entry) => entry.target === target && entry.report === null && !this.owned.has(keyOf(entry)),
        )
      )
        throw new Error(
          `An interrupted action on ${target} requires reconciliation; a new action ID cannot bypass it.`,
        );
      if (this.entries.size >= this.capacity)
        throw new Error(
          "Runner result journal is full; new actions are paused. Restore result delivery before retrying.",
        );
      this.entries.set(key, { kind, id, target, report: null });
      this.owned.add(key);
      return true;
    });
  }

  async complete(report: ResultReport, followingHostRun = false) {
    const parsed = reportSchema.parse(report);
    await this.change(() => {
      const key = keyOf(parsed);
      const entry = this.entries.get(key);
      if (!entry) throw new Error("Result has no durable reservation.");
      if (entry.report !== null) {
        if (JSON.stringify(entry.report) !== JSON.stringify(parsed))
          throw new Error("Conflicting saved result; operator recovery required.");
        return;
      }
      if (!followingHostRun && !this.owned.has(key))
        throw new Error("Interrupted action requires reconciliation; execution will not be repeated.");
      entry.report = parsed;
    });
  }

  // A result refused for good is dropped, saying so once, instead of being sent again for ever.
  flush(
    kinds: readonly ResultKind[],
    send: (report: ResultReport) => Promise<unknown>,
    refusedForGood: (error: unknown) => boolean = () => false,
  ): Promise<void> {
    // Consumers may share storage, but each must flush its own report kinds.
    const previous = this.sending ?? Promise.resolve();
    const sending = previous
      .catch(() => undefined)
      .then(async () => {
        // Read only after earlier publications finish. A heartbeat must not see a result
        // while complete() is still publishing it to durable storage.
        const ready = await this.writing.then(() => {
          if (this.failed) throw new Error("Result storage is unavailable; recover it before report delivery.");
          return [...this.entries.values()]
            .filter((entry) => kinds.includes(entry.kind) && entry.report !== null)
            .map((entry) => entry.report!);
        });
        for (const report of ready) {
          try {
            await send(report);
          } catch (error) {
            if (!refusedForGood(error)) {
              log(`Runner result ${report.kind}:${report.id} remains unacknowledged; retained for report retry.`);
              continue;
            }
            log(`Runner result ${report.kind}:${report.id} was refused for good by the control plane; dropped.`);
          }
          await this.change(() => {
            this.entries.delete(keyOf(report));
            this.owned.delete(keyOf(report));
          });
        }
      });
    this.sending = sending;
    return sending.finally(() => {
      if (this.sending === sending) this.sending = null;
    });
  }

  private change<T>(apply: () => T): Promise<T> {
    const changed = this.writing.then(async () => {
      if (this.failed) throw new Error("Runner result persistence failed; new actions are blocked.");
      const result = apply();
      if (this.store !== null) {
        try {
          const text = JSON.stringify(
            schema.parse({ version: 1, revision: this.revision + 1, entries: [...this.entries.values()] }),
          );
          if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Result journal size exceeded");
          const name = `${PREFIX}${this.revision + 1}`;
          await this.store.createVolume(name, { [LABEL]: "1", [RECORD]: text });
          const saved = (await this.store.volumes(LABEL)).find((volume) => volume.Name === name);
          if (saved?.Labels?.[RECORD] !== text) throw new Error("Unverified publication");
          this.revision += 1;
          // An old snapshot Docker will not remove now (another container mounted every volume for a moment) is
          // tried again at the next change: the newest is read first anyway.
          const kept: string[] = [];
          for (const old of this.names) await this.store.removeVolume(old).catch(() => kept.push(old));
          this.names = [name, ...kept];
          if (this.names.length >= MAX_SNAPSHOTS) throw new Error("Excess retained snapshots");
        } catch {
          this.failed = true;
          throw new Error("Runner result persistence failed; preserve journal volumes and stop new actions.");
        }
      }
      return result;
    });
    this.writing = changed.catch(() => undefined);
    return changed;
  }
}
