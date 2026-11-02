import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { IN_MEMORY_DATABASE } from "../../shared/constants.js";
import { AuditLog } from "../audit/audit-log.js";
import { DatabaseHandle } from "../database/connection.js";
import { auditEvents, recoveryCodes, sessions, users } from "../database/schema.js";
import { ensureFirstAdmin, resetAdmin } from "./bootstrap.js";
import { verifyPassword } from "./password-hashing.js";

const setup = () => {
  const stdout: string[] = [];
  const announcements: string[] = [];
  const handle = new DatabaseHandle(IN_MEMORY_DATABASE);
  const auditLog = new AuditLog(handle, (line) => stdout.push(line));
  return { handle, auditLog, stdout, announcements, announce: (message: string) => announcements.push(message) };
};

const passwordIn = (announcement: string) => /one-time password (\S+)/.exec(announcement)![1]!;
const createdAtOf = (handle: DatabaseHandle, username: string) =>
  handle.database.select().from(users).where(eq(users.username, username)).get()!.createdAt;
const GIVEN_TIME = Date.UTC(2030, 0, 2);

const databaseText = (handle: DatabaseHandle) =>
  JSON.stringify([handle.database.select().from(users).all(), handle.database.select().from(auditEvents).all()]);

describe("first-run admin", () => {
  it("creates one admin that must change its password, exactly once", async () => {
    const { handle, auditLog, announcements, announce } = setup();
    expect(await ensureFirstAdmin(handle, auditLog, "admin", announce)).toBe(true);
    expect(await ensureFirstAdmin(handle, auditLog, "admin", announce)).toBe(false);
    const all = handle.database.select().from(users).all();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ username: "admin", role: "admin", status: "active", mustChangePassword: true });
    expect(announcements).toHaveLength(1);
  });

  it("shows the password once and stores it nowhere", async () => {
    const { handle, auditLog, stdout, announcements, announce } = setup();
    await ensureFirstAdmin(handle, auditLog, "admin", announce);
    const password = passwordIn(announcements[0]!);
    expect(password.length).toBeGreaterThanOrEqual(24);
    expect(databaseText(handle)).not.toContain(password);
    expect(stdout.join("")).not.toContain(password);
    const { passwordHash } = handle.database.select().from(users).get()!;
    expect(await verifyPassword(passwordHash, password)).toBe(true);
    expect(handle.database.select().from(auditEvents).get()).toMatchObject({ action: "user.admin_bootstrapped" });
  });

  it("dates the admin by the clock it is given", async () => {
    const { handle, auditLog, announce } = setup();
    await ensureFirstAdmin(handle, auditLog, "admin", announce, () => GIVEN_TIME);
    expect(createdAtOf(handle, "admin")).toBe(GIVEN_TIME);
  });
});

describe("reset-admin", () => {
  it("dates an account it creates by the clock it is given", async () => {
    const { handle, auditLog, announce } = setup();
    await resetAdmin(handle, auditLog, "rescue", announce, () => GIVEN_TIME);
    expect(createdAtOf(handle, "rescue")).toBe(GIVEN_TIME);
  });

  it("gives a locked-out admin a new one-time password, clears TOTP and ends sessions", async () => {
    const { handle, auditLog, announcements, announce } = setup();
    await ensureFirstAdmin(handle, auditLog, "admin", announce);
    const admin = handle.database.select().from(users).get()!;
    handle.database
      .update(users)
      .set({ status: "deactivated", role: "viewer", mustChangePassword: false, totpEnabled: true, totpSecret: "S" })
      .where(eq(users.id, admin.id))
      .run();
    const now = Date.now();
    handle.database
      .insert(sessions)
      .values({ tokenHash: "t", userId: admin.id, csrfToken: "c", createdAt: now, lastSeenAt: now, expiresAt: now + 1 })
      .run();
    handle.database.insert(recoveryCodes).values({ id: "r", userId: admin.id, codeHash: "h" }).run();

    await resetAdmin(handle, auditLog, "admin", announce);

    const reset = handle.database.select().from(users).get()!;
    expect(reset).toMatchObject({
      role: "admin",
      status: "active",
      mustChangePassword: true,
      totpEnabled: false,
      totpSecret: null,
    });
    expect(await verifyPassword(reset.passwordHash, passwordIn(announcements[1]!))).toBe(true);
    expect(handle.database.select().from(sessions).all()).toHaveLength(0);
    expect(handle.database.select().from(recoveryCodes).all()).toHaveLength(0);
    expect(
      handle.database
        .select()
        .from(auditEvents)
        .all()
        .map((event) => event.action),
    ).toContain("user.admin_reset");
  });

  it("creates the account when it does not exist", async () => {
    const { handle, auditLog, announce } = setup();
    await resetAdmin(handle, auditLog, "rescue", announce);
    expect(handle.database.select().from(users).get()).toMatchObject({ username: "rescue", role: "admin" });
  });
});
