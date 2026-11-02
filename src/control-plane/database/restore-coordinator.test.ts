import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import { RestoreCoordinator } from "./restore-coordinator.js";
const barrier = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
describe("restore lifecycle", () => {
  it("drains fire-and-forget child methods, preserves sync results and rejects overlapping restore", async () => {
    const lifecycle = new RestoreCoordinator();
    const paused = barrier();
    let finished = false;
    const service = lifecycle.wrap({
      answer() {
        return 42;
      },
      start() {
        void this.child();
      },
      async child() {
        await paused.promise;
        finished = true;
      },
    });
    expect(service.answer()).toBe(42);
    service.start();
    let swapped = false;
    const restore = lifecycle.exclusive(async () => {
      expect(finished).toBe(true);
      swapped = true;
      lifecycle.replaced();
    });
    expect(lifecycle.busy).toBe(true);
    expect(swapped).toBe(false);
    expect(() => service.answer()).toThrow("restore_maintenance");
    await expect(lifecycle.exclusive(async () => {})).rejects.toThrow("restore_busy");
    paused.release();
    await restore;
    expect(service.answer()).toBe(42);
  });
  it("rejects late callbacks from an old generation after maintenance ends", async () => {
    const lifecycle = new RestoreCoordinator();
    let late!: () => void;
    lifecycle.run(() => {
      late = AsyncLocalStorage.bind(() => lifecycle.assertCurrent());
    });
    await lifecycle.exclusive(async () => {
      lifecycle.replaced();
    });
    expect(late).toThrow("restore_maintenance");
    expect(() => lifecycle.run(() => 1)).not.toThrow();
  });
  it("does not enter restore work if draining times out and releases the gate", async () => {
    const lifecycle = new RestoreCoordinator();
    const paused = barrier();
    const active = lifecycle.run(() => paused.promise);
    let swapped = false;
    await expect(
      lifecycle.exclusive(async () => {
        swapped = true;
      }, 5),
    ).rejects.toThrow("restore_drain_busy");
    expect(swapped).toBe(false);
    expect(lifecycle.busy).toBe(false);
    paused.release();
    await active;
  });
});

describe("shutdown lifecycle", () => {
  it("pauses admitted services, drains children, gates new requests and fences late callbacks", async () => {
    const lifecycle = new RestoreCoordinator();
    const gate = barrier();
    const events: string[] = [];
    let late!: () => void;
    const service = lifecycle.wrap({
      pause() {
        events.push("paused");
      },
      async backup() {
        await gate.promise;
        lifecycle.assertCurrent();
        events.push("backup done");
      },
    });
    lifecycle.onPause(() => service.pause());
    lifecycle.run(() => {
      late = AsyncLocalStorage.bind(() => lifecycle.assertCurrent());
    });
    const backup = service.backup();
    const shutdown = lifecycle.shutdown().then(() => events.push("safe to close database"));
    expect(events).toEqual(["paused"]);
    expect(() => lifecycle.request(() => {})).toThrow("restore_maintenance");
    gate.release();
    await backup;
    await shutdown;
    expect(events).toEqual(["paused", "backup done", "safe to close database"]);
    expect(late).toThrow("restore_maintenance");
    expect(() => service.pause()).toThrow("restore_maintenance");
  });
  it("waits for an in-progress exclusive restore, including post-swap settlement", async () => {
    const lifecycle = new RestoreCoordinator();
    const gate = barrier();
    let settled = false;
    const restore = lifecycle.exclusive(async () => {
      await gate.promise;
      lifecycle.replaced();
      settled = true;
    });
    // Let the exclusive operation enter its protected work before asking for shutdown.
    await Promise.resolve();
    const shutdown = lifecycle.shutdown();
    expect(settled).toBe(false);
    gate.release();
    await restore;
    await shutdown;
    expect(settled).toBe(true);
    expect(lifecycle.busy).toBe(true);
  });
});
