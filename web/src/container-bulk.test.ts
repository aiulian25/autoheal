import { describe, expect, it } from "vitest";
import type { ContainerView, JobView } from "../../src/shared/api.js";
import { progressOf, targetsOf, type BulkAction } from "./container-bulk.js";

// Only what the rules read: the name, the state, what the host says, and the image's update.
const container = (name: string, state: string, overrides: Partial<ContainerView> = {}) =>
  ({
    name,
    state,
    handsOff: null,
    update: { status: "current", checkedAt: 1, policy: "ask", remote: null, reason: null },
    ...overrides,
  }) as ContainerView;

const job = (id: string, status: JobView["status"]) => ({ id, status, outcome: null }) as JobView;

describe("what a bulk action reaches", () => {
  const ticked = [
    container("web", "running"),
    container("db", "exited"),
    container("cache", "paused"),
    container("nightly", "created"),
    container("runner", "running", { handsOff: "protected" }),
    container("app", "running", {
      update: { status: "available", checkedAt: 1, policy: "ask", remote: null, reason: null },
    }),
  ];
  const reached = (action: BulkAction) => targetsOf(action, ticked).map((container) => container.name);

  it("restarts and stops the running ones, starts the stopped ones, removes any, never one its host keeps", () => {
    expect(reached("restart")).toEqual(["web", "app"]);
    expect(reached("stop")).toEqual(["web", "app"]);
    expect(reached("start")).toEqual(["db", "nightly"]);
    expect(reached("remove")).toEqual(["web", "db", "cache", "nightly", "app"]);
    expect(reached("pause")).toEqual(["web", "app"]);
    expect(reached("unpause")).toEqual(["cache"]);
    expect(reached("update")).toEqual(["app"]);
    expect(reached("check_updates")).toEqual(["web", "db", "cache", "nightly", "app"]);
  });

  it("excludes recovering containers from normal starts and removals", () => {
    const recovering = container("db", "exited", { recovery: { owner: "db" } });
    expect(targetsOf("start", [recovering])).toEqual([]);
    expect(targetsOf("remove", [recovering])).toEqual([]);
  });

  it("follows the jobs it asked for until each ended, counting a job not listed yet as waiting", () => {
    expect(progressOf(["a", "b", "c"], [job("a", "succeeded"), job("b", "delivered"), job("x", "failed")])).toEqual({
      waiting: 2,
      succeeded: 1,
      failed: [],
    });
    const ended = progressOf(["a", "b", "c"], [job("a", "succeeded"), job("b", "failed"), job("c", "expired")]);
    expect(ended.waiting).toBe(0);
    expect(ended.succeeded).toBe(1);
    expect(ended.failed.map((failed) => failed.id)).toEqual(["b", "c"]);
  });
});
