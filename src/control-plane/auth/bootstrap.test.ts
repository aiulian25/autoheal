import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { addLegacyPeople } from "../../../test/support/legacy-people.js";
import { IN_MEMORY_DATABASE, SINGLE_OWNER_MESSAGES } from "../../shared/constants.js";
import { AuditLog } from "../audit/audit-log.js";
import { DatabaseHandle } from "../database/connection.js";
import { auditEvents, recoveryCodes, sessions, users } from "../database/schema.js";
import { ensureFirstAdmin, refusalOf, resetOwner } from "./bootstrap.js";
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

  it("makes one person when two start at once", async () => {
    const { handle, auditLog, announcements, announce } = setup();
    const made = await Promise.all([
      ensureFirstAdmin(handle, auditLog, "admin", announce),
      ensureFirstAdmin(handle, auditLog, "admin", announce),
    ]);
    expect(made.sort()).toEqual([false, true]);
    expect(handle.database.select().from(users).all()).toHaveLength(1);
    expect(announcements).toHaveLength(1);
  });

  it("dates the admin by the clock it is given", async () => {
    const { handle, auditLog, announce } = setup();
    await ensureFirstAdmin(handle, auditLog, "admin", announce, () => GIVEN_TIME);
    expect(createdAtOf(handle, "admin")).toBe(GIVEN_TIME);
  });
});

describe("reset-admin", () => {
  const usernamesOf = (handle: DatabaseHandle) =>
    handle.database
      .select({ username: users.username, status: users.status })
      .from(users)
      .all()
      .sort((one, other) => one.username.localeCompare(other.username));

  it("sets up the first person on a database with nobody in it, dated by the clock it is given", async () => {
    const { handle, auditLog, announce } = setup();
    expect(await resetOwner(handle, auditLog, undefined, announce, () => GIVEN_TIME)).toEqual({
      kind: "reset",
      username: "admin",
    });
    expect(createdAtOf(handle, "admin")).toBe(GIVEN_TIME);
  });

  it("gives its locked-out owner a new one-time password, clears TOTP and ends their sessions and codes", async () => {
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

    expect(await resetOwner(handle, auditLog, undefined, announce)).toEqual({ kind: "reset", username: "admin" });

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

  it("follows its owner under a new name, and makes nobody else: another name is refused and nothing changes", async () => {
    const { handle, auditLog, announcements, announce } = setup();
    await ensureFirstAdmin(handle, auditLog, "admin", announce);
    handle.database.update(users).set({ username: "alex" }).run();
    const before = JSON.stringify(handle.database.select().from(users).all());

    expect(await resetOwner(handle, auditLog, "rescue", announce)).toEqual({ kind: "not_owner", owner: "alex" });
    expect(await resetOwner(handle, auditLog, "admin", announce)).toEqual({ kind: "not_owner", owner: "alex" });
    expect(JSON.stringify(handle.database.select().from(users).all())).toBe(before);
    expect(announcements).toHaveLength(1);

    expect(await resetOwner(handle, auditLog, "alex", announce)).toEqual({ kind: "reset", username: "alex" });
    expect(usernamesOf(handle)).toEqual([{ username: "alex", status: "active" }]);
  });

  it("where it cannot tell whose it is, lets the host choose, and only that one signs in after", async () => {
    const { handle, auditLog, announce } = setup();
    await ensureFirstAdmin(handle, auditLog, "admin", announce);
    handle.database.update(users).set({ status: "deactivated" }).run();
    await addLegacyPeople(handle, [
      { username: "cedar", role: "admin" },
      { username: "rowan", role: "admin" },
    ]);

    expect(await resetOwner(handle, auditLog, undefined, announce)).toEqual({ kind: "choose" });
    expect(await resetOwner(handle, auditLog, "oak", announce)).toEqual({ kind: "unknown", username: "oak" });
    expect(await resetOwner(handle, auditLog, "rowan", announce)).toEqual({ kind: "reset", username: "rowan" });
    expect(usernamesOf(handle)).toEqual([
      { username: "admin", status: "deactivated" },
      { username: "cedar", status: "deactivated" },
      { username: "rowan", status: "active" },
    ]);
  });

  it("with no admin active, resets the one it was set up with, or the one named on the host", async () => {
    const { handle, auditLog, announce } = setup();
    await ensureFirstAdmin(handle, auditLog, "admin", announce);
    handle.database.update(users).set({ status: "deactivated" }).run();
    await addLegacyPeople(handle, [{ username: "rowan", status: "deactivated" }]);

    expect(await resetOwner(handle, auditLog, undefined, announce)).toEqual({ kind: "reset", username: "admin" });
    handle.database.update(users).set({ status: "deactivated" }).run();
    expect(await resetOwner(handle, auditLog, "rowan", announce)).toEqual({ kind: "reset", username: "rowan" });
    expect(usernamesOf(handle)).toEqual([
      { username: "admin", status: "deactivated" },
      { username: "rowan", status: "active" },
    ]);
  });

  it("says why it made no reset, naming nobody but the owner", () => {
    expect(refusalOf({ kind: "not_owner", owner: "alex" })).toBe(SINGLE_OWNER_MESSAGES.notOwner("alex"));
    expect(refusalOf({ kind: "unknown", username: "oak" })).toBe(SINGLE_OWNER_MESSAGES.unknown("oak"));
    expect(refusalOf({ kind: "choose" })).toBe(SINGLE_OWNER_MESSAGES.chooseOne);
  });
});
