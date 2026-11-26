import { describe, expect, it } from "vitest";
import { coalesced, skippedWhileRunning } from "./one-at-a-time.js";

// Work that waits until the test lets it end, counting how often it started.
function heldWork() {
  const releases: (() => void)[] = [];
  let started = 0;
  const work = () =>
    new Promise<void>((resolve) => {
      started += 1;
      releases.push(resolve);
    });
  return { work, started: () => started, release: () => releases.shift()?.() };
}

describe("work that runs one at a time", () => {
  it("runs a report once more after the one running, however often it was asked meanwhile", async () => {
    const held = heldWork();
    const report = coalesced(held.work);
    const first = report();
    void report();
    void report();
    expect(held.started()).toBe(1);
    held.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(held.started()).toBe(2);
    held.release();
    await first;
    expect(held.started()).toBe(2);
  });

  it("skips a sample asked for while one is still being read, and takes the next once it is done", async () => {
    const held = heldWork();
    const sample = skippedWhileRunning(held.work);
    const first = sample();
    await sample();
    expect(held.started()).toBe(1);
    held.release();
    await first;
    void sample();
    expect(held.started()).toBe(2);
    held.release();
  });
});
