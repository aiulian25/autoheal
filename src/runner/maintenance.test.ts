import { describe, expect, it } from "vitest";
import { MaintenanceGate } from "./maintenance.js";

const NOW = Date.UTC(2026, 9, 27);
describe("runner maintenance policy", () => {
  it("blocks before the initial policy and after its freshness lease, including runner reconstruction", () => {
    let elapsed = 0;
    const gate = new MaintenanceGate(
      () => NOW + elapsed,
      () => elapsed,
    );
    expect(gate.held("db")).toBe(true);
    gate.apply({ generation: 1, observedAt: NOW, windows: [] });
    expect(gate.held("db")).toBe(false);
    elapsed = 120_001;
    expect(gate.held("db")).toBe(true);
    expect(new MaintenanceGate().held("db")).toBe(true);
  });
  it("suppresses only the matching scope and expires without resetting the ordinary policy", () => {
    let elapsed = 0;
    const gate = new MaintenanceGate(
      () => NOW + elapsed,
      () => elapsed,
    );
    gate.apply({
      generation: 3,
      observedAt: NOW,
      windows: [{ containerName: "db", startsAt: NOW, expiresAt: NOW + 60_000 }],
    });
    expect(gate.held("db")).toBe(true);
    expect(gate.held("web")).toBe(false);
    expect(gate.held("")).toBe(true);
    elapsed = 60_000;
    expect(gate.held("db")).toBe(false);
    gate.apply({
      generation: 4,
      observedAt: NOW + elapsed,
      windows: [{ containerName: null, startsAt: NOW, expiresAt: NOW + 100_000 }],
    });
    expect(gate.held("web")).toBe(true);
    expect(() => gate.apply({ generation: 3, observedAt: NOW + elapsed, windows: [] })).toThrow();
    expect(gate.held("web")).toBe(true);
  });
  it("says how far off its clock is while that keeps the policy out, and nothing once the clocks agree", () => {
    let wall = NOW + 754_000;
    const gate = new MaintenanceGate(
      () => wall,
      () => 0,
    );
    expect(() => gate.apply({ generation: 1, observedAt: NOW, windows: [] })).toThrow();
    expect(gate.clockOffSeconds).toBe(754);
    expect(gate.held("db")).toBe(true);
    wall = NOW - 61_000;
    expect(() => gate.apply({ generation: 1, observedAt: NOW, windows: [] })).toThrow();
    expect(gate.clockOffSeconds).toBe(-61);

    // A minute off is still within what it allows.
    wall = NOW + 60_000;
    gate.apply({ generation: 1, observedAt: NOW, windows: [] });
    expect(gate.clockOffSeconds).toBeNull();
    expect(gate.held("db")).toBe(false);
    // An older policy is refused for that alone: nothing is said of the clock.
    expect(() => gate.apply({ generation: 0, observedAt: NOW, windows: [] })).toThrow();
    expect(gate.clockOffSeconds).toBeNull();
  });

  it("fails closed on clock changes and invalid or absent policy from older servers", () => {
    let wall = NOW;
    const gate = new MaintenanceGate(
      () => wall,
      () => 0,
    );
    gate.apply({ generation: 0, observedAt: NOW, windows: [] });
    wall -= 120_000;
    expect(gate.held("db")).toBe(true);
    expect(() => gate.apply(undefined)).toThrow();
    expect(() =>
      gate.apply({
        generation: 1,
        observedAt: wall,
        windows: [{ containerName: null, startsAt: wall, expiresAt: wall + 86_400_001 }],
      }),
    ).toThrow();
  });
});
