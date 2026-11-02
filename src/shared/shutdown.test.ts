import { afterEach, describe, expect, it } from "vitest";
import { untilShutdown } from "./shutdown.js";
import { SHUTDOWN_SIGNALS } from "./constants.js";

const previous = new Map(SHUTDOWN_SIGNALS.map((signal) => [signal, process.listeners(signal)]));
afterEach(() => {
  for (const signal of SHUTDOWN_SIGNALS) {
    for (const listener of process.listeners(signal)) {
      if (!previous.get(signal)!.includes(listener)) process.removeListener(signal, listener);
    }
  }
});
describe("process shutdown", () => {
  it("runs cleanup once across SIGTERM and SIGINT and waits for it", async () => {
    let release!: () => void;
    let calls = 0;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = untilShutdown(async () => {
      calls++;
      await waiting;
    });
    process.emit("SIGTERM", "SIGTERM");
    process.emit("SIGINT", "SIGINT");
    release();
    expect(await result).toBe(0);
    expect(calls).toBe(1);
  });
  it("returns failure when cleanup rejects", async () => {
    const result = untilShutdown(async () => {
      throw new Error("cleanup failure");
    });
    process.emit("SIGTERM", "SIGTERM");
    expect(await result).toBe(1);
  });
  it("bounds a stuck cleanup and keeps the failure result after late completion", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = untilShutdown(() => waiting, 5);
    process.emit("SIGTERM", "SIGTERM");
    expect(await result).toBe(1);
    release();
    expect(await result).toBe(1);
  });
});
