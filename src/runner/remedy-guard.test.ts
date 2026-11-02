import { guardStateFixture } from "../../test/support/guard-state.js";
import { GuardState } from "./guard-state.js";
import { OperationJournal } from "./operation-journal.js";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DELIBERATE_STOP_WINDOW_SECONDS,
  HANDLE_COOLDOWN_SECONDS,
  MAX_RESTARTS_PER_WINDOW,
  RESTART_WINDOW_SECONDS,
} from "../shared/constants.js";
import { RemedyGuard } from "./remedy-guard.js";

describe("RemedyGuard", () => {
  it("does not claim or spend restart credits during maintenance; ordinary policy resumes after expiry", () => {
    const guard = new RemedyGuard(new Set());
    let held = true;
    guard.maintenanceHeld = (name) => name === "db" && held;
    expect(guard.claim("db")).toBe(false);
    expect(guard.takeRestart("db")).toBe(false);
    expect(guard.claim("other")).toBe(true);
    held = false;
    expect(guard.claim("db")).toBe(true);
    expect(guard.takeRestart("db")).toBe(true);
  });
  it("reloads persistent recovery blocks in a reconstructed guard", async () => {
    const volumes = new Map<string, { Name: string; Labels: Record<string, string> }>();
    const store = {
      volumes: async () => [...volumes.values()],
      createVolume: async (name: string, labels: Record<string, string>) => {
        volumes.set(name, { Name: name, Labels: labels });
      },
      removeVolume: async (name: string) => {
        volumes.delete(name);
      },
    };
    await new OperationJournal(store).begin(
      "app",
      [{ name: "app", id: "original", replacementId: "replacement", running: true, restore: true }],
      null,
    );
    const guard = new RemedyGuard(new Set(), undefined, new OperationJournal(store));
    expect(await guard.rollbackOf("app")).toMatchObject({ phase: "prepared" });
    expect(await guard.rollbackOf("alias", "original")).toMatchObject({ owner: "app" });
    expect(await guard.rollbackOf("replacement")).toMatchObject({ owner: "app" });
  });

  it("retains a container hold until every owner releases it", () => {
    const guard = new RemedyGuard(new Set());
    guard.hold("dependent");
    guard.hold("dependent");
    guard.release("dependent");
    expect(guard.isHeld("dependent")).toBe(true);
    guard.release("dependent");
    expect(guard.isHeld("dependent")).toBe(false);
  });
  let now: number;
  let guard: RemedyGuard;

  beforeEach(() => {
    now = 1_000;
    guard = new RemedyGuard(new Set(["beszel"]), () => now);
  });

  it("claims once per cooldown", () => {
    expect(guard.claim("paperless")).toBe(true);
    expect(guard.claim("paperless")).toBe(false);
    now += HANDLE_COOLDOWN_SECONDS;
    expect(guard.claim("paperless")).toBe(true);
  });

  it("keeps healing away from a container while a person's action works on it, however long", () => {
    guard.hold("immich");
    now += 10 * DELIBERATE_STOP_WINDOW_SECONDS;
    expect(guard.claim("immich")).toBe(false);
    guard.release("immich");
    // What the action stopped on purpose still counts as deliberate for a while.
    expect(guard.claim("immich")).toBe(false);
    now += DELIBERATE_STOP_WINDOW_SECONDS;
    expect(guard.claim("immich")).toBe(true);
  });

  it("keeps healing away from the whole host while package runs go on, until the last one ends", () => {
    guard.holdHost();
    guard.holdHost();
    expect(guard.claim("paperless")).toBe(false);
    expect(guard.isHeld("tika")).toBe(true);

    guard.releaseHost();
    expect(guard.claim("paperless")).toBe(false);

    guard.releaseHost();
    guard.releaseHost();
    expect(guard.claim("paperless")).toBe(true);
  });

  it("ignores protected and deliberately stopped containers", () => {
    expect(guard.claim("beszel")).toBe(false);
    guard.noteKill("tika");
    expect(guard.claim("tika")).toBe(false);
    now += DELIBERATE_STOP_WINDOW_SECONDS;
    expect(guard.claim("tika")).toBe(true);
  });

  it("keeps an hourly restart budget per container", () => {
    for (let restart = 0; restart < MAX_RESTARTS_PER_WINDOW; restart += 1) {
      expect(guard.takeRestart("tika")).toBe(true);
    }
    expect(guard.takeRestart("tika")).toBe(false);
    expect(guard.takeRestart("paperless")).toBe(true);
    now += RESTART_WINDOW_SECONDS;
    expect(guard.takeRestart("tika")).toBe(true);
  });

  it("says when used-up restarts free again and when its wait ends, on the wall clock", () => {
    // The wall clock in step with the guard's own: 1_000 on the guard's is START on the wall.
    const START = 1_700_000_000_000;
    const wall = () => START + (now - 1_000) * 1_000;
    guard.claim("tika");
    guard.takeRestart("tika");
    now += HANDLE_COOLDOWN_SECONDS + 100;
    guard.claim("tika");
    guard.takeRestart("tika");
    // The first restart leaves the hour first; the wait runs from the last failure it handled.
    expect(guard.restartWait(wall())).toEqual({
      tika: { againAt: START + RESTART_WINDOW_SECONDS * 1_000, looksAgainAt: wall() + HANDLE_COOLDOWN_SECONDS * 1_000 },
    });
    now += HANDLE_COOLDOWN_SECONDS;
    expect(guard.restartWait(wall())).toEqual({
      tika: { againAt: START + RESTART_WINDOW_SECONDS * 1_000, looksAgainAt: null },
    });
    now += RESTART_WINDOW_SECONDS;
    expect(guard.restartWait(wall())).toEqual({});
  });

  it("restarts a third time at once after an admin's reset, and keeps counting what comes after it", () => {
    const START = 1_700_000_000_000;
    const wall = () => START + (now - 1_000) * 1_000;
    for (let restart = 0; restart < MAX_RESTARTS_PER_WINDOW; restart += 1) {
      expect(guard.claim("tika")).toBe(true);
      expect(guard.takeRestart("tika")).toBe(true);
      now += HANDLE_COOLDOWN_SECONDS;
    }
    // Its next failure finds its restarts used up: it goes to a person.
    expect(guard.claim("tika")).toBe(true);
    expect(guard.takeRestart("tika")).toBe(false);
    now += 1;
    const askedAt = wall();
    expect(guard.resetRestarts({ tika: askedAt }, wall())).toBe(true);
    now += 1;
    expect(guard.claim("tika")).toBe(true);
    expect(guard.takeRestart("tika")).toBe(true);
    // The same reset heard again, with a later answer, leaves the restart taken after it.
    now += 5;
    expect(guard.resetRestarts({ tika: askedAt }, wall())).toBe(false);
    expect(guard.restartsUsed()).toEqual({ tika: 1 });
    expect(guard.resetRestarts(undefined, wall())).toBe(false);
  });

  it("does not re-trigger on its own restart", () => {
    guard.takeRestart("tika");
    expect(guard.claim("tika")).toBe(false);
  });

  it("tells a stop someone asked for, after a moment, from a container failing on its own", () => {
    guard.takeRestart("tika");
    const restarted = guard.now();
    expect(guard.stoppedOnPurposeSince("tika", restarted)).toBe(false);

    now += 1;
    guard.noteKill("tika");
    expect(guard.stoppedOnPurposeSince("tika", restarted)).toBe(true);
    // A kill before that moment says nothing about what happened since.
    expect(guard.stoppedOnPurposeSince("tika", guard.now())).toBe(false);

    guard.hold("paperless");
    expect(guard.stoppedOnPurposeSince("paperless", guard.now())).toBe(true);
    guard.holdHost();
    expect(guard.stoppedOnPurposeSince("immich", guard.now())).toBe(true);
  });
});

it("retains spent credits when the runner guard is reconstructed within the hour", async () => {
  const fixture = guardStateFixture();
  const state = await GuardState.open(fixture.store, fixture.timing);
  fixture.advance(RESTART_WINDOW_SECONDS);
  const before = new RemedyGuard(new Set(), undefined, null, state);
  expect(before.takeRestart("synthetic-app")).toBe(true);
  expect(before.takeRestart("synthetic-app")).toBe(true);
  await before.persisted();
  fixture.restart();
  const restored = await GuardState.open(fixture.store, fixture.timing);
  const after = new RemedyGuard(new Set(), undefined, null, restored);
  expect(after.takeRestart("synthetic-app")).toBe(false);
  expect(after.restartsUsed()).toEqual({ "synthetic-app": MAX_RESTARTS_PER_WINDOW });
});
