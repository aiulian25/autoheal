import { describe, expect, it } from "vitest";
import type { ContainerView } from "../../src/shared/api.js";
import { imageChecks } from "./image-checks.js";

const container = (update: Partial<ContainerView["update"]>) =>
  ({
    update: { status: "current", checkedAt: 1, policy: "ask", remote: null, reason: null, ...update },
  }) as ContainerView;

describe("what a host's last image checks know", () => {
  it("calls nothing up to date when nothing here is checked", () => {
    expect(imageChecks([]).allCurrent).toBe(false);
    expect(imageChecks([container({ policy: "off" })]).allCurrent).toBe(false);
  });
  it("calls nothing up to date while a newer version than one of them is out", () => {
    expect(imageChecks([container({}), container({ newerTag: "1.4.0" })]).allCurrent).toBe(false);
    expect(imageChecks([container({}), container({ newerTag: "1.4.0", ignored: "1.4.0" })]).allCurrent).toBe(true);
  });
  it("calls every image up to date when each was checked and found so, since its oldest check", () => {
    const checks = imageChecks([
      container({ checkedAt: 5 }),
      container({ checkedAt: 2 }),
      container({ policy: "off" }),
    ]);
    expect(checks).toEqual({ watched: 2, notChecked: 0, failed: 0, allCurrent: true, oldestCheckAt: 2 });
  });
});
