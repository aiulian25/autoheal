import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestClient, type TestControlPlane } from "../../../test/support/control-plane.js";
import {
  addLegacyPeople,
  asBeforeOnePerson,
  BEFORE_ONE_PERSON,
  LEGACY_PASSWORD,
} from "../../../test/support/legacy-people.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import { API_ROUTES, apiPath, type TaskDetailView } from "../../shared/api.js";
import {
  AUDIT_ACTIONS,
  HTTP_STATUS,
  IN_MEMORY_DATABASE,
  SINGLE_OWNER_MESSAGES,
  TASK_STATUS,
} from "../../shared/constants.js";
import { AuditLog } from "../audit/audit-log.js";
import { DatabaseHandle, openReadOnly } from "../database/connection.js";
import { auditEvents, passkeys, recoveryCodes, sessions, users } from "../database/schema.js";
import { ensureFirstAdmin } from "./bootstrap.js";
import { assertOwnerClear, keepOneOwner, ownerOf } from "./single-owner.js";

async function setUp() {
  const handle = new DatabaseHandle(IN_MEMORY_DATABASE);
  const auditLog = new AuditLog(handle, () => undefined);
  await ensureFirstAdmin(handle, auditLog, "admin", () => undefined);
  const owner = handle.database.select().from(users).get()!;
  return { handle, auditLog, owner };
}

const statusOf = (handle: DatabaseHandle, id: string) =>
  handle.database.select({ status: users.status }).from(users).where(eq(users.id, id)).get()?.status;

describe("whose an Autoheal is", () => {
  it("is its only active admin's, under any name", async () => {
    const { handle, owner } = await setUp();
    handle.database.update(users).set({ username: "alex" }).where(eq(users.id, owner.id)).run();
    expect(ownerOf(handle.sqlite)).toEqual({ kind: "owner", person: { id: owner.id, username: "alex" } });
  });

  it("of several active admins, is the one it was set up with", async () => {
    const { handle, owner } = await setUp();
    await addLegacyPeople(handle, [{ username: "cedar", role: "admin" }, { username: "rowan" }]);
    expect(ownerOf(handle.sqlite)).toEqual({ kind: "owner", person: { id: owner.id, username: "admin" } });
  });

  it("is its only active admin's, though another was the one it was set up with", async () => {
    const { handle, owner } = await setUp();
    handle.database.update(users).set({ status: "deactivated" }).where(eq(users.id, owner.id)).run();
    const ids = await addLegacyPeople(handle, [{ username: "cedar", role: "admin" }, { username: "rowan" }]);
    expect(ownerOf(handle.sqlite)).toEqual({ kind: "owner", person: { id: ids.get("cedar"), username: "cedar" } });
  });

  it("cannot tell while several admins are active and none of them is the first", async () => {
    const { handle, owner } = await setUp();
    handle.database.update(users).set({ status: "deactivated" }).where(eq(users.id, owner.id)).run();
    await addLegacyPeople(handle, [
      { username: "cedar", role: "admin" },
      { username: "rowan", role: "admin" },
    ]);
    expect(ownerOf(handle.sqlite)).toEqual({ kind: "unclear", admins: 2 });
  });

  it("cannot tell either when more than one active admin is on record as the one it was set up with", async () => {
    const { handle, auditLog } = await setUp();
    const cedar = (await addLegacyPeople(handle, [{ username: "cedar", role: "admin" }])).get("cedar")!;
    auditLog.record({
      actorKind: "system",
      actorLabel: "Autoheal",
      action: AUDIT_ACTIONS.adminBootstrapped,
      targetKind: "user",
      targetId: cedar,
    });
    expect(ownerOf(handle.sqlite)).toEqual({ kind: "unclear", admins: 2 });
  });

  it("is nobody's while no admin is active, a viewer or not", async () => {
    const { handle, owner } = await setUp();
    handle.database.update(users).set({ status: "deactivated" }).where(eq(users.id, owner.id)).run();
    await addLegacyPeople(handle, [{ username: "rowan" }]);
    expect(ownerOf(handle.sqlite)).toEqual({ kind: "nobody" });
    expect(ownerOf(new DatabaseHandle(IN_MEMORY_DATABASE).sqlite)).toEqual({ kind: "nobody" });
  });
});

describe("the database's own rule", () => {
  it("refuses a second person, and a second one active at once", async () => {
    const { handle } = await setUp();
    const add = () =>
      handle.sqlite
        .prepare(
          "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u2', 'cedar', 'x', 'viewer', 1)",
        )
        .run();
    expect(add).toThrow(/one_person/);
    const { cedar } = Object.fromEntries(
      await addLegacyPeople(handle, [{ username: "cedar", status: "deactivated" }]),
    ) as { cedar: string };
    const activate = () => handle.database.update(users).set({ status: "active" }).where(eq(users.id, cedar)).run();
    expect(activate).toThrow(/one_person/);
    expect(statusOf(handle, cedar)).toBe("deactivated");
  });
});

describe("a database from before Autoheal was one person's", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "autoheal-owner-"));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  // A file as the previous version left it: several people, no rule against them, its schema one older.
  async function legacyFile(people: Parameters<typeof addLegacyPeople>[1], ownerActive = true) {
    const path = join(directory, "autoheal.db");
    const handle = new DatabaseHandle(path);
    const auditLog = new AuditLog(handle, () => undefined);
    await ensureFirstAdmin(handle, auditLog, "admin", () => undefined);
    if (!ownerActive) handle.database.update(users).set({ status: "deactivated" }).run();
    await addLegacyPeople(handle, people);
    asBeforeOnePerson(handle);
    handle.close();
    return path;
  }
  const versionOf = (path: string) => {
    const sqlite = openReadOnly(path);
    try {
      return sqlite.pragma("user_version", { simple: true });
    } finally {
      sqlite.close();
    }
  };

  it("is left exactly as it was when it cannot say whose it is, for the version it came from", async () => {
    const path = await legacyFile(
      [
        { username: "cedar", role: "admin" },
        { username: "rowan", role: "admin" },
      ],
      false,
    );
    expect(() => assertOwnerClear(path)).toThrow(SINGLE_OWNER_MESSAGES.unclear(2));
    expect(versionOf(path)).toBe(BEFORE_ONE_PERSON);
  });

  it("is nobody's when empty, to be set up as a new one", () => {
    const path = join(directory, "empty.db");
    writeFileSync(path, "");
    expect(() => assertOwnerClear(path)).not.toThrow();
  });

  it("is opened and brought up to date when it can, the rule against a second person with it", async () => {
    const path = await legacyFile([{ username: "cedar", role: "admin" }]);
    expect(() => assertOwnerClear(path)).not.toThrow();
    const handle = new DatabaseHandle(path);
    try {
      expect(() =>
        handle.sqlite
          .prepare(
            "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u3', 'oak', 'x', 'viewer', 1)",
          )
          .run(),
      ).toThrow(/one_person/);
    } finally {
      handle.close();
    }
  });
});

describe("keeping one owner", () => {
  let controlPlane: TestControlPlane;
  let owner: TestClient;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    owner = (await fullySignedInAdmin(controlPlane)).client;
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  const task = async (title: string, assignee: string) => {
    const created = (await owner.post(API_ROUTES.tasks, { title })).json<TaskDetailView>();
    const assigned = await owner.request({
      method: "PATCH",
      url: apiPath(API_ROUTES.task, { taskId: created.id }),
      payload: { assignee: { kind: "user", id: assignee } },
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    return created.id;
  };
  const assigneeOf = async (taskId: string) =>
    (await owner.get(apiPath(API_ROUTES.task, { taskId }))).json<TaskDetailView>().assignee;

  it("signs everyone else out for good, keeps them in the history by name, and lets go of what they held", async () => {
    const { databaseHandle: handle, auditLog } = controlPlane.services;
    const ids = await addLegacyPeople(handle, [{ username: "cedar", role: "admin" }, { username: "rowan" }]);
    const cedar = controlPlane.client();
    expect((await cedar.signIn("cedar", LEGACY_PASSWORD)).statusCode).toBe(HTTP_STATUS.ok);
    const now = Date.now();
    handle.database
      .insert(passkeys)
      .values({
        id: "p1",
        userId: ids.get("cedar")!,
        relyingPartyId: "autoheal.test",
        credentialId: "c1",
        publicKey: "k",
        counter: 0,
        synced: true,
        name: "Cedar's phone",
        createdAt: now,
      })
      .run();
    handle.database
      .insert(recoveryCodes)
      .values({ id: "r1", userId: ids.get("rowan")!, codeHash: "h" })
      .run();
    const open = await task("Renew the Pi-hole certificate", ids.get("cedar")!);
    const closed = await task("Move Paperless to the Mini", ids.get("cedar")!);
    await owner.request({
      method: "PATCH",
      url: apiPath(API_ROUTES.task, { taskId: closed }),
      payload: { status: TASK_STATUS.done },
    });

    expect(keepOneOwner(handle, auditLog)).toEqual(["cedar", "rowan"]);
    expect(
      handle.database
        .select()
        .from(sessions)
        .where(eq(sessions.userId, ids.get("cedar")!))
        .all(),
    ).toEqual([]);

    expect((await cedar.get(API_ROUTES.session)).statusCode).toBe(HTTP_STATUS.unauthorized);
    expect((await controlPlane.client().signIn("cedar", LEGACY_PASSWORD)).statusCode).toBe(HTTP_STATUS.unauthorized);
    expect((await controlPlane.client().signIn("rowan", LEGACY_PASSWORD)).statusCode).toBe(HTTP_STATUS.unauthorized);
    expect((await owner.get(API_ROUTES.hosts)).statusCode).toBe(HTTP_STATUS.ok);
    const people = handle.database.select({ username: users.username, status: users.status }).from(users).all();
    expect(people.sort((one, other) => one.username.localeCompare(other.username))).toEqual([
      { username: "admin", status: "active" },
      { username: "cedar", status: "deactivated" },
      { username: "rowan", status: "deactivated" },
    ]);
    // Theirs only: the owner's own recovery codes stay.
    expect(
      handle.database
        .select()
        .from(passkeys)
        .where(eq(passkeys.userId, ids.get("cedar")!))
        .all(),
    ).toEqual([]);
    expect(
      handle.database
        .select()
        .from(recoveryCodes)
        .where(eq(recoveryCodes.userId, ids.get("rowan")!))
        .all(),
    ).toEqual([]);
    expect(handle.database.select().from(recoveryCodes).all().length).toBeGreaterThan(0);
    expect(await assigneeOf(open)).toBeNull();
    expect(await assigneeOf(closed)).toMatchObject({ kind: "user", name: "cedar" });
    const kept = handle.database
      .select({ details: auditEvents.detailsJson })
      .from(auditEvents)
      .where(eq(auditEvents.action, AUDIT_ACTIONS.oneOwnerKept))
      .all();
    expect(kept.map(({ details }) => JSON.parse(details))).toEqual([
      { owner: "admin", keptFromSigningIn: ["cedar", "rowan"] },
    ]);

    // Started again: nothing left to do, and nothing more said.
    expect(keepOneOwner(handle, auditLog)).toEqual([]);
    expect(
      handle.database.select().from(auditEvents).where(eq(auditEvents.action, AUDIT_ACTIONS.oneOwnerKept)).all(),
    ).toHaveLength(1);
  });

  it("has no way left to add, change or remove anyone, or to grant anything", async () => {
    const someone = "00000000-0000-4000-8000-000000000000";
    const retired = [
      ["GET", "/api/users"],
      ["POST", "/api/users"],
      ["PATCH", `/api/users/${someone}`],
      ["DELETE", `/api/users/${someone}`],
      ["POST", `/api/users/${someone}/reset-password`],
      ["POST", `/api/users/${someone}/reset-totp`],
      ["GET", `/api/users/${someone}/grants`],
      ["PUT", `/api/users/${someone}/grants`],
      ["GET", "/api/account/permissions"],
    ] as const;
    for (const [method, url] of retired) {
      const response = await owner.request({ method, url, payload: { username: "cedar", role: "admin" } });
      expect([method, url, response.statusCode]).toEqual([method, url, HTTP_STATUS.notFound]);
    }
    expect(controlPlane.services.databaseHandle.database.select().from(users).all()).toHaveLength(1);
  });
});
