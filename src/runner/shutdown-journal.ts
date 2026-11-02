import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { log } from "../shared/log.js";
import { describeError } from "../shared/errors.js";
import { HOST_HELPER, RUNNER_MESSAGES } from "../shared/constants.js";
import type { FollowedRun } from "./host-package-jobs.js";
import type { DockerClient } from "./docker-client.js";

const LABEL = "autoheal.shutdown.journal";
const RECORD = "autoheal.shutdown.record";
const schema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  operation: z.string().min(1).max(256),
  target: z.string().max(256),
  step: z.number().int().nonnegative(),
  phase: z.string().min(1).max(64),
  reference: z.string().max(256).nullable(),
  at: z.number().int(),
  // A reboot's record: the boot it was started in. Once the host has booted again, the reboot is done.
  bootId: z.string().max(64).nullable().optional(),
});
export type ShutdownRecord = z.infer<typeof schema>;
// A reboot's leftover helper container is removed with its record, where the store can remove containers.
type Store = Pick<DockerClient, "volumes" | "createVolume" | "removeVolume"> & Partial<Pick<DockerClient, "remove">>;
const mutations = new Set([
  "restart",
  "start",
  "stop",
  "pause",
  "unpause",
  "rename",
  "remove",
  "removeStopped",
  "create",
  "connect",
  "disconnect",
  "createNetwork",
  "removeNetwork",
  "tag",
  "removeImage",
  "pruneBuildCache",
  "pull",
  "createVolume",
  "removeVolume",
  "putArchive",
  "runCommand",
]);

/** A write-ahead operation/phase record, on the existing engine. Never contains commands, settings or output. */
export class ShutdownJournal {
  private readonly context = new AsyncLocalStorage<{ record: ShutdownRecord; writes: Promise<void> }>();
  constructor(
    private readonly store: Store,
    // The host's boot now; null where it cannot be read, and then no reboot counts as done.
    private readonly currentBoot: () => string | null = () => null,
  ) {}

  async pending(): Promise<ShutdownRecord[]> {
    const latest = new Map<string, ShutdownRecord>();
    for (const volume of await this.store.volumes(LABEL)) {
      if (volume.Labels?.[LABEL] !== "1")
        throw new Error("Unsupported shutdown journal; operator recovery is required.");
      const record = schema.parse(JSON.parse(volume.Labels?.[RECORD] ?? ""));
      if (volume.Name !== this.name(record))
        throw new Error("Invalid shutdown journal identity; operator recovery is required.");
      const before = latest.get(record.id);
      if (before && (before.operation !== record.operation || before.target !== record.target))
        throw new Error("Inconsistent shutdown journal; operator recovery is required.");
      if (!before || before.step < record.step) latest.set(record.id, record);
    }
    return [...latest.values()].filter((record) => record.phase !== "finished");
  }

  /**
   * A reboot ends the runner along with everything else, often before it can note the hand-over to systemd. Once the
   * host has booted again since the reboot started, that reboot is done: its record is cleared and its helper
   * container removed. Whatever else was interrupted still waits for a person.
   */
  async settleReboots() {
    const now = this.currentBoot();
    const done = (await this.pending()).filter(
      (record) => typeof record.bootId === "string" && now !== null && record.bootId !== now,
    );
    for (const record of done) {
      if (record.reference?.startsWith(HOST_HELPER.containerPrefix)) {
        await this.store.remove?.(record.reference).catch(() => undefined);
      }
      await this.finish(record);
      log(RUNNER_MESSAGES.rebootSettled(record.operation));
    }
  }

  async assertClean() {
    const pending = (await this.pending()).filter(
      (record) => record.phase !== "delegated" || !record.operation.startsWith("host:"),
    );
    if (pending.length)
      throw new Error(
        `Unfinished runner operations require operator recovery before startup: ${JSON.stringify(pending)}`,
      );
  }

  async run<Result>(
    operation: string,
    target: string,
    work: () => Promise<Result>,
    { reboot = false }: { reboot?: boolean } = {},
  ): Promise<Result> {
    // An approved incident enters the same executor as autonomous healing; keep its outer work identity.
    if (this.context.getStore()) return work();
    const record: ShutdownRecord = {
      version: 1,
      id: randomUUID(),
      operation,
      target,
      step: 0,
      phase: "admitted",
      reference: null,
      at: Date.now(),
      ...(reboot ? { bootId: this.currentBoot() } : {}),
    };
    await this.save(record);
    return this.context.run({ record, writes: Promise.resolve() }, async () => {
      const result = await work();
      await this.finish(this.context.getStore()!.record).catch((error: unknown) =>
        log(`Retained shutdown journal for ${operation}: ${describeError(error)}`),
      );
      return result;
    });
  }

  /** systemd now owns this host job; it must be followed, never launched again after restart. */
  delegate(jobId: string) {
    return this.phase("delegated", jobId);
  }

  async hostLaunchesSettled() {
    while (
      (await this.pending()).some((record) => record.operation.startsWith("host:") && record.phase !== "delegated")
    ) {
      await sleep(50);
    }
  }

  async reconcileHostRuns(runs: FollowedRun[]) {
    for (const record of (await this.pending()).filter((entry) => entry.phase === "delegated")) {
      const run = runs.find((entry) => `host:${entry.jobId}` === record.operation && entry.jobId === record.reference);
      if (!run)
        throw new Error(
          `Host job ${record.reference} needs operator reconciliation; its status files are unavailable.`,
        );
      void run.result.then(() => this.finish(record)).catch((error: unknown) => log(describeError(error)));
    }
  }

  private async finish(record: ShutdownRecord) {
    const next = { ...record, step: record.step + 1, phase: "finished", reference: null, at: Date.now() };
    await this.save(next);
    const volumes = (await this.store.volumes(LABEL)).filter((volume) =>
      volume.Name.startsWith(`autoheal-shutdown-${record.id}-`),
    );
    const last = this.name(next);
    for (const volume of volumes) if (volume.Name !== last) await this.store.removeVolume(volume.Name);
    await this.store.removeVolume(last);
  }

  /** Instrument only mutation entrypoints; transport details and ordinary readers stay in DockerClient. */
  docker<Client extends object>(client: Client): Client {
    const methods = new Map<PropertyKey, unknown>();
    return new Proxy(client, {
      get: (target, key) => {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        if (!methods.has(key))
          methods.set(key, (...args: unknown[]) => {
            const invoke = () => Reflect.apply(value, target, args);
            if (!mutations.has(String(key)) || !this.context.getStore()) return invoke();
            // Names/immutable IDs only. In particular, never record a command, archive, environment or shell input.
            const reference = typeof args[0] === "string" ? args[0].slice(0, 256) : null;
            return this.phase(String(key), reference).then(invoke);
          });
        return methods.get(key);
      },
    });
  }

  private phase(phase: string, reference: string | null): Promise<void> {
    const context = this.context.getStore()!;
    context.writes = context.writes.then(async () => {
      const next = { ...context.record, step: context.record.step + 1, phase, reference, at: Date.now() };
      await this.save(next);
      context.record = next;
    });
    return context.writes;
  }

  private save(record: ShutdownRecord) {
    return this.store.createVolume(this.name(record), { [LABEL]: "1", [RECORD]: JSON.stringify(schema.parse(record)) });
  }
  private name(record: ShutdownRecord) {
    return `autoheal-shutdown-${record.id}-${record.step}`;
  }
}
