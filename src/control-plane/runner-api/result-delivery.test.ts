import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestControlPlane } from "../../../test/support/control-plane.js";
import { guardStateFixture } from "../../../test/support/guard-state.js";
import { ResultJournal, type ResultKind, type ResultReport } from "../../runner/result-journal.js";
import { apiPath } from "../../shared/api.js";
import { sha256Hex } from "../../shared/hash.js";
import { RUNNER_ROUTES, type IncidentSubmission } from "../../shared/protocol.js";
import { approvals, hosts, incidentEvents, incidents, jobs, users, workItems } from "../database/schema.js";
import { ACTOR_HOST, AUDIT_ACTIONS, JOB_NO_ANSWER } from "../../shared/constants.js";
import { eq } from "drizzle-orm";

const submission: IncidentSubmission = {
  detectedAt: 1,
  report: {
    containerName: "app",
    image: "app:1",
    trigger: "die",
    stateSummary: "exited",
    healthOutputs: [],
    knownContainers: ["app"],
    protectedContainers: [],
    logs: "masked",
  },
};
const outcome = { outcome: "Restarted app.", verdict: "restarted" as const, executed: true };
const kinds: ResultKind[] = ["incident", "handled", "work", "job"];

describe("idempotent runner completion delivery", () => {
  let cp: TestControlPlane;
  let hostId: string;
  const token = "test-runner";
  beforeEach(async () => {
    cp = await startTestControlPlane();
    hostId = randomUUID();
    cp.services.databaseHandle.database
      .insert(users)
      .values({ id: randomUUID(), username: "admin", passwordHash: "fixture", role: "admin", createdAt: 1 })
      .run();
    cp.services.databaseHandle.database
      .insert(hosts)
      .values({ id: hostId, label: "fixture", tokenHash: sha256Hex(token), tokenHint: "hint", enrolledAt: 1 })
      .run();
  });
  afterEach(async () => {
    await cp.app.close();
    await cp.runnerApp.close();
    cp.services.databaseHandle.close();
  });

  async function prepared(kind: ResultKind, late = false) {
    const db = cp.services.databaseHandle.database;
    const id = randomUUID();
    const host = db.select().from(hosts).get()!;
    const incident = cp.services.incidentsService.create(host, submission, "deciding");
    let report: ResultReport;
    let url: string;
    if (kind === "handled") {
      report = {
        kind,
        id,
        result: {
          ...submission,
          resultId: id,
          decision: { action: "restart", target: "app", diagnosis: "crashed" },
          result: outcome,
        },
      };
      url = RUNNER_ROUTES.handledIncidents;
    } else if (kind === "incident") {
      report = { kind, id: incident.id, result: outcome };
      url = apiPath(RUNNER_ROUTES.incidentOutcome, { incidentId: incident.id });
    } else if (kind === "job") {
      db.insert(jobs)
        .values({
          id,
          hostId,
          containerName: "app",
          action: "restart",
          status: late ? "failed" : "delivered",
          outcome: late ? JOB_NO_ANSWER : null,
          createdAt: 1,
          expiresAt: 2,
          deliveredAt: 1,
        })
        .run();
      report = { kind, id, result: { succeeded: true, outcome: "Restarted app.", output: null } };
      url = apiPath(RUNNER_ROUTES.jobResult, { jobId: id });
    } else {
      const approvalId = randomUUID();
      db.insert(approvals)
        .values({
          id: approvalId,
          incidentId: incident.id,
          decidedBy: db.select().from(users).get()!.id,
          choice: "restart",
          decidedAt: 1,
        })
        .run();
      db.insert(workItems)
        .values({
          id,
          hostId,
          incidentId: incident.id,
          approvalId,
          action: "restart",
          target: "app",
          status: late ? "expired" : "delivered",
          createdAt: 1,
          expiresAt: 2,
          deliveredAt: 1,
        })
        .run();
      report = { kind, id, result: outcome };
      url = apiPath(RUNNER_ROUTES.workResult, { workItemId: id });
    }
    return { report, url };
  }
  const send = (url: string, payload: unknown, bearer = token) =>
    cp.runnerApp.inject({
      method: "POST",
      url,
      payload: JSON.stringify(payload),
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    });

  it.each(kinds)(
    "recovers a lost %s response after runner reconstruction with one execution and one receipt",
    async (kind) => {
      const { report, url } = await prepared(kind);
      const f = guardStateFixture();
      const journal = await ResultJournal.open(f.store);
      let executions = 0;
      if (await journal.reserve(kind, report.id)) executions++;
      await journal.complete(report);
      let attempts = 0;
      let firstBody = "";
      let eventCount = 0;
      const deliver = async (saved: ResultReport) => {
        const response = await send(url, saved.result);
        expect(response.statusCode).toBe(kind === "handled" ? 200 : 204);
        if (++attempts === 1) {
          firstBody = response.body;
          eventCount = cp.services.databaseHandle.database.select().from(incidentEvents).all().length;
          throw new Error("lost response after server commit");
        }
        expect(response.body).toBe(firstBody);
        expect(cp.services.databaseHandle.database.select().from(incidentEvents).all().length).toBe(eventCount);
      };
      await journal.flush(kinds, deliver);
      const restarted = await ResultJournal.open(f.store);
      if (await restarted.reserve(kind, report.id)) executions++;
      await restarted.flush(kinds, deliver);
      expect(attempts).toBe(2);
      expect(executions).toBe(1);
      expect(restarted.count(kinds)).toBe(0);
      expect(cp.services.databaseHandle.sqlite.prepare("SELECT count(*) AS n FROM runner_results").get()).toEqual({
        n: 1,
      });
      expect(cp.services.databaseHandle.sqlite.prepare("SELECT created_at FROM runner_results").get()).toEqual({
        created_at: cp.clock.now,
      });
      const changed =
        report.kind === "handled"
          ? { ...report.result, result: { ...outcome, outcome: "different" } }
          : { ...report.result, outcome: "different" };
      expect((await send(url, changed)).statusCode).toBe(409);
      expect((await send(url, report.result, "wrong-token")).statusCode).toBe(401);
    },
  );

  it("keeps an outcome for an incident this database no longer has, once, and takes it so it is not sent for ever", async () => {
    // As after a restore of a copy older than the incident.
    const gone = randomUUID();
    const url = apiPath(RUNNER_ROUTES.incidentOutcome, { incidentId: gone });
    const kept = () =>
      cp.services.auditLog.recent().filter(({ action }) => action === AUDIT_ACTIONS.incidentOutcomeKept);

    expect((await send(url, outcome)).statusCode).toBe(204);
    expect((await send(url, outcome)).statusCode).toBe(204);

    expect(kept()).toEqual([
      expect.objectContaining({ actorKind: ACTOR_HOST, actorLabel: "fixture", targetId: gone, details: outcome }),
    ]);
    expect((await send(url, { ...outcome, outcome: "different" })).statusCode).toBe(409);
  });

  it("still refuses an outcome for another host's incident, and keeps none of it", async () => {
    const db = cp.services.databaseHandle.database;
    const otherId = randomUUID();
    db.insert(hosts)
      .values({ id: otherId, label: "other", tokenHash: sha256Hex("other"), tokenHint: "other", enrolledAt: 1 })
      .run();
    const theirs = cp.services.incidentsService.create(
      db.select().from(hosts).where(eq(hosts.id, otherId)).get()!,
      submission,
      "deciding",
    );

    expect((await send(apiPath(RUNNER_ROUTES.incidentOutcome, { incidentId: theirs.id }), outcome)).statusCode).toBe(
      404,
    );
    expect(cp.services.auditLog.recent().map(({ action }) => action)).not.toContain(AUDIT_ACTIONS.incidentOutcomeKept);
  });

  it.each(["job", "work"] as const)("accepts delayed %s evidence after the missing-result timeout", async (kind) => {
    const { report, url } = await prepared(kind, true);
    expect((await send(url, report.result)).statusCode).toBe(204);
    expect((await send(url, report.result)).statusCode).toBe(204);
  });

  it("records a late approval result without overwriting a newer approval", async () => {
    const { report, url } = await prepared("work", true);
    const db = cp.services.databaseHandle.database;
    const old = db.select().from(workItems).where(eq(workItems.id, report.id)).get()!;
    db.insert(workItems)
      .values({ ...old, id: randomUUID(), status: "delivered", createdAt: old.createdAt + 1 })
      .run();
    db.update(incidents).set({ outcome: "newer decision" }).where(eq(incidents.id, old.incidentId)).run();
    expect((await send(url, report.result)).statusCode).toBe(204);
    expect(db.select().from(workItems).where(eq(workItems.id, old.id)).get()!.status).toBe("done");
    expect(db.select().from(incidents).where(eq(incidents.id, old.incidentId)).get()!.outcome).toBe("newer decision");
  });

  it("rolls back completion changes when receipt creation fails", () => {
    const sqlite = cp.services.databaseHandle.sqlite;
    sqlite.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON runner_results BEGIN SELECT RAISE(ABORT, 'full'); END");
    expect(() =>
      cp.services.resultReceipts.accept(hostId, "fixture", randomUUID(), outcome, () => {
        sqlite.prepare("UPDATE hosts SET label = 'changed' WHERE id = ?").run(hostId);
      }),
    ).toThrow("full");
    expect(cp.services.databaseHandle.database.select().from(hosts).where(eq(hosts.id, hostId)).get()!.label).toBe(
      "fixture",
    );
  });
});
