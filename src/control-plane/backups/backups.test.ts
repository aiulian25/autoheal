import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TEST_BACKUP_PASSPHRASE,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { API_ROUTES, apiPath, type BackupView } from "../../shared/api.js";
import { BACKUP_RETENTION_COUNT } from "../../shared/constants.js";
import { auditEvents } from "../database/schema.js";
import { decryptBackup } from "./backup-crypto.js";
import { backupIfDue } from "./backup-scheduler.js";

describe("backups", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let offbox: string;

  beforeEach(async () => {
    offbox = mkdtempSync(join(tmpdir(), "autoheal-offbox-"));
    controlPlane = await startTestControlPlane({ backups: { offboxBackupDirectory: offbox } });
    admin = (await fullySignedInAdmin(controlPlane)).client;
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  const backups = () => controlPlane.services.backupService;
  const create = async () => (await admin.post(API_ROUTES.backups)).json<BackupView>();

  it("writes an age-encrypted copy that decrypts to an identical, healthy database", async () => {
    const backup = await create();
    expect(backup).toMatchObject({ origin: "manual", createdBy: "admin", integrityCheck: "ok", offboxCopied: true });
    const encrypted = readFileSync(join(backups().backupsDirectory, backup.fileName));
    expect(encrypted.subarray(0, 21).toString()).toBe("age-encryption.org/v1");
    expect(encrypted.includes(Buffer.from("SQLite format 3"))).toBe(false);

    const restoredPath = join(mkdtempSync(join(tmpdir(), "autoheal-check-")), "copy.sqlite");
    writeFileSync(restoredPath, await decryptBackup(encrypted, TEST_BACKUP_PASSPHRASE));
    const copy = new Database(restoredPath, { readonly: true });
    const live = controlPlane.services.databaseHandle.sqlite;
    for (const table of ["users", "sessions", "audit_events"]) {
      const count = (database: Database.Database) =>
        (database.prepare(`select count(*) as rows from ${table}`).get() as { rows: number }).rows;
      expect(count(copy), table).toBe(count(live) - (table === "audit_events" ? 1 : 0));
    }
    copy.close();
  });

  it("cannot be read with the wrong passphrase", async () => {
    const backup = await create();
    const encrypted = readFileSync(join(backups().backupsDirectory, backup.fileName));
    await expect(decryptBackup(encrypted, "not-the-passphrase-at-all-0123456789")).rejects.toThrow();
  });

  it("copies every backup and its manifest off-box", async () => {
    const backup = await create();
    expect(readdirSync(offbox).sort()).toEqual([backup.fileName, `${backup.fileName}.json`]);
  });

  const SLOW_TEST_MILLISECONDS = 60_000;

  it(
    "keeps the newest local backups only",
    async () => {
      for (let backup = 0; backup <= BACKUP_RETENTION_COUNT; backup += 1) {
        controlPlane.clock.now += 1_000;
        await backups().create("manual", null);
      }
      expect(await backups().list()).toHaveLength(BACKUP_RETENTION_COUNT);
      expect(readdirSync(offbox).filter((name) => name.endsWith(".age"))).toHaveLength(BACKUP_RETENTION_COUNT + 1);
    },
    SLOW_TEST_MILLISECONDS,
  );

  it("makes a scheduled backup when the last one is a day old", async () => {
    expect(await backupIfDue(backups(), controlPlane.clock.now)).toBe(true);
    expect(await backupIfDue(backups(), controlPlane.clock.now + 60_000)).toBe(false);
    controlPlane.clock.now += 24 * 60 * 60 * 1_000;
    expect(await backupIfDue(backups(), controlPlane.clock.now)).toBe(true);
  });

  it("downloads a backup as an attachment, admins only, by exact name only", async () => {
    const backup = await create();
    const download = await admin.get(apiPath(API_ROUTES.backupDownload, { fileName: backup.fileName }));
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toBe(`attachment; filename="${backup.fileName}"`);
    expect(download.rawPayload.length).toBe(backup.sizeBytes);
    const traversal = await admin.get(apiPath(API_ROUTES.backupDownload, { fileName: "../autoheal.sqlite" }));
    expect(traversal.json()).toEqual({ error: "backup_not_found" });
    const { client: viewer } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    expect((await viewer.get(API_ROUTES.backups)).statusCode).toBe(403);
  });

  it("skips a manifest it cannot read instead of failing every backup", async () => {
    const good = await create();
    writeFileSync(join(backups().backupsDirectory, "autoheal-20260101-000000-deadbeef.sqlite.age.json"), "{not json");
    expect((await backups().list()).map((backup) => backup.fileName)).toEqual([good.fileName]);
    expect((await create()).integrityCheck).toBe("ok");
  });

  it("audits who made each backup", async () => {
    await create();
    const event = controlPlane.services.databaseHandle.database
      .select()
      .from(auditEvents)
      .all()
      .find((candidate) => candidate.action === "backup.created");
    expect(event).toMatchObject({ actorLabel: "admin", targetKind: "backup" });
  });
});
