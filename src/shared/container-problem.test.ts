import { describe, expect, it } from "vitest";
import { containerSnapshot } from "../../test/support/inventory.js";
import { containerProblem } from "./container-problem.js";

describe("containerProblem", () => {
  it.each([
    ["an unhealthy container", { health: "unhealthy" }, "unhealthy"],
    ["a restart loop", { state: "restarting" }, "restarting"],
    ["a dead container", { state: "dead" }, "dead"],
    ["an out-of-memory kill", { state: "exited", exitCode: 137, oomKilled: true }, "out_of_memory"],
    ["a crash", { state: "exited", exitCode: 1 }, "crashed"],
    ["a crash, whatever health Docker last recorded", { state: "exited", exitCode: 1, health: "unhealthy" }, "crashed"],
  ] as const)("flags %s", (_case, signals, problem) => {
    expect(containerProblem(containerSnapshot(signals))).toBe(problem);
  });

  it.each([
    ["a healthy running container", {}],
    ["a clean exit", { state: "exited", exitCode: 0 }],
    ["docker stop (SIGTERM)", { state: "exited", exitCode: 143 }],
    ["docker stop after the grace period (SIGKILL)", { state: "exited", exitCode: 137 }],
    ["a stopped container with a stale unhealthy status", { state: "exited", exitCode: 0, health: "unhealthy" }],
    ["a container that was never started", { state: "created", health: "none" }],
    ["a paused container", { state: "paused" }],
  ] as const)("leaves %s alone", (_case, signals) => {
    expect(containerProblem(containerSnapshot(signals))).toBeNull();
  });
});
