import { describe, expect, it } from "vitest";
import { INVENTORY_REPORT_DELAY_MILLISECONDS, INVENTORY_REPORT_LATEST_MILLISECONDS } from "../shared/constants.js";
import { reportDelay } from "./application.js";

describe("when a runner reports what changed", () => {
  it("waits for Docker to be quiet a moment, and never long past the first change", () => {
    expect(reportDelay(1_000, 1_000)).toBe(INVENTORY_REPORT_DELAY_MILLISECONDS);
    // A burst that goes on: each change waits again, until the latest the first one allows.
    expect(reportDelay(1_000, 2_800)).toBe(INVENTORY_REPORT_LATEST_MILLISECONDS - 1_800);
    expect(reportDelay(1_000, 1_000 + INVENTORY_REPORT_LATEST_MILLISECONDS + 5)).toBe(0);
  });
});
