import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUNNER_REHAND_MILLISECONDS } from "../../shared/constants.js";
import { RunnerRelay } from "./runner-relay.js";

describe("requests relayed to a host's runner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands a read out again, once, when its runner has not answered a while after its poll took it", async () => {
    const wake = vi.fn();
    const relay = new RunnerRelay<{ id: string }, string>({ wake }, () => true);
    const answered = relay.ask("host", { id: "list" });
    expect(relay.take("host")).toEqual([{ id: "list" }]);
    expect(relay.take("host")).toEqual([]);

    vi.advanceTimersByTime(RUNNER_REHAND_MILLISECONDS);
    // The poll waiting for work hears of it: a lost hand-over is not left to the next poll.
    expect(wake).toHaveBeenCalledTimes(2);
    expect(relay.take("host")).toEqual([{ id: "list" }]);
    vi.advanceTimersByTime(RUNNER_REHAND_MILLISECONDS);
    expect(relay.take("host")).toEqual([]);

    relay.answer("host", "list", "entries");
    await expect(answered).resolves.toBe("entries");
  });

  it("never hands out twice a request that changes something", () => {
    const relay = new RunnerRelay<{ id: string }, string>({ wake: vi.fn() });
    void relay.ask("host", { id: "save" }).catch(() => undefined);
    expect(relay.take("host")).toEqual([{ id: "save" }]);
    vi.advanceTimersByTime(RUNNER_REHAND_MILLISECONDS);
    expect(relay.take("host")).toEqual([]);
  });
});
