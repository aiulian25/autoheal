import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { startTestControlPlane } from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { API_ROUTES, DATA_KIND, type DataKind, type DataView } from "../../shared/api.js";
import {
  ACTION_RESTART,
  ACTOR_SYSTEM,
  AUDIT_ACTIONS,
  IN_MEMORY_DATABASE,
  INCIDENT_STATUS,
  JOB_ACTION,
  JOB_STATUS,
  MILLISECONDS_PER_DAY,
  REPLAY_FINISHED,
  RETENTION_SWEEP_BATCH_ROWS,
  ROLE_ADMIN,
  TASK_PRIORITY,
  TASK_SOURCE,
  TASK_STATUS,
  TRIGGER_UNHEALTHY,
  UPDATE_RUN_STATUS,
  WORK_ITEM_STATUS,
} from "../../shared/constants.js";
import { REBOOT_PLAN_STATUS, REBOOT_PLAN_UNREADABLE } from "../../shared/reboot-plans.js";
import { AuditLog } from "../audit/audit-log.js";
import { DatabaseHandle } from "./connection.js";
import { RetentionSweep } from "./retention-sweep.js";

const NOW = Date.UTC(2027, 5, 1);
const ago = (days: number) => NOW - days * MILLISECONDS_PER_DAY;

/** A fully migrated database with one host and one admin, and terse inserts for the records the sweep reads. */
function fixture() {
  const handle = new DatabaseHandle(IN_MEMORY_DATABASE);
  const sqlite = handle.sqlite;
  const run = (sql: string, ...values: unknown[]) => sqlite.prepare(sql).run(...values);
  run("INSERT INTO hosts (id, label, token_hash, token_hint, enrolled_at) VALUES ('host', 'Rowan', 'hash', 'hint', 0)");
  run(
    "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('admin', 'admin', 'hash', ?, 0)",
    ROLE_ADMIN,
  );
  let requests = 0;
  const seed = {
    receipt: (id: string, days: number) =>
      run(
        "INSERT INTO runner_results (id, host_id, payload_hash, response_json, created_at) VALUES (?, 'host', 'p', 'null', ?)",
        id,
        ago(days),
      ),
    auditEvent: (id: string, days: number) =>
      run(
        "INSERT INTO audit_events (id, occurred_at, actor_kind, actor_label, action) VALUES (?, ?, ?, 'autoheal', 'test.event')",
        id,
        ago(days),
        ACTOR_SYSTEM,
      ),
    incident: (id: string, status: string, days: number) => {
      run(
        "INSERT INTO incidents (id, host_id, container_name, image, trigger_event, detected_at, status, created_at, updated_at) VALUES (?, 'host', 'web', 'nginx', ?, ?, ?, ?, ?)",
        id,
        TRIGGER_UNHEALTHY,
        ago(days),
        status,
        ago(days),
        ago(days),
      );
      run("INSERT INTO incident_reports (incident_id, report_json) VALUES (?, '{}')", id);
      run("INSERT INTO incident_events (incident_id, kind, created_at) VALUES (?, 'detected', ?)", id, ago(days));
    },
    approvedWork: (incidentId: string, status: string) => {
      run(
        "INSERT INTO approvals (id, incident_id, decided_by, choice, decided_at) VALUES (?, ?, 'admin', ?, 0)",
        `approval-${incidentId}`,
        incidentId,
        ACTION_RESTART,
      );
      run(
        "INSERT INTO work_items (id, host_id, incident_id, approval_id, action, target, status, created_at, expires_at) VALUES (?, 'host', ?, ?, ?, 'web', ?, 0, 0)",
        `work-${incidentId}`,
        incidentId,
        `approval-${incidentId}`,
        ACTION_RESTART,
        status,
      );
    },
    task: (
      id: string,
      number: number,
      status: string,
      days: number,
      links: { parent?: string; incident?: string } = {},
    ) => {
      run(
        "INSERT INTO tasks (id, number, title, status, priority, source, parent_id, incident_id, created_at, updated_at, last_seen_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        number,
        id,
        status,
        TASK_PRIORITY.medium,
        TASK_SOURCE.manual,
        links.parent ?? null,
        links.incident ?? null,
        ago(days),
        ago(days),
        ago(days),
        status === TASK_STATUS.done || status === TASK_STATUS.cancelled ? ago(days) : null,
      );
      run(
        "INSERT INTO task_activity (task_id, kind, actor_label, created_at) VALUES (?, 'created', 'admin', ?)",
        id,
        ago(days),
      );
    },
    job: (id: string, status: string, days: number, taskId: string | null = null) =>
      run(
        "INSERT INTO jobs (id, host_id, task_id, container_name, action, status, created_at, expires_at, completed_at) VALUES (?, 'host', ?, 'web', ?, ?, ?, ?, ?)",
        id,
        taskId,
        JOB_ACTION.restart,
        status,
        ago(days),
        ago(days),
        status === JOB_STATUS.pending ? null : ago(days),
      ),
    // A saved reboot plan: its status is kept beside it, and its steps name the jobs it asked for.
    rebootPlan: (id: string, status: string, days: number, jobIds: readonly (string | null)[] = []) =>
      run(
        "INSERT INTO reboot_plans (id, created_at, updated_at, state_json, status) VALUES (?, ?, ?, ?, ?)",
        id,
        ago(days),
        ago(days),
        JSON.stringify({ id, status, steps: jobIds.map((jobId) => ({ jobId })) }),
        status,
      ),
    updateRun: (id: string, status: string, days: number, currentJobId: string | null = null) =>
      run(
        "INSERT INTO update_runs (id, host_id, names_json, status, current_job_id, created_at, updated_at) VALUES (?, 'host', '[]', ?, ?, ?, ?)",
        id,
        status,
        currentJobId,
        ago(days),
        ago(days),
      ),
    heldRollout: (id: string, jobId: string) =>
      run(
        "INSERT INTO rollouts (id, created_at, updated_at, state_json) VALUES (?, 0, 0, ?)",
        id,
        JSON.stringify({ status: "held", targets: [{ jobId }, { jobId: null }] }),
      ),
    replay: (id: string, days: number, incidentId: string) => {
      run(
        "INSERT INTO replay_runs (id, created_by, created_at, finished_at, status, model_name, incident_count) VALUES (?, 'admin', ?, ?, ?, 'qwen3', 1)",
        id,
        ago(days),
        ago(days),
        REPLAY_FINISHED,
      );
      run("INSERT INTO replay_results (replay_run_id, incident_id, changed) VALUES (?, ?, 0)", id, incidentId);
    },
    backupPlan: () =>
      run(
        "INSERT INTO application_backup_plans (id, host_id, revision, definition_json, enabled, created_at, updated_at) VALUES ('plan', 'host', 1, '{}', 0, 0, 0)",
      ),
    backupRun: (id: string, status: string, days: number, artifactId: string | null = null) =>
      run(
        "INSERT INTO application_backup_runs (id, plan_id, host_id, operation, status, task_json, request_key, artifact_id, created_at, finished_at) VALUES (?, 'plan', 'host', 'capture', ?, '{}', ?, ?, ?, ?)",
        id,
        status,
        `request-${(requests += 1)}`,
        artifactId,
        ago(days),
        ago(days),
      ),
    artifact: (id: string, captureRunId: string, status: string, key: string, days: number) =>
      run(
        "INSERT INTO application_backup_artifacts (id, plan_id, host_id, capture_run_id, key_ciphertext, recipient, status, created_at) VALUES (?, 'plan', 'host', ?, ?, 'age1recipient', ?, ?)",
        id,
        captureRunId,
        key,
        status,
        ago(days),
      ),
  };
  const auditLog = new AuditLog(
    handle,
    () => undefined,
    () => NOW,
  );
  return { handle, sqlite, seed, sweep: new RetentionSweep(handle, auditLog, () => NOW) };
}

const idsIn = (sqlite: Database.Database, table: string) =>
  (sqlite.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: string }[]).map((row) => row.id);
const countIn = (sqlite: Database.Database, table: string, column: string, id: string) =>
  (sqlite.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE ${column} = ?`).get(id) as { total: number }).total;

describe("the retention sweep", () => {
  it("removes finished records past their window and keeps what is recent, open or still named", () => {
    const { sqlite, seed, sweep } = fixture();
    seed.receipt("old-receipt", 181);
    seed.receipt("recent-receipt", 179);
    seed.auditEvent("years-old-audit", 2000);

    seed.incident("old-incident", INCIDENT_STATUS.resolved, 181);
    seed.approvedWork("old-incident", WORK_ITEM_STATUS.done);
    seed.incident("recent-incident", INCIDENT_STATUS.resolved, 179);
    seed.incident("waiting-incident", INCIDENT_STATUS.awaitingApproval, 400);
    seed.incident("tasked-incident", INCIDENT_STATUS.dismissed, 200);
    seed.incident("freed-incident", INCIDENT_STATUS.cancelled, 200);
    seed.incident("replayed-incident", INCIDENT_STATUS.resolved, 200);
    seed.incident("busy-incident", INCIDENT_STATUS.resolved, 200);
    seed.approvedWork("busy-incident", WORK_ITEM_STATUS.pending);

    seed.task("old-task", 1, TASK_STATUS.done, 181, { incident: "freed-incident" });
    seed.task("recent-task", 2, TASK_STATUS.cancelled, 179, { incident: "tasked-incident" });
    seed.task("open-task", 3, TASK_STATUS.todo, 400);
    seed.task("old-parent", 4, TASK_STATUS.done, 181);
    seed.task("open-child", 5, TASK_STATUS.inProgress, 181, { parent: "old-parent" });
    seed.task("newest-task", 6, TASK_STATUS.todo, 1);

    seed.job("old-job", JOB_STATUS.succeeded, 91);
    seed.job("recent-job", JOB_STATUS.failed, 89, "old-task");
    seed.job("open-job", JOB_STATUS.pending, 200);
    seed.job("run-job", JOB_STATUS.failed, 91);
    seed.job("rollout-job", JOB_STATUS.succeeded, 91);
    seed.updateRun("old-run", UPDATE_RUN_STATUS.finished, 91);
    seed.updateRun("running-run", UPDATE_RUN_STATUS.running, 200, "run-job");
    seed.heldRollout("held-rollout", "rollout-job");

    seed.replay("old-replay", 91, "old-incident");
    seed.replay("recent-replay", 89, "replayed-incident");

    seed.backupPlan();
    seed.backupRun("spent-capture", "succeeded", 91, "spent-artifact");
    seed.artifact("spent-artifact", "spent-capture", "failed", "", 91);
    seed.backupRun("kept-capture", "succeeded", 120, "kept-artifact");
    seed.artifact("kept-artifact", "kept-capture", "ready", "sealed-key", 120);
    seed.backupRun("old-drill", "failed", 91, "kept-artifact");
    seed.backupRun("named-capture", "succeeded", 120, "named-artifact");
    seed.artifact("named-artifact", "named-capture", "failed", "", 120);
    seed.backupRun("recent-drill", "succeeded", 10, "named-artifact");
    seed.backupRun("queued-run", "queued", 200);

    seed.rebootPlan("old-plan", REBOOT_PLAN_STATUS.completed, 91);
    seed.rebootPlan("cancelled-plan", REBOOT_PLAN_STATUS.cancelled, 91);
    seed.rebootPlan("recent-plan", REBOOT_PLAN_STATUS.completed, 89);
    seed.rebootPlan("running-plan", REBOOT_PLAN_STATUS.running, 400);
    seed.rebootPlan("paused-plan", REBOOT_PLAN_STATUS.paused, 400);
    // Cannot be read, so whether its reboot ever finished is unknown: it is never swept away.
    seed.rebootPlan("unreadable-plan", REBOOT_PLAN_UNREADABLE, 400);
    // Its job is still here, so the plan that asked for it stays too.
    seed.rebootPlan("job-plan", REBOOT_PLAN_STATUS.completed, 91, ["open-job"]);

    expect(sweep.sweep()).toEqual({
      runnerResults: 1,
      updateRuns: 1,
      jobs: 1,
      replayRuns: 1,
      tasks: 1,
      incidents: 2,
      applicationBackupArtifacts: 1,
      applicationBackupRuns: 2,
      rebootPlans: 2,
    });

    expect(idsIn(sqlite, "runner_results")).toEqual(["recent-receipt"]);
    expect(idsIn(sqlite, "audit_events")).toContain("years-old-audit");
    expect(idsIn(sqlite, "incidents")).toEqual([
      "busy-incident",
      "recent-incident",
      "replayed-incident",
      "tasked-incident",
      "waiting-incident",
    ]);
    expect(idsIn(sqlite, "tasks")).toEqual(["newest-task", "old-parent", "open-child", "open-task", "recent-task"]);
    expect(idsIn(sqlite, "jobs")).toEqual(["open-job", "recent-job", "rollout-job", "run-job"]);
    expect(idsIn(sqlite, "update_runs")).toEqual(["running-run"]);
    expect(idsIn(sqlite, "replay_runs")).toEqual(["recent-replay"]);
    expect(idsIn(sqlite, "application_backup_artifacts")).toEqual(["kept-artifact", "named-artifact"]);
    expect(idsIn(sqlite, "application_backup_runs")).toEqual([
      "kept-capture",
      "named-capture",
      "queued-run",
      "recent-drill",
    ]);

    expect(idsIn(sqlite, "reboot_plans")).toEqual([
      "job-plan",
      "paused-plan",
      "recent-plan",
      "running-plan",
      "unreadable-plan",
    ]);

    // What hung off the removed records went with them, and nothing was left pointing at a missing row.
    expect(countIn(sqlite, "incident_events", "incident_id", "old-incident")).toBe(0);
    expect(countIn(sqlite, "incident_reports", "incident_id", "old-incident")).toBe(0);
    expect(countIn(sqlite, "approvals", "incident_id", "old-incident")).toBe(0);
    expect(countIn(sqlite, "work_items", "incident_id", "old-incident")).toBe(0);
    expect(countIn(sqlite, "work_items", "incident_id", "busy-incident")).toBe(1);
    expect(countIn(sqlite, "task_activity", "task_id", "old-task")).toBe(0);
    expect(countIn(sqlite, "replay_results", "replay_run_id", "old-replay")).toBe(0);
    expect(sqlite.prepare("SELECT task_id FROM jobs WHERE id = 'recent-job'").get()).toEqual({ task_id: null });
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
  });

  it("never lets a new task take an old task's number", () => {
    const { sqlite, seed, sweep } = fixture();
    seed.task("first", 1, TASK_STATUS.done, 400);
    seed.task("last", 2, TASK_STATUS.done, 400);
    expect(sweep.sweep()).toMatchObject({ tasks: 1 });
    expect(idsIn(sqlite, "tasks")).toEqual(["last"]);
  });

  it("works through more rows than one batch holds", () => {
    const { sqlite, seed, sweep } = fixture();
    const expired = RETENTION_SWEEP_BATCH_ROWS * 2 + 7;
    for (let index = 0; index < expired; index += 1) seed.receipt(`receipt-${index}`, 200);
    seed.receipt("fresh", 1);
    expect(sweep.sweep()).toMatchObject({ runnerResults: expired });
    expect(idsIn(sqlite, "runner_results")).toEqual(["fresh"]);
  });

  it("says in the audit log what it removed, and stays quiet once nothing is due", () => {
    const { sqlite, seed, sweep } = fixture();
    seed.receipt("old-receipt", 181);
    sweep.sweep();
    const recorded = () =>
      sqlite
        .prepare("SELECT details_json AS details FROM audit_events WHERE action = ?")
        .all(AUDIT_ACTIONS.retentionSwept) as { details: string }[];
    expect(recorded()).toHaveLength(1);
    expect(JSON.parse(recorded()[0]!.details)).toMatchObject({ removed: { runnerResults: 1, jobs: 0 } });

    expect(Object.values(sweep.sweep()).every((count) => count === 0)).toBe(true);
    expect(recorded()).toHaveLength(1);
  });

  it("says what the database holds, how long it keeps each kind, and when it last cleaned up", () => {
    const { seed, sweep } = fixture();
    seed.receipt("old-receipt", 181);
    seed.receipt("fresh-receipt", 1);
    const kind = (view: DataView, name: DataKind) => view.kinds.find((each) => each.kind === name)!;
    const before = sweep.view();
    expect(before.bytes).toBeGreaterThan(0);
    expect(before.lastSweep).toBeNull();
    expect(before.kinds.map((each) => each.kind)).toEqual(Object.values(DATA_KIND));
    expect(kind(before, DATA_KIND.runnerResults)).toEqual({
      kind: DATA_KIND.runnerResults,
      rows: 2,
      keptMilliseconds: 180 * MILLISECONDS_PER_DAY,
    });
    expect(kind(before, DATA_KIND.auditEvents).keptMilliseconds).toBeNull();

    sweep.sweep();
    const after = sweep.view();
    expect(kind(after, DATA_KIND.runnerResults).rows).toBe(1);
    expect(after.lastSweep).toEqual({ at: NOW, removed: 1 });
    // The sweep's own entry: the audit log only grows.
    expect(kind(after, DATA_KIND.auditEvents).rows).toBe(kind(before, DATA_KIND.auditEvents).rows + 1);
  });

  it("shows administrators what the database holds, and nobody else", async () => {
    const controlPlane = await startTestControlPlane();
    const admin = (await fullySignedInAdmin(controlPlane)).client;
    const viewer = (await fullySignedInUser(controlPlane, admin, "observer", "viewer")).client;
    controlPlane.services.retentionSweep.sweep();
    const answer = await admin.get(API_ROUTES.dataHousekeeping);
    expect(answer.statusCode).toBe(200);
    expect(answer.json<DataView>()).toMatchObject({ lastSweep: { at: controlPlane.clock.now, removed: 0 } });
    expect((await viewer.get(API_ROUTES.dataHousekeeping)).statusCode).toBe(403);
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  it("runs as one of the control plane's services", async () => {
    const controlPlane = await startTestControlPlane();
    const sqlite = controlPlane.services.databaseHandle.sqlite;
    sqlite
      .prepare(
        "INSERT INTO hosts (id, label, token_hash, token_hint, enrolled_at) VALUES ('host', 'Rowan', 'h', 'h', 0)",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO runner_results (id, host_id, payload_hash, response_json, created_at) VALUES ('old', 'host', 'p', 'null', ?)",
      )
      .run(controlPlane.clock.now - 181 * MILLISECONDS_PER_DAY);
    expect(controlPlane.services.retentionSweep.sweep()).toMatchObject({ runnerResults: 1 });
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });
});
