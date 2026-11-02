import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TEST_BACKUP_PASSPHRASE,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
  runnerTokenOf,
} from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import {
  API_ROUTES,
  apiPath,
  type BackupView,
  type EnrolledHostView,
  type RestorePreviewView,
  type RestoreResultView,
} from "../../shared/api.js";
import { APPLICATION_BACKUP_FAILURE } from "../../shared/application-backups.js";
import { RESTORE_UPLOAD_LIMIT_BYTES } from "../../shared/constants.js";
import { RUNNER_ROUTES } from "../../shared/protocol.js";
import { AuditLog } from "../audit/audit-log.js";
import { DatabaseHandle } from "../database/connection.js";
import { identityMigration } from "../database/migrations/0001-identity.js";
import { hosts, incidents, jobs, users, workItems } from "../database/schema.js";
import { SecretBox } from "../database/secret-box.js";
import { encryptBackup } from "./backup-crypto.js";
import { restoreOffline } from "./restore-service.js";

const databaseFile = () => join(mkdtempSync(join(tmpdir(), "autoheal-restore-")), "autoheal.sqlite");
const SEED = "JBSWY3DPEHPK3PXP";
const ADD_ENROLLED_ADMIN =
  "INSERT INTO users (id, username, password_hash, role, created_at, totp_secret, totp_enabled) VALUES (?, ?, 'hash', 'admin', 0, ?, 1)";

function sqliteBytes(build: (database: Database.Database) => void): Buffer {
  const path = join(mkdtempSync(join(tmpdir(), "autoheal-crafted-")), "crafted.sqlite");
  const database = new Database(path);
  build(database);
  database.close();
  return readFileSync(path);
}

describe("restore", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane({ databasePath: databaseFile() });
    admin = (await fullySignedInAdmin(controlPlane)).client;
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  const database = () => controlPlane.services.databaseHandle.database;
  const upload = (bytes: Uint8Array) =>
    admin.request({
      method: "POST",
      url: API_ROUTES.restoreUpload,
      payload: Buffer.from(bytes),
      headers: { "content-type": "application/octet-stream" },
    });
  const confirm = (preview: RestorePreviewView) =>
    admin.post(apiPath(API_ROUTES.restoreConfirm, { restoreId: preview.restoreId }));
  const usernames = () =>
    database()
      .select()
      .from(users)
      .all()
      .map((user) => user.username)
      .sort();

  async function seedFleet() {
    const token = runnerTokenOf((await admin.post(API_ROUTES.hosts, { label: "HP" })).json<EnrolledHostView>());
    const host = database().select().from(hosts).get()!;
    const now = controlPlane.clock.now;
    database()
      .insert(incidents)
      .values({
        id: "11111111-1111-4111-8111-111111111111",
        hostId: host.id,
        containerName: "paperless",
        image: "paperless:2",
        triggerEvent: "die",
        detectedAt: now,
        status: "awaiting_approval",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return { token, host };
  }

  it("rejects overlapping confirmations before a second safety backup starts", async () => {
    const backups = controlPlane.services.backupService;
    const backup = await backups.create("manual", null);
    const restores = controlPlane.services.restoreService;
    const actor = (id: string) => ({ userId: id, username: id, ip: "127.0.0.1", requestId: id });
    const first = await restores.prepareStored(actor("first"), backup.fileName);
    const second = await restores.prepareStored(actor("second"), backup.fileName);
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const create = backups.create.bind(backups);
    let calls = 0;
    backups.create = async (origin, requestedBy) => {
      calls += 1;
      if (calls > 1) throw new Error("second restore reached backup creation");
      entered();
      await paused;
      return create(origin, requestedBy);
    };
    const one = restores.confirm(actor("first"), first.restoreId);
    await waiting;
    const two = restores.confirm(actor("second"), second.restoreId);
    const rejected = two.catch((error: unknown) => error);
    try {
      expect(calls).toBe(1);
    } finally {
      release();
      await Promise.allSettled([one, rejected]);
    }
    expect(await rejected).toMatchObject({ code: "restore_busy" });
  });

  it("drains model-like work before swapping and rejects late callbacks against the restored database", async () => {
    const lifecycle = controlPlane.services.databaseHandle.restore;
    const backups = controlPlane.services.backupService;
    const restores = controlPlane.services.restoreService;
    const actor = { userId: "first", username: "first", ip: "127.0.0.1", requestId: "first" };
    const backup = await backups.create("manual", null);
    const preview = await restores.prepareStored(actor, backup.fileName);
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let late!: () => void;
    let modelFinished = false;
    const worker = lifecycle.wrap({
      async run() {
        late = AsyncLocalStorage.bind(() => {
          database()
            .insert(users)
            .values({ id: "late-user", username: "late", passwordHash: "synthetic", role: "viewer", createdAt: 1 })
            .run();
        });
        await paused;
        modelFinished = true;
      },
    });
    const work = worker.run();
    const create = backups.create.bind(backups);
    let backupStarted = false;
    backups.create = async (origin, requestedBy) => {
      expect(modelFinished).toBe(true);
      backupStarted = true;
      return create(origin, requestedBy);
    };
    const restoring = restores.confirm(actor, preview.restoreId);
    expect(lifecycle.busy).toBe(true);
    expect(backupStarted).toBe(false);
    const maintenance = await admin.get(API_ROUTES.tasks);
    expect(maintenance.statusCode).toBe(503);
    expect(maintenance.json()).toMatchObject({ error: "restore_maintenance" });
    release();
    await work;
    await restoring;
    expect(late).toThrow("restore_maintenance");
    expect(usernames()).not.toContain("late");
  });

  it("stops the control plane's own runners before the swap and rebuilds them after it", async () => {
    const { backupService, restoreService, embeddedRunners, localHostRunner, databaseHandle } = controlPlane.services;
    const actor = { userId: "first", username: "first", ip: "127.0.0.1", requestId: "first" };
    const backup = await backupService.create("manual", null);
    const preview = await restoreService.prepareStored(actor, backup.fileName);
    const order: string[] = [];
    const swapFile = databaseHandle.swapFile.bind(databaseHandle);
    vi.spyOn(databaseHandle, "swapFile").mockImplementation((...swap: Parameters<typeof swapFile>) => {
      order.push("swap");
      swapFile(...swap);
    });
    for (const [name, runners] of [
      ["ssh", embeddedRunners],
      ["local", localHostRunner],
    ] as const) {
      vi.spyOn(runners, "pause").mockImplementation(() => order.push(`${name} pause`));
      vi.spyOn(runners, "resume").mockImplementation(() => order.push(`${name} resume`));
    }
    await restoreService.confirm(actor, preview.restoreId);
    expect(order).toEqual(["ssh pause", "local pause", "swap", "ssh resume", "local resume"]);
  });

  it("reopens the retained previous database if post-swap reconciliation fails", async () => {
    const backups = controlPlane.services.backupService;
    const restores = controlPlane.services.restoreService;
    const actor = { userId: "first", username: "first", ip: "127.0.0.1", requestId: "first" };
    const backup = await backups.create("manual", null);
    await fullySignedInUser(controlPlane, admin, "keep-me", "viewer");
    const preview = await restores.prepareStored(actor, backup.fileName);
    const lifecycle = controlPlane.services.databaseHandle.restore;
    let first = true;
    lifecycle.onResume(() => {
      if (first) {
        first = false;
        throw new Error("post-swap failure");
      }
    });
    await expect(restores.confirm(actor, preview.restoreId)).rejects.toThrow("post-swap failure");
    expect(usernames()).toContain("keep-me");
    expect(controlPlane.services.databaseHandle.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(lifecycle.busy).toBe(false);
    expect((await backups.list()).some(({ origin }) => origin === "pre_restore")).toBe(true);
  });

  it("brings the data back, cancels what was waiting, and signs everyone out", async () => {
    await seedFleet();
    await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    const backup = (await admin.post(API_ROUTES.backups)).json<BackupView>();

    const partner = database().select().from(users).where(eq(users.username, "partner")).get()!;
    database().update(users).set({ status: "deactivated" }).where(eq(users.id, partner.id)).run();
    database().update(hosts).set({ status: "revoked" }).run();
    await admin.post(API_ROUTES.users, { username: "later", role: "viewer" });

    const preview = (
      await admin.post(apiPath(API_ROUTES.backupRestore, { fileName: backup.fileName }))
    ).json<RestorePreviewView>();
    expect(preview).toMatchObject({
      source: "stored",
      fileName: backup.fileName,
      usersReactivated: ["partner"],
      usersAdded: [],
      hostsRestored: ["HP"],
      counts: { users: 2, hosts: 1, incidents: 1 },
    });

    const result = (await confirm(preview)).json<RestoreResultView>();
    expect(result.cancelledIncidents).toBe(1);
    expect(usernames()).toEqual(["admin", "partner"]);
    expect(database().select().from(incidents).get()!.status).toBe("cancelled");
    expect((await admin.get(API_ROUTES.session)).statusCode).toBe(401);
    const backups = await controlPlane.services.backupService.list();
    expect(backups.map((entry) => entry.origin)).toContain("pre_restore");
    expect(controlPlane.stdout.join("")).toContain('"action":"backup.restore_completed"');
  });

  function seedApplicationWork(hostId: string) {
    const sqlite = controlPlane.services.databaseHandle.sqlite,
      now = controlPlane.clock.now,
      plan = randomUUID();
    sqlite
      .prepare(
        "INSERT INTO application_backup_plans(id,host_id,revision,definition_json,enabled,next_due_at,created_at,updated_at) VALUES(?,?,1,'{}',1,?,?,?)",
      )
      .run(plan, hostId, now, now, now);
    const queued = randomUUID(),
      running = randomUUID(),
      artifact = randomUUID(),
      rollout = randomUUID();
    for (const [id, status] of [
      [queued, "queued"],
      [running, "running"],
    ])
      sqlite
        .prepare(
          "INSERT INTO application_backup_runs(id,plan_id,host_id,operation,status,task_json,request_key,created_at) VALUES(?,?,?,'restore',?,'{}',?,?)",
        )
        .run(id, plan, hostId, status, id, now);
    sqlite
      .prepare(
        "INSERT INTO application_backup_artifacts(id,plan_id,host_id,capture_run_id,key_ciphertext,recipient,status,created_at) VALUES(?,?,?,?,'encrypted-private-key','public-recipient','ready',?)",
      )
      .run(artifact, plan, hostId, running, now);
    sqlite
      .prepare("INSERT INTO rollouts VALUES(?,?,?,?)")
      .run(
        rollout,
        now,
        now,
        JSON.stringify({ id: rollout, status: "ready", updatedAt: now, reason: null, targets: [], current: 0 }),
      );
    return { plan, queued, running, artifact, rollout };
  }
  function assertApplicationSettled(sqlite: Database.Database, ids: ReturnType<typeof seedApplicationWork>) {
    expect(sqlite.prepare("SELECT status,failure FROM application_backup_runs WHERE id=?").get(ids.queued)).toEqual({
      status: "failed",
      failure: APPLICATION_BACKUP_FAILURE.databaseRestored,
    });
    expect(sqlite.prepare("SELECT status FROM application_backup_runs WHERE id=?").get(ids.running)).toEqual({
      status: "recovery-required",
    });
    expect(sqlite.prepare("SELECT enabled,next_due_at FROM application_backup_plans WHERE id=?").get(ids.plan)).toEqual(
      { enabled: 0, next_due_at: null },
    );
    expect(
      sqlite.prepare("SELECT key_ciphertext FROM application_backup_artifacts WHERE id=?").get(ids.artifact),
    ).toEqual({ key_ciphertext: "encrypted-private-key" });
    const rollout = sqlite.prepare("SELECT state_json FROM rollouts WHERE id=?").get(ids.rollout) as {
      state_json: string;
    };
    expect(JSON.parse(rollout.state_json)).toMatchObject({ status: "held" });
  }
  it("settles stale application approvals and holds schedules/rollouts on online restore", async () => {
    const { host } = await seedFleet();
    const ids = seedApplicationWork(host.id);
    const backup = (await admin.post(API_ROUTES.backups)).json<BackupView>();
    const preview = (
      await admin.post(apiPath(API_ROUTES.backupRestore, { fileName: backup.fileName }))
    ).json<RestorePreviewView>();
    expect((await confirm(preview)).statusCode).toBe(200);
    assertApplicationSettled(controlPlane.services.databaseHandle.sqlite, ids);
    await controlPlane.services.applicationBackups.schedule();
    assertApplicationSettled(controlPlane.services.databaseHandle.sqlite, ids);
    expect(controlPlane.stdout.join(" ")).toContain(ids.running);
  });
  it("applies the same application settlement during offline restore", async () => {
    const { host } = await seedFleet();
    const ids = seedApplicationWork(host.id);
    const backup = (await admin.post(API_ROUTES.backups)).json<BackupView>();
    const backupPath = join(controlPlane.services.backupService.backupsDirectory, backup.fileName),
      databasePath = controlPlane.services.databaseHandle.path;
    await controlPlane.app.close();
    controlPlane.services.databaseHandle.close();
    await restoreOffline(
      () => new DatabaseHandle(databasePath),
      (handle) => new AuditLog(handle, () => {}),
      { databasePath, temporaryDirectory: join(databasePath, "..", "tmp"), passphrase: TEST_BACKUP_PASSPHRASE },
      backupPath,
      Date.now(),
    );
    const restored = new DatabaseHandle(databasePath);
    try {
      assertApplicationSettled(restored.sqlite, ids);
    } finally {
      restored.close();
    }
    controlPlane = await startTestControlPlane({ databasePath: databaseFile() });
  });

  it("cancels an approved action the host had not run yet", async () => {
    const { host } = await seedFleet();
    const backupWithWork = async () => {
      const now = controlPlane.clock.now;
      const adminRow = database().select().from(users).get()!;
      controlPlane.services.databaseHandle.sqlite
        .prepare(
          "insert into approvals (id, incident_id, decided_by, choice, decided_at) values (?, ?, ?, 'restart', ?)",
        )
        .run("22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111", adminRow.id, now);
      database()
        .insert(workItems)
        .values({
          id: "33333333-3333-4333-8333-333333333333",
          hostId: host.id,
          incidentId: "11111111-1111-4111-8111-111111111111",
          approvalId: "22222222-2222-4222-8222-222222222222",
          action: "restart",
          target: "paperless",
          status: "pending",
          createdAt: now,
          expiresAt: now + 60_000,
        })
        .run();
      return (await admin.post(API_ROUTES.backups)).json<BackupView>();
    };
    const backup = await backupWithWork();
    const preview = (
      await admin.post(apiPath(API_ROUTES.backupRestore, { fileName: backup.fileName }))
    ).json<RestorePreviewView>();
    await confirm(preview);
    expect(database().select().from(workItems).get()!.status).toBe("cancelled");
  });

  it("never lets a container action asked for before the backup reach the runner after a restore", async () => {
    const { host, token } = await seedFleet();
    database()
      .insert(jobs)
      .values({
        id: "44444444-4444-4444-8444-444444444444",
        hostId: host.id,
        containerName: "paperless",
        action: "stop",
        status: "pending",
        createdAt: controlPlane.clock.now,
        expiresAt: controlPlane.clock.now + 60_000,
      })
      .run();
    const backup = (await admin.post(API_ROUTES.backups)).json<BackupView>();
    const preview = (
      await admin.post(apiPath(API_ROUTES.backupRestore, { fileName: backup.fileName }))
    ).json<RestorePreviewView>();
    await confirm(preview);
    expect(database().select().from(jobs).get()).toMatchObject({
      status: "expired",
      outcome: "Cancelled by a restore: an action asked for before it never runs.",
    });
    const work = await controlPlane.runnerApp.inject({
      method: "GET",
      url: RUNNER_ROUTES.work,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(work.json()).toMatchObject({ jobs: [] });
  });

  it("leaves the live database untouched when the restored file fails halfway", async () => {
    await seedFleet();
    const crafted = sqliteBytes((sqlite) => {
      sqlite.exec(identityMigration.sql);
      // Migration 2 will try to create this table again, after the file is already in place.
      sqlite.exec("CREATE TABLE incidents (id TEXT PRIMARY KEY)");
      sqlite.pragma("user_version = 1");
    });
    const preview = (await upload(await encryptBackup(crafted, TEST_BACKUP_PASSPHRASE))).json<RestorePreviewView>();
    expect(preview.schemaVersion).toBe(1);
    const failed = await confirm(preview);
    expect(failed.statusCode).toBe(500);
    expect(usernames()).toEqual(["admin"]);
    expect(
      database()
        .select()
        .from(hosts)
        .all()
        .map((host) => host.label),
    ).toEqual(["HP"]);
    expect((await admin.get(API_ROUTES.users)).statusCode).toBe(200);
  });

  it("keeps one restore in preparation per person", async () => {
    const backup = (await admin.post(API_ROUTES.backups)).json<BackupView>();
    const prepare = async () =>
      (await admin.post(apiPath(API_ROUTES.backupRestore, { fileName: backup.fileName }))).json<RestorePreviewView>();
    const first = await prepare();
    const second = await prepare();
    const waiting = readdirSync(controlPlane.services.backupService.temporaryDirectory).filter((name) =>
      name.endsWith(".restore"),
    );
    expect(waiting).toHaveLength(1);
    expect((await confirm(first)).json()).toEqual({ error: "restore_not_found" });
    expect((await confirm(second)).statusCode).toBe(200);
  });

  it("forgets restores in preparation when the process starts again", async () => {
    const backup = (await admin.post(API_ROUTES.backups)).json<BackupView>();
    const preview = (
      await admin.post(apiPath(API_ROUTES.backupRestore, { fileName: backup.fileName }))
    ).json<RestorePreviewView>();
    await controlPlane.services.restoreService.clearPending();
    expect(existsSync(controlPlane.services.backupService.temporaryDirectory)).toBe(false);
    expect((await confirm(preview)).json()).toEqual({ error: "restore_not_found" });
  });

  it("only lets the person who prepared a restore confirm or cancel it", async () => {
    const backup = (await admin.post(API_ROUTES.backups)).json<BackupView>();
    const preview = (
      await admin.post(apiPath(API_ROUTES.backupRestore, { fileName: backup.fileName }))
    ).json<RestorePreviewView>();
    const { client: otherAdmin } = await fullySignedInUser(controlPlane, admin, "backup-admin", "admin");
    const stolen = await otherAdmin.post(apiPath(API_ROUTES.restoreConfirm, { restoreId: preview.restoreId }));
    expect(stolen.json()).toEqual({ error: "restore_not_found" });
    const cancelled = await admin.request({
      method: "DELETE",
      url: apiPath(API_ROUTES.restore, { restoreId: preview.restoreId }),
    });
    expect(cancelled.statusCode).toBe(204);
    expect((await confirm(preview)).json()).toEqual({ error: "restore_not_found" });
  });

  describe("an uploaded file", () => {
    const validAutohealBytes = () =>
      sqliteBytes((sqlite) => {
        sqlite.exec(identityMigration.sql);
        sqlite.pragma("user_version = 1");
      });

    it.each([
      [
        "truncated",
        async () => (await encryptBackup(validAutohealBytes(), TEST_BACKUP_PASSPHRASE)).subarray(0, 200),
        "backup_unreadable",
      ],
      [
        "tampered with (one bit flipped)",
        async () => {
          const bytes = await encryptBackup(validAutohealBytes(), TEST_BACKUP_PASSPHRASE);
          bytes[bytes.length - 40]! ^= 1;
          return bytes;
        },
        "backup_unreadable",
      ],
      [
        "encrypted with another passphrase (a forgery)",
        async () => encryptBackup(validAutohealBytes(), "someone-elses-passphrase-0123456789"),
        "backup_unreadable",
      ],
      ["not encrypted at all", async () => validAutohealBytes(), "backup_unreadable"],
      [
        "not a database",
        async () => encryptBackup(Buffer.from("hello, not sqlite"), TEST_BACKUP_PASSPHRASE),
        "not_an_autoheal_database",
      ],
      [
        "some other application's database",
        async () =>
          encryptBackup(
            sqliteBytes((sqlite) => sqlite.exec("CREATE TABLE notes (body TEXT)")),
            TEST_BACKUP_PASSPHRASE,
          ),
        "not_an_autoheal_database",
      ],
      [
        "from a newer Autoheal",
        async () =>
          encryptBackup(
            sqliteBytes((sqlite) => {
              sqlite.exec(identityMigration.sql);
              sqlite.pragma("user_version = 99");
            }),
            TEST_BACKUP_PASSPHRASE,
          ),
        "backup_too_new",
      ],
    ])("is refused when %s, and nothing changes", async (_case, bytes, error) => {
      const response = await upload(await bytes());
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ error });
      expect(usernames()).toEqual(["admin"]);
    });

    it("is refused when too large, before it is read", async () => {
      const response = await upload(Buffer.alloc(RESTORE_UPLOAD_LIMIT_BYTES + 1));
      expect(response.statusCode).toBe(413);
      expect(response.json()).toEqual({ error: "payload_too_large" });
    });

    it("is refused when another backup passphrase sealed its sign-in codes", async () => {
      const crafted = sqliteBytes((sqlite) => {
        sqlite.exec(identityMigration.sql);
        sqlite.pragma("user_version = 1");
        const foreign = SecretBox.fromPassphrase("another-backup-passphrase-0123456789abcdef").seal(SEED);
        sqlite.prepare(ADD_ENROLLED_ADMIN).run(randomUUID(), "elsewhere", foreign);
      });
      const refused = await upload(await encryptBackup(crafted, TEST_BACKUP_PASSPHRASE));
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toEqual({ error: "backup_secrets_unreadable" });
      expect(usernames()).toEqual(["admin"]);
    });

    it("restores a backup made by another instance with the same passphrase", async () => {
      const other = await startTestControlPlane({ databasePath: databaseFile() });
      const otherAdmin = (await fullySignedInAdmin(other)).client;
      await otherAdmin.post(API_ROUTES.users, { username: "from-elsewhere", role: "viewer" });
      const otherBackup = (await otherAdmin.post(API_ROUTES.backups)).json<BackupView>();
      const bytes = readFileSync(join(other.services.backupService.backupsDirectory, otherBackup.fileName));
      await other.app.close();
      await other.runnerApp.close();

      const preview = (await upload(bytes)).json<RestorePreviewView>();
      expect(preview).toMatchObject({ source: "uploaded", usersAdded: ["from-elsewhere"] });
      expect((await confirm(preview)).statusCode).toBe(200);
      expect(usernames()).toEqual(["admin", "from-elsewhere"]);
    });
  });

  it("puts the previous database back when a command-line restore will not open", async () => {
    await admin.post(API_ROUTES.users, { username: "after-backup", role: "viewer" });
    const crafted = sqliteBytes((sqlite) => {
      sqlite.exec(identityMigration.sql);
      sqlite.exec("CREATE TABLE incidents (id TEXT PRIMARY KEY)");
      sqlite.pragma("user_version = 1");
    });
    const brokenBackup = join(mkdtempSync(join(tmpdir(), "autoheal-broken-")), "broken.sqlite.age");
    writeFileSync(brokenBackup, await encryptBackup(crafted, TEST_BACKUP_PASSPHRASE));
    const databasePath = controlPlane.services.databaseHandle.path;
    await controlPlane.app.close();
    controlPlane.services.databaseHandle.close();

    const attempt = restoreOffline(
      () => new DatabaseHandle(databasePath),
      (handle) => new AuditLog(handle, () => undefined),
      { databasePath, temporaryDirectory: join(databasePath, "..", "tmp"), passphrase: TEST_BACKUP_PASSPHRASE },
      brokenBackup,
      Date.now(),
    );
    await expect(attempt).rejects.toThrow();
    expect(readdirSync(dirname(databasePath)).filter((name) => name.includes("before-restore"))).toEqual([]);
    const intact = new DatabaseHandle(databasePath);
    expect(
      intact.database
        .select()
        .from(users)
        .all()
        .map((user) => user.username)
        .sort(),
    ).toEqual(["admin", "after-backup"]);
    intact.close();
    controlPlane = await startTestControlPlane({ databasePath: databaseFile() });
  });

  it("seals the sign-in codes an older backup brings back in plain text", async () => {
    const crafted = sqliteBytes((sqlite) => {
      sqlite.exec(identityMigration.sql);
      sqlite.pragma("user_version = 1");
      sqlite.prepare(ADD_ENROLLED_ADMIN).run(randomUUID(), "older", SEED);
    });
    const olderBackup = join(mkdtempSync(join(tmpdir(), "autoheal-older-")), "older.sqlite.age");
    writeFileSync(olderBackup, await encryptBackup(crafted, TEST_BACKUP_PASSPHRASE));
    const databasePath = controlPlane.services.databaseHandle.path;
    await controlPlane.app.close();
    controlPlane.services.databaseHandle.close();

    await restoreOffline(
      () => new DatabaseHandle(databasePath),
      (handle) => new AuditLog(handle, () => undefined),
      { databasePath, temporaryDirectory: join(databasePath, "..", "tmp"), passphrase: TEST_BACKUP_PASSPHRASE },
      olderBackup,
      Date.now(),
    );
    const restored = new DatabaseHandle(databasePath);
    const { totpSecret } = restored.database.select().from(users).where(eq(users.username, "older")).get()!;
    restored.close();
    expect(totpSecret).not.toContain(SEED);
    expect(SecretBox.fromPassphrase(TEST_BACKUP_PASSPHRASE).open(totpSecret!)).toBe(SEED);
    controlPlane = await startTestControlPlane({ databasePath: databaseFile() });
  });

  it("restores from the command line with the control plane stopped, keeping the old file", async () => {
    const backup = (await admin.post(API_ROUTES.backups)).json<BackupView>();
    const backupPath = join(controlPlane.services.backupService.backupsDirectory, backup.fileName);
    await admin.post(API_ROUTES.users, { username: "after-backup", role: "viewer" });
    const databasePath = controlPlane.services.databaseHandle.path;
    await controlPlane.app.close();
    controlPlane.services.databaseHandle.close();

    const stdout: string[] = [];
    const result = await restoreOffline(
      () => new DatabaseHandle(databasePath),
      (handle) => new AuditLog(handle, (line) => stdout.push(line)),
      { databasePath, temporaryDirectory: join(databasePath, "..", "tmp"), passphrase: TEST_BACKUP_PASSPHRASE },
      backupPath,
      Date.now(),
    );
    expect(existsSync(result.previousKeptAt)).toBe(true);
    const restored = new DatabaseHandle(databasePath);
    expect(
      restored.database
        .select()
        .from(users)
        .all()
        .map((user) => user.username),
    ).toEqual(["admin"]);
    restored.close();
    expect(stdout.join("")).toContain("command_line");
    controlPlane = await startTestControlPlane({ databasePath: databaseFile() });
  });
});
