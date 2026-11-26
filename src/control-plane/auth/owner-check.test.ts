import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_ERRORS } from "../../shared/api.js";
import { IN_MEMORY_DATABASE, ROLE_VIEWER, USER_STATUS_DEACTIVATED } from "../../shared/constants.js";
import { AuditLog } from "../audit/audit-log.js";
import { DatabaseHandle } from "../database/connection.js";
import { users } from "../database/schema.js";
import { ensureFirstAdmin } from "./bootstrap.js";
import { OwnerCheck } from "./owner-check.js";

describe("the owner, as far along as acting on a host needs", () => {
  let handle: DatabaseHandle;
  let owner: string;
  let check: OwnerCheck;
  const change = (values: Partial<typeof users.$inferInsert>) =>
    handle.database.update(users).set(values).where(eq(users.id, owner)).run();

  beforeEach(async () => {
    handle = new DatabaseHandle(IN_MEMORY_DATABASE);
    await ensureFirstAdmin(handle, new AuditLog(handle, () => undefined), "alex", () => undefined);
    owner = handle.database.select({ id: users.id }).from(users).get()!.id;
    // Set up as signing in leaves them: their own password, and an authenticator.
    change({ mustChangePassword: false, totpEnabled: true });
    check = new OwnerCheck(handle);
  });
  afterEach(() => handle.close());

  it("is the active admin with their own password and an authenticator", () => {
    expect(check.is(owner)).toBe(true);
    expect(() => check.require(owner)).not.toThrow();
  });

  it.each([
    ["still on the password they were given", { mustChangePassword: true }],
    ["without an authenticator", { totpEnabled: false }],
    ["kept from signing in", { status: USER_STATUS_DEACTIVATED }],
    ["not an admin", { role: ROLE_VIEWER }],
  ] as const)("is nobody %s", (_case, values) => {
    change(values);
    expect(check.is(owner)).toBe(false);
    expect(() => check.require(owner)).toThrow(expect.objectContaining({ code: API_ERRORS.resourceForbidden }));
  });

  it("is nobody who is not there", () => {
    expect(check.is("someone-else")).toBe(false);
    expect(() => check.require("someone-else")).toThrow(
      expect.objectContaining({ code: API_ERRORS.resourceForbidden }),
    );
  });
});
