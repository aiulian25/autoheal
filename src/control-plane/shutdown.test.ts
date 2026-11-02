import { expect, it } from "vitest";
import { startTestControlPlane } from "../../test/support/control-plane.js";
import { BACKUP_ORIGIN } from "../shared/constants.js";
it("keeps SQLite open through a real asynchronous encrypted backup and closes it last", async () => {
  const plane = await startTestControlPlane();
  const handle = plane.services.databaseHandle;
  const events: string[] = [];
  try {
    const backup = plane.services.backupService.create(BACKUP_ORIGIN.scheduled, null).then((result) => {
      expect(result.integrityCheck).toBe("ok");
      events.push("backup completed");
    });
    const shutdown = handle.restore.shutdown().then(() => {
      events.push("drained");
      handle.close();
    });
    expect(events).toEqual([]);
    expect((await plane.client().get("/api/session")).statusCode).toBe(503);
    await backup;
    await shutdown;
    expect(events).toEqual(["backup completed", "drained"]);
    expect(() => handle.sqlite).toThrow("restore_maintenance");
  } finally {
    await plane.app.close();
    await plane.runnerApp.close();
  }
});
