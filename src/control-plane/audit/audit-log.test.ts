import { describe, expect, it, vi } from "vitest";
import { ACTOR_SYSTEM, AUDIT_ACTIONS, IN_MEMORY_DATABASE } from "../../shared/constants.js";
import { DatabaseHandle } from "../database/connection.js";
import { auditEvents } from "../database/schema.js";
import { AuditLog } from "./audit-log.js";

const setup = (options = {}) => {
  const lines: string[] = [];
  const handle = new DatabaseHandle(IN_MEMORY_DATABASE);
  return { handle, lines, auditLog: new AuditLog(handle, (line) => lines.push(line), Date.now, options) };
};

describe("AuditLog", () => {
  it("pages back through events that share a millisecond without skipping any", () => {
    const handle = new DatabaseHandle(IN_MEMORY_DATABASE);
    const auditLog = new AuditLog(
      handle,
      () => undefined,
      () => 1_000,
    );
    const recorded = Array.from({ length: 5 }, (_, index) =>
      auditLog.record({ actorKind: ACTOR_SYSTEM, actorLabel: `event ${index}`, action: AUDIT_ACTIONS.adminReset }),
    );
    const first = auditLog.recent(2);
    const second = auditLog.recent(2, first[1]);
    const third = auditLog.recent(2, second[1]);
    const seen = [...first, ...second, ...third].map((event) => event.id);
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(recorded));
    expect(auditLog.recent(2, third[0])).toEqual([]);
  });

  it("writes its stdout line once a transaction keeps the event, and none when the transaction is taken back", () => {
    const { handle, lines, auditLog } = setup();
    const entry = { actorKind: ACTOR_SYSTEM, actorLabel: "autoheal", action: AUDIT_ACTIONS.adminReset } as const;
    handle.atomically(() => {
      auditLog.record(entry);
      expect(lines).toEqual([]);
    });
    expect(lines).toHaveLength(1);
    expect(() =>
      handle.atomically(() => {
        auditLog.record(entry);
        throw new Error("refused part-way");
      }),
    ).toThrow("refused part-way");
    expect(lines).toHaveLength(1);
    expect(handle.database.select().from(auditEvents).all()).toHaveLength(1);
  });

  it("writes the same event to the database and to stdout", () => {
    const { handle, lines, auditLog } = setup();
    const id = auditLog.record({
      actorKind: ACTOR_SYSTEM,
      actorLabel: "autoheal",
      action: AUDIT_ACTIONS.adminBootstrapped,
      targetKind: "user",
      targetId: "u1",
      details: { username: "admin" },
    });
    const row = handle.database.select().from(auditEvents).get();
    expect(row).toMatchObject({ id, action: "user.admin_bootstrapped", targetId: "u1" });
    expect(JSON.parse(row!.detailsJson)).toEqual({ username: "admin" });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: "audit", id, details: { username: "admin" } });
  });

  it.each([[{ password: "x" }], [{ change: { newPassword: "x" } }], [{ totpCode: "123456" }], [{ runnerToken: "t" }]])(
    "refuses details that look like secrets where it is told to, as tests are: %j",
    (details) => {
      const { handle, lines, auditLog } = setup({ refuseSecretFields: true });
      expect(() =>
        auditLog.record({ actorKind: ACTOR_SYSTEM, actorLabel: "a", action: AUDIT_ACTIONS.adminReset, details }),
      ).toThrow(/may not carry secrets/);
      expect(handle.database.select().from(auditEvents).all()).toHaveLength(0);
      expect(lines).toHaveLength(0);
    },
  );

  // By the time it is recorded the action is done: a request that changed something must not fail over its record.
  it("leaves out what looks like a secret, at any depth, says which by name alone, and records the rest", () => {
    const { handle, lines, auditLog } = setup();
    const said = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const id = auditLog.record({
      actorKind: ACTOR_SYSTEM,
      actorLabel: "a",
      action: AUDIT_ACTIONS.adminReset,
      details: { url: "https://example.test", password: "hunter2", change: { newPassword: "hunter3", kept: 1 } },
    });
    const kept = { url: "https://example.test", change: { kept: 1 } };
    expect(JSON.parse(handle.database.select().from(auditEvents).get()!.detailsJson)).toEqual(kept);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id });
    expect(JSON.parse(lines[0]!).details).toEqual(kept);
    const warned = said.mock.calls.flat().join(" ");
    said.mockRestore();
    expect(warned).toContain("password");
    expect(warned).toContain("newPassword");
    expect(warned).not.toContain("hunter");
  });
});
