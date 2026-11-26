import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IN_MEMORY_DATABASE, LIVE_EVENT, TRIGGER_UNHEALTHY } from "../../shared/constants.js";
import { DatabaseHandle } from "../database/connection.js";
import { BoardChanges } from "./board-changes.js";

describe("telling open dashboards that the board changed", () => {
  it("tells them once for each change to the tasks or incidents, whoever wrote it, and nothing meanwhile", () => {
    const handle = new DatabaseHandle(IN_MEMORY_DATABASE);
    const run = (sql: string, ...values: unknown[]) => handle.sqlite.prepare(sql).run(...values);
    run(
      "INSERT INTO hosts (id, label, token_hash, token_hint, enrolled_at) VALUES ('host', 'Rowan', 'hash', 'hint', 0)",
    );
    const publish = vi.fn();
    const changes = new BoardChanges(handle, { publish });
    changes.check();
    changes.check();
    expect(publish).not.toHaveBeenCalled();

    run(
      "INSERT INTO incidents (id, host_id, container_name, image, trigger_event, detected_at, status, created_at, updated_at) VALUES ('i1', 'host', 'web', 'nginx', ?, 1, 'deciding', 1, 1)",
      TRIGGER_UNHEALTHY,
    );
    changes.check();
    expect(publish).toHaveBeenLastCalledWith({ kind: LIVE_EVENT.board });
    changes.check();
    expect(publish).toHaveBeenCalledTimes(1);

    run("UPDATE incidents SET status = 'resolved', updated_at = 5 WHERE id = 'i1'");
    changes.check();
    expect(publish).toHaveBeenCalledTimes(2);
    run("DELETE FROM incidents WHERE id = 'i1'");
    changes.check();
    expect(publish).toHaveBeenCalledTimes(3);
    handle.close();
  });

  it("tells a change that leaves the count and the newest time as they were, and nothing for other tables", () => {
    const handle = new DatabaseHandle(IN_MEMORY_DATABASE);
    const run = (sql: string, ...values: unknown[]) => handle.sqlite.prepare(sql).run(...values);
    run(
      "INSERT INTO hosts (id, label, token_hash, token_hint, enrolled_at) VALUES ('host', 'Rowan', 'hash', 'hint', 0)",
    );
    for (const id of ["i1", "i2"]) {
      run(
        "INSERT INTO incidents (id, host_id, container_name, image, trigger_event, detected_at, status, created_at, updated_at) VALUES (?, 'host', 'web', 'nginx', ?, 1, 'deciding', 1, 1000)",
        id,
        TRIGGER_UNHEALTHY,
      );
    }
    const publish = vi.fn();
    const changes = new BoardChanges(handle, { publish });
    changes.check();

    // Both rows change at the same moment as before: no count or time says so.
    run("UPDATE incidents SET status = 'decided' WHERE id IN ('i1', 'i2')");
    changes.check();
    expect(publish).toHaveBeenCalledTimes(1);
    run("UPDATE hosts SET label = 'Cedar' WHERE id = 'host'");
    changes.check();
    expect(publish).toHaveBeenCalledTimes(1);
    handle.close();
  });

  describe("kept in a file", () => {
    let directory: string;
    beforeEach(() => {
      directory = mkdtempSync(join(tmpdir(), "autoheal-board-"));
    });
    afterEach(() => {
      rmSync(directory, { recursive: true, force: true });
    });
    const withHost = (handle: DatabaseHandle) => {
      handle.sqlite
        .prepare(
          "INSERT INTO hosts (id, label, token_hash, token_hint, enrolled_at) VALUES ('host', 'Rowan', 'hash', 'hint', 0)",
        )
        .run();
      return handle;
    };
    const INCIDENT =
      "INSERT INTO incidents (id, host_id, container_name, image, trigger_event, detected_at, status, created_at, updated_at) VALUES ('i1', 'host', 'web', 'nginx', ?, 1, 'deciding', 1, 1)";

    it("tells a change another process wrote, through a connection none of its own counters are on", () => {
      const path = join(directory, "autoheal.db");
      const handle = withHost(new DatabaseHandle(path));
      const publish = vi.fn();
      const changes = new BoardChanges(handle, { publish });
      changes.check();
      const beside = new Database(path);
      beside.prepare(INCIDENT).run(TRIGGER_UNHEALTHY);
      beside.close();
      changes.check();
      expect(publish).toHaveBeenCalledTimes(1);
      handle.close();
    });

    it("tells the board a restore brings back, and counts its changes from there", () => {
      const path = join(directory, "autoheal.db");
      const handle = withHost(new DatabaseHandle(path));
      const publish = vi.fn();
      const changes = new BoardChanges(handle, { publish });
      changes.check();
      const restored = join(directory, "restored.db");
      const backup = withHost(new DatabaseHandle(restored));
      backup.sqlite.prepare(INCIDENT).run(TRIGGER_UNHEALTHY);
      backup.close();

      handle.swapFile(restored, join(directory, "rollback.db"));
      changes.check();
      expect(publish).toHaveBeenCalledTimes(1);
      changes.check();
      expect(publish).toHaveBeenCalledTimes(1);
      handle.sqlite.prepare("UPDATE incidents SET status = 'resolved' WHERE id = 'i1'").run();
      changes.check();
      expect(publish).toHaveBeenCalledTimes(2);
      handle.close();
    });
  });
});
