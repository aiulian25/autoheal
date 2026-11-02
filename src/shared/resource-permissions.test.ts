import { describe, expect, it } from "vitest";
import { JOB_ACTION } from "./constants.js";
import {
  actionPermission,
  RESOURCE_ACTIONS,
  resourceAllowed,
  resourceGrantsSchema,
  type ResourceGrant,
} from "./resource-permissions.js";
const HOST = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const target = { hostId: HOST, name: "db", composeProject: "documents" };
const grant = (change: Partial<ResourceGrant> = {}): ResourceGrant => ({
  hostId: HOST,
  scope: "container",
  resource: "db",
  actions: ["lifecycle"],
  ...change,
});
describe("scoped operator permission contract", () => {
  it.each(RESOURCE_ACTIONS)("denies absent %s capability and requires exact host/resource scope", (action) => {
    expect(resourceAllowed([], action, target)).toBe(false);
    const grants = [grant({ actions: [action] })];
    expect(resourceAllowed(grants, action, target)).toBe(true);
    expect(resourceAllowed(grants, action, { ...target, name: "db-copy" })).toBe(false);
    expect(resourceAllowed(grants, action, { ...target, hostId: OTHER })).toBe(false);
    expect(resourceAllowed([grant({ resource: "*", actions: [action] })], action, target)).toBe(false);
  });
  it("matches host-wide and exact stack scopes without treating unknown projects as a stack", () => {
    expect(resourceAllowed([grant({ scope: "host", resource: null })], "lifecycle", { ...target, name: "web" })).toBe(
      true,
    );
    const stack = [grant({ scope: "stack", resource: "documents" })];
    expect(resourceAllowed(stack, "lifecycle", target)).toBe(true);
    expect(resourceAllowed(stack, "lifecycle", { ...target, composeProject: null })).toBe(false);
    expect(resourceAllowed(stack, "lifecycle", { ...target, composeProject: "documents-copy" })).toBe(false);
    expect(resourceAllowed(stack, "update", target)).toBe(false);
  });
  it("rejects ambiguous, duplicate and unbounded grants", () => {
    expect(resourceGrantsSchema.safeParse([grant()]).success).toBe(true);
    for (const grants of [
      [grant(), grant()],
      [grant({ scope: "host" })],
      [grant({ resource: null })],
      [grant({ actions: ["update", "update"] })],
      Array.from({ length: 65 }, (_, index) => grant({ resource: `app-${index}` })),
    ]) {
      expect(resourceGrantsSchema.safeParse(grants).success).toBe(false);
    }
  });
  it.each([JOB_ACTION.pruneImages, JOB_ACTION.removeImages, JOB_ACTION.reboot, JOB_ACTION.upgradePackages, "unknown"])(
    "keeps %s outside delegated container capabilities",
    (action) => expect(actionPermission(action)).toBeNull(),
  );
  it("maps each delegated action to its explicit capability", () => {
    expect(actionPermission(JOB_ACTION.update)).toBe("update");
    expect(actionPermission(JOB_ACTION.rollBack)).toBe("update");
    expect(actionPermission(JOB_ACTION.edit)).toBe("settings");
    expect(actionPermission(JOB_ACTION.logs)).toBe("logs");
    expect(actionPermission(JOB_ACTION.checkUpdates)).toBe("read");
    expect(actionPermission(JOB_ACTION.restart)).toBe("lifecycle");
  });
});
