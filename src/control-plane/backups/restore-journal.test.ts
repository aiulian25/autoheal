import { existsSync, mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startTestControlPlane } from "../../../test/support/control-plane.js";
import { RestoreJournal, type RestoreRecord } from "./restore-journal.js";

it.each(["safety-backup", "retaining-previous", "swapping", "settling", "committed"] as const)(
  "retains recovery paths and blocks startup at restore phase %s",
  (phase) => {
    const directory = mkdtempSync(join(tmpdir(), "autoheal-restore-journal-"));
    const record: RestoreRecord = {
      version: 1,
      restoreId: "11111111-1111-4111-8111-111111111111",
      phase,
      databasePath: join(directory, "live.sqlite"),
      snapshotPath: join(directory, "incoming.sqlite"),
      rollbackPath: join(directory, "previous.sqlite"),
      safetyBackup: "safety.db.age",
    };
    writeFileSync(record.snapshotPath, "synthetic snapshot");
    writeFileSync(record.rollbackPath, "synthetic previous database");
    new RestoreJournal(directory).save(record);
    expect(statSync(join(directory, "restore-operation.json")).mode & 0o777).toBe(0o600);
    expect(() => new RestoreJournal(directory).assertClean()).toThrow("operator recovery");
    expect(existsSync(record.snapshotPath)).toBe(true);
    expect(existsSync(record.rollbackPath)).toBe(true);
    new RestoreJournal(directory).complete();
    expect(() => new RestoreJournal(directory).assertClean()).not.toThrow();
  },
);
it("never deletes temporary recovery material when a reconstructed service sees an interrupted restore", async () => {
  const directory = mkdtempSync(join(tmpdir(), "autoheal-pending-restore-"));
  const plane = await startTestControlPlane({ backups: { dataDirectory: directory } });
  try {
    const temporary = plane.services.backupService.temporaryDirectory;
    mkdirSync(temporary, { recursive: true });
    const snapshotPath = join(temporary, "incoming.restore");
    writeFileSync(snapshotPath, "synthetic recovery material");
    new RestoreJournal(directory).save({
      version: 1,
      restoreId: "11111111-1111-4111-8111-111111111111",
      phase: "swapping",
      snapshotPath,
      databasePath: "live",
      rollbackPath: "previous",
      safetyBackup: "safety",
    });
    await expect(plane.services.restoreService.clearPending()).rejects.toThrow("operator recovery");
    expect(existsSync(snapshotPath)).toBe(true);
    writeFileSync(join(directory, "restore-operation.json"), "not valid JSON");
    await expect(plane.services.restoreService.clearPending()).rejects.toThrow();
    expect(existsSync(snapshotPath)).toBe(true);
  } finally {
    await plane.app.close();
    await plane.runnerApp.close();
  }
});
