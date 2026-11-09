import { describe, expect, it, vi } from "vitest";
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
});
