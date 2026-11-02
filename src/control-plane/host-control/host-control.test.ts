import { describe, expect, it } from "vitest";
import { cleansOn, controlOf, isDatabaseImage, nextCleanupAt, policyOf } from "./host-control.js";

const WINDOW = { securityInWindow: true, windowStart: "03:00", windowEnd: "05:00" };
const LONDON = "Europe/Lisbon";
// Thursday 22 October 2026, 13:00 in London; the clocks go back on Sunday the 25th.
const THURSDAY = Date.UTC(2026, 9, 22, 12, 0);
const SUNDAY_OPENS = Date.UTC(2026, 9, 25, 3, 0);
const FIRST_OF_NOVEMBER_OPENS = Date.UTC(2026, 10, 1, 3, 0);
const DAY = 24 * 60 * 60 * 1000;

// A host's two defaults: when a container dies, and when a new image is out.
const ASK = { restart: "ask", update: "ask" } as const;
const RESTART = { restart: "restart", update: "ask" } as const;
const BOTH = { restart: "restart", update: "apply" } as const;

describe("what a container may have Autoheal do on its own", () => {
  const app = { name: "attic", image: "ghcr.io/lmmendes/attic:2.7.0", updatePolicy: null };

  it("takes its host's default until someone answers for it, and then that answer", () => {
    expect(controlOf(app, false, undefined, ASK)).toEqual({
      restart: "ask",
      update: "ask",
      restartLock: null,
      updateLock: null,
    });
    expect(controlOf(app, false, undefined, RESTART)).toMatchObject({ restart: "restart", update: "ask" });
    expect(controlOf(app, false, undefined, BOTH)).toMatchObject({ restart: "restart", update: "apply" });
    expect(controlOf(app, false, { restart: "ask", update: "apply" }, RESTART)).toMatchObject({
      restart: "ask",
      update: "apply",
    });
  });

  it("answers its host's two questions apart: asking first when one dies, yet applying a safe new image", () => {
    expect(controlOf(app, false, undefined, { restart: "ask", update: "apply" })).toMatchObject({
      restart: "ask",
      update: "apply",
    });
  });

  it("only tells, or never updates, when its host or its own answer says so", () => {
    const quiet = { restart: "tell", update: "never" } as const;
    expect(controlOf(app, false, undefined, quiet)).toMatchObject({ restart: "tell", update: "never" });
    expect(policyOf(controlOf(app, false, undefined, quiet))).toBe("off");
    expect(controlOf(app, false, { restart: "restart", update: "ask" }, quiet)).toMatchObject({
      restart: "restart",
      update: "ask",
    });
    expect(controlOf(app, false, { restart: "tell", update: "never" }, BOTH)).toMatchObject({
      restart: "tell",
      update: "never",
    });
  });

  it("reads a label's auto or ask until someone answers for it", () => {
    expect(controlOf({ ...app, updatePolicy: "auto" }, false, undefined, ASK).update).toBe("apply");
    expect(controlOf({ ...app, updatePolicy: "ask" }, false, undefined, BOTH).update).toBe("ask");
    expect(controlOf({ ...app, updatePolicy: "auto" }, false, { restart: "restart", update: "ask" }, ASK).update).toBe(
      "ask",
    );
  });

  it("locks what the host's .env, a label or the database rule fixes", () => {
    const everything = { restart: "restart", update: "apply" } as const;
    expect(controlOf(app, true, everything, BOTH)).toEqual({
      restart: "ask",
      update: "ask",
      restartLock: "protected",
      updateLock: "protected",
    });
    const offByLabel = controlOf({ ...app, updatePolicy: "off" }, false, everything, BOTH);
    expect(offByLabel).toMatchObject({ restart: "restart", update: "ask", updateLock: "labelled_off" });
    expect(policyOf(offByLabel)).toBe("off");
    const database = controlOf({ name: "attic-postgres", image: "postgres:16-alpine" }, false, everything, BOTH);
    expect(database).toMatchObject({ restart: "restart", update: "ask", updateLock: "database" });
    expect(policyOf(database)).toBe("ask");
  });

  it("fixes both answers of the old container an update keeps aside, and never updates it", () => {
    const parked = { ...app, name: "attic-autoheal-old", updatePolicy: "auto" as const };
    const control = controlOf(parked, false, { restart: "restart", update: "apply" }, BOTH);

    expect(control).toEqual({ restart: "ask", update: "ask", restartLock: "parked", updateLock: "parked" });
    expect(policyOf(control)).toBe("off");
  });

  it("gives the update rules auto only for a container Autoheal may update on its own", () => {
    expect(policyOf(controlOf(app, false, { restart: "ask", update: "apply" }, ASK))).toBe("auto");
    expect(policyOf(controlOf(app, false, undefined, ASK))).toBe("ask");
  });

  it.each([
    ["postgres:16-alpine", true],
    ["ghcr.io/immich-app/postgres:14", true],
    ["bitnami/postgresql:16", true],
    ["redis:7-alpine", true],
    ["registry.lan:5000/mariadb@sha256:0123", true],
    ["valkey/valkey:8", true],
    ["nginx:latest", false],
    ["ghcr.io/lmmendes/attic:2.7.0", false],
  ])("knows %s as a database's image: %s", (image, database) => {
    expect(isDatabaseImage(image)).toBe(database);
  });
});

describe("when unused images are removed", () => {
  const sunday = { year: 2026, month: 10, day: 25 };

  it("cleans only on a Sunday, the first of the month for monthly, and once in its period", () => {
    expect(cleansOn("weekly", sunday, SUNDAY_OPENS, null)).toBe(true);
    expect(cleansOn("weekly", { year: 2026, month: 10, day: 24 }, SUNDAY_OPENS, null)).toBe(false);
    expect(cleansOn("off", sunday, SUNDAY_OPENS, null)).toBe(false);
    expect(cleansOn("monthly", sunday, SUNDAY_OPENS, null)).toBe(false);
    expect(cleansOn("monthly", { year: 2026, month: 11, day: 1 }, FIRST_OF_NOVEMBER_OPENS, null)).toBe(true);
    expect(cleansOn("weekly", sunday, SUNDAY_OPENS, SUNDAY_OPENS - 7 * DAY)).toBe(true);
    expect(cleansOn("fortnightly", sunday, SUNDAY_OPENS, SUNDAY_OPENS - 7 * DAY)).toBe(false);
  });

  it("opens next in the host's window, on its own clock across the change to winter time", () => {
    expect(nextCleanupAt("weekly", null, LONDON, WINDOW, THURSDAY)).toBe(SUNDAY_OPENS);
    expect(nextCleanupAt("monthly", null, LONDON, WINDOW, THURSDAY)).toBe(FIRST_OF_NOVEMBER_OPENS);
    expect(nextCleanupAt("fortnightly", SUNDAY_OPENS - 7 * DAY, LONDON, WINDOW, THURSDAY)).toBe(
      FIRST_OF_NOVEMBER_OPENS,
    );
    expect(nextCleanupAt("off", null, LONDON, WINDOW, THURSDAY)).toBeNull();
  });

  it("is now while its window is open and nothing ran yet, and next week once it has", () => {
    const duringWindow = SUNDAY_OPENS + 30 * 60 * 1000;
    expect(nextCleanupAt("weekly", null, LONDON, WINDOW, duringWindow)).toBe(duringWindow);
    expect(nextCleanupAt("weekly", SUNDAY_OPENS, LONDON, WINDOW, duringWindow)).toBe(FIRST_OF_NOVEMBER_OPENS);
  });
});
