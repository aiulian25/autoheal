import { describe, expect, it } from "vitest";
import { RuntimeLifecycle } from "./runtime-lifecycle.js";
it("drains all admitted scheduled work and refuses later timer callbacks", async () => {
  const lifecycle = new RuntimeLifecycle();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const task = lifecycle.run(async () => {
    await gate;
    events.push("finished");
  });
  lifecycle.stop();
  await lifecycle.run(() => events.push("late timer"));
  let done = false;
  const drain = lifecycle.settled().then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  release();
  await task;
  await drain;
  expect(events).toEqual(["finished"]);
});
describe("rejected scheduled work", () => {
  it("leaves no stuck ownership after its caller handles the error", async () => {
    const lifecycle = new RuntimeLifecycle();
    await expect(
      lifecycle.run(async () => {
        throw new Error("synthetic");
      }),
    ).rejects.toThrow("synthetic");
    lifecycle.stop();
    await lifecycle.settled();
  });
});
