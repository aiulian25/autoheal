import { describe, expect, it } from "vitest";
import { DecisionQueue } from "./decision-queue.js";

const deferred = () => {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => (resolve = done));
  return { promise, resolve };
};

const abortable = (gate: Promise<string>, signal: AbortSignal) =>
  new Promise<string>((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason));
    void gate.then(resolve);
  });

describe("DecisionQueue", () => {
  it("cancels queued work and isolates late completion from the resumed queue", async () => {
    const queue = new DecisionQueue();
    const old = deferred();
    const fresh = deferred();
    const running = queue.enqueue("live", () => old.promise);
    const queued = queue.enqueue("replay", async () => "must not run");
    queue.cancelAll();
    await expect(running).rejects.toThrow("restore_maintenance");
    await expect(queued).rejects.toThrow("restore_maintenance");
    await expect(queue.enqueue("live", async () => "paused")).rejects.toThrow("restore_maintenance");
    queue.resume();
    const next = queue.enqueue("live", () => fresh.promise);
    old.resolve("late");
    await Promise.resolve();
    await Promise.resolve();
    fresh.resolve("fresh");
    expect(await next).toBe("fresh");
  });

  it("runs one job at a time", async () => {
    const queue = new DecisionQueue();
    let running = 0;
    let mostAtOnce = 0;
    const job = async () => {
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return "done";
    };
    await Promise.all([queue.enqueue("live", job), queue.enqueue("live", job), queue.enqueue("replay", job)]);
    expect(mostAtOnce).toBe(1);
  });

  it("stops a running replay for a live incident and re-runs it afterwards", async () => {
    const queue = new DecisionQueue();
    const finished: string[] = [];
    let replayStarts = 0;
    const replayGate = deferred();
    const replay = queue
      .enqueue("replay", (signal) => {
        replayStarts += 1;
        return replayStarts === 1 ? abortable(replayGate.promise, signal) : Promise.resolve("replay");
      })
      .then((value) => finished.push(value));
    const secondReplay = queue.enqueue("replay", async () => "second replay").then((value) => finished.push(value));
    await new Promise((resolve) => setTimeout(resolve, 1));
    const live = queue.enqueue("live", async () => "live").then((value) => finished.push(value));
    await Promise.all([replay, secondReplay, live]);
    expect(finished).toEqual(["live", "replay", "second replay"]);
    expect(replayStarts).toBe(2);
  });

  it("lets a failing job fail alone", async () => {
    const queue = new DecisionQueue();
    const failing = queue.enqueue("live", async () => {
      throw new Error("model crashed");
    });
    const healthy = queue.enqueue("live", async () => "fine");
    await expect(failing).rejects.toThrow("model crashed");
    await expect(healthy).resolves.toBe("fine");
  });
});
