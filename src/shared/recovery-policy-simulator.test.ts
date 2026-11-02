import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MAX_RESTARTS_PER_WINDOW, RESTART_WINDOW_SECONDS } from "./constants.js";
import { RemedyGuard } from "../runner/remedy-guard.js";
import { MaintenanceGate } from "../runner/maintenance.js";
import type { GuardState } from "../runner/guard-state.js";
import {
  emptyRecoveryState,
  maintenanceGuardReason,
  recoveryGuardTransition,
  simulateRecovery,
  type RecoveryGuardFlags,
  type RecoveryGuardState,
  type RecoveryScenario,
} from "./recovery-policy-simulator.js";

const NOW = Date.UTC(2026, 9, 27);
const scenario = (overrides: Partial<RecoveryScenario> = {}): RecoveryScenario => ({
  startedAt: NOW,
  restartDefault: "restart",
  containers: { app: "restart" },
  protectedContainers: [],
  dryRun: false,
  maintenance: [],
  groups: [],
  initial: [],
  events: [{ at: NOW, name: "app", kind: "failure" }],
  ...overrides,
});
const failure = (seconds: number) => ({ at: NOW + seconds * 1000, name: "app", kind: "failure" as const });

describe("shared recovery guard transition", () => {
  it("matches actual guard claim/credit state updates across bounded generated safety states", () => {
    let seed = 12345;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (const phase of ["claim", "restart"] as const)
      for (let run = 0; run < 100; run++) {
        const now = 10_000;
        const initial: RecoveryGuardState = {
          lastKill: random() > 0.5 ? now - Math.floor(random() * 100) : null,
          lastHandled: random() > 0.5 ? now - Math.floor(random() * 1200) : null,
          restartTimes: Array.from({ length: Math.floor(random() * 4) }, () => now - Math.floor(random() * 7200)),
        };
        const flags: RecoveryGuardFlags = {
          name: random() > 0.05 ? "app" : "",
          now,
          safetyBlocked: random() < 0.1,
          protected: random() < 0.1,
          held: random() < 0.1,
          maintenance: random() < 0.1,
        };
        const state = {
          clock: () => now,
          lastKill: new Map(initial.lastKill === null ? [] : [[flags.name, initial.lastKill]]),
          lastHandled: new Map(initial.lastHandled === null ? [] : [[flags.name, initial.lastHandled]]),
          restartTimes: new Map([[flags.name, [...initial.restartTimes]]]),
          blocked: () => flags.safetyBlocked,
          changed: vi.fn(),
        };
        const guard = new RemedyGuard(
          new Set(flags.protected ? [flags.name] : []),
          undefined,
          null,
          state as unknown as GuardState,
        );
        guard.maintenanceHeld = () => flags.maintenance;
        if (flags.held) guard.hold(flags.name);
        const frozen = Object.freeze({ ...initial, restartTimes: Object.freeze([...initial.restartTimes]) });
        const result = recoveryGuardTransition(phase, frozen, flags);
        expect(phase === "claim" ? guard.claim(flags.name) : guard.takeRestart(flags.name)).toBe(result.allowed);
        expect({
          lastKill: state.lastKill.get(flags.name) ?? null,
          lastHandled: state.lastHandled.get(flags.name) ?? null,
          restartTimes: state.restartTimes.get(flags.name) ?? [],
        }).toEqual(result.state);
        expect(state.changed).toHaveBeenCalledTimes(result.allowed ? 1 : 0);
      }
  });
  it("uses the runner's exact maintenance expiry, freshness and clock-change boundaries", () => {
    const policy = {
      generation: 1,
      observedAt: NOW,
      windows: [{ containerName: "app", startsAt: NOW, expiresAt: NOW + 60_000 }],
    };
    for (const elapsed of [-1, 0, 59_999, 60_000, 120_000, 120_001])
      for (const drift of [0, 60_000, 60_001, -120_000]) {
        let tick = 0;
        let wall = NOW;
        const guard = new MaintenanceGate(
          () => wall,
          () => tick,
        );
        guard.apply(policy);
        tick = elapsed;
        wall = NOW + elapsed + drift;
        expect(guard.held("app")).toBe(maintenanceGuardReason(policy, true, elapsed, drift, "app") !== null);
      }
  });
});

describe("deterministic policy rehearsal", () => {
  it("explains cooldowns and two hourly restart credits, then permits expired credits", () => {
    const input = scenario({ events: [failure(0), failure(61), failure(600), failure(1200), failure(3600)] });
    const first = simulateRecovery(input);
    expect(first).toEqual(simulateRecovery(input));
    expect(first.decisions.map(({ result, reason }) => [result, reason])).toEqual([
      ["restart", "allowed"],
      ["wait", "cooldown"],
      ["restart", "allowed"],
      ["escalate", "restart-budget"],
      ["restart", "allowed"],
    ]);
    expect(first.states[0]?.restartTimes).toHaveLength(MAX_RESTARTS_PER_WINDOW);
  });
  it("reserves credits in reached dry-run stages, and preserves suppression/ask/tell policies", () => {
    const run = simulateRecovery(scenario({ dryRun: true, events: [failure(0), failure(600), failure(1200)] }));
    expect(run.decisions.map(({ result }) => result)).toEqual(["would-restart", "would-restart", "escalate"]);
    expect(run.states[0]?.restartTimes).toHaveLength(2);
    expect(simulateRecovery(scenario({ containers: { app: "ask" } })).decisions[0]?.reason).toBe("policy-ask");
    expect(simulateRecovery(scenario({ containers: { app: "tell" } })).decisions[0]?.reason).toBe("policy-tell");
    expect(simulateRecovery(scenario({ containers: { app: "ignore" } })).decisions[0]?.reason).toBe("policy-ignore");
    expect(simulateRecovery(scenario({ protectedContainers: ["app"] })).decisions[0]?.reason).toBe("protected");
  });
  it("expires maintenance without claiming or consuming credits inside its window", () => {
    const run = simulateRecovery(
      scenario({
        maintenance: [{ containerName: null, startsAt: NOW, expiresAt: NOW + 60_000 }],
        events: [failure(0), failure(60)],
      }),
    );
    expect(run.decisions.map(({ reason }) => reason)).toEqual(["maintenance", "allowed"]);
    expect(run.states[0]?.restartTimes).toEqual([(NOW + 60_000) / 1000]);
  });
  it("models group operation holds and deliberate-stop suppression before recovery resumes", () => {
    const run = simulateRecovery(
      scenario({
        groups: [["provider", "app"]],
        events: [
          { at: NOW, name: "provider", kind: "operation-start" },
          failure(10),
          { at: NOW + 100_000, name: "provider", kind: "operation-end" },
          failure(120),
          failure(160),
        ],
      }),
    );
    expect(run.decisions.filter(({ event }) => event === "failure").map(({ reason }) => reason)).toEqual([
      "operation-held",
      "deliberate-stop",
      "allowed",
    ]);
  });
  it("preserves credits across runner restarts and pauses for stale policy, missing state or changed clocks", () => {
    const run = simulateRecovery(
      scenario({
        initial: [{ name: "app", ...emptyRecoveryState(), restartTimes: [NOW / 1000, NOW / 1000] }],
        events: [
          { at: NOW, kind: "runner-restart", statePreserved: true },
          failure(1),
          { at: NOW + 2000, kind: "online" },
          failure(3),
        ],
      }),
    );
    expect(run.decisions.filter(({ event }) => event === "failure").map(({ reason }) => reason)).toEqual([
      "policy-unavailable",
      "restart-budget",
    ]);
    const missing = simulateRecovery(
      scenario({
        events: [
          { at: NOW, kind: "runner-restart", statePreserved: false },
          { at: NOW + 1000, kind: "online" },
          failure(2),
          failure(RESTART_WINDOW_SECONDS),
        ],
      }),
    );
    expect(missing.decisions.filter(({ event }) => event === "failure").map(({ reason }) => reason)).toEqual([
      "safety-state",
      "allowed",
    ]);
    const offline = simulateRecovery(
      scenario({
        events: [{ at: NOW, kind: "offline" }, failure(121), { at: NOW + 122_000, kind: "online" }, failure(123)],
      }),
    );
    expect(offline.decisions.filter(({ event }) => event === "failure").map(({ reason }) => reason)).toEqual([
      "policy-unavailable",
      "allowed",
    ]);
    const skew = simulateRecovery(
      scenario({ events: [{ at: NOW, kind: "clock-change", offsetMilliseconds: -120_000 }, failure(601)] }),
    );
    expect(skew.decisions.at(-1)?.reason).toBe("policy-unavailable");
  });
  it("bounds event count/time span and has no mutation transport import", () => {
    expect(() => simulateRecovery(scenario({ events: Array.from({ length: 501 }, () => failure(0)) }))).toThrow();
    expect(() => simulateRecovery(scenario({ events: [failure(8 * 86_400)] }))).toThrow();
    const source = readFileSync(new URL("./recovery-policy-simulator.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*(?:runner|docker|ollama|control-plane|node:)/);
  });
});
