import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import { heartbeatWith } from "../../../test/support/inventory.js";
import { API_ROUTES, apiPath, type EnrolledHostView, type JobView } from "../../shared/api.js";
import {
  AUDIT_ACTIONS,
  DATABASE_FILE_NAME,
  JOB_ACTION,
  JOB_CANCELLED_BY_SELF_UPDATE_ROLLBACK,
  JOB_STATUS,
  SELF_UPDATE_STATUS,
  SELF_UPDATE_TEXT,
} from "../../shared/constants.js";
import { RUNNER_ROUTES } from "../../shared/protocol.js";
import { DatabaseHandle } from "../database/connection.js";
import { jobs } from "../database/schema.js";
import { AuditLog } from "../audit/audit-log.js";
import { SelfUpdateDatabaseFiles } from "./self-update-database.js";
import { SelfUpdateOutcomeFile, outcomeIn } from "./self-update-outcome.js";
import { settleSelfUpdateRollback } from "./self-update-settlement.js";

const OLD_IMAGE = `sha256:${"1".repeat(64)}`;
const NEW_IMAGE = `sha256:${"2".repeat(64)}`;

describe("an update of Autoheal that went back, and the work its replacement had dispatched", () => {
  let data: string;
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let token: string;
  let hostId: string;
  let outcomes: SelfUpdateOutcomeFile;

  beforeEach(async () => {
    data = mkdtempSync(join(tmpdir(), "autoheal-self-update-settle-"));
    controlPlane = await startTestControlPlane({ databasePath: join(data, DATABASE_FILE_NAME) });
    admin = (await fullySignedInAdmin(controlPlane)).client;
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    token = runnerTokenOf(enrolled);
    hostId = enrolled.host.id;
    outcomes = new SelfUpdateOutcomeFile(data);
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
    rmSync(data, { recursive: true, force: true });
  });

  // What the helper writes before the database file moves and before the old container is started again.
  const wentBack = (settled = false) =>
    outcomes.write(
      {
        status: SELF_UPDATE_STATUS.rolledBack,
        from: OLD_IMAGE,
        to: NEW_IMAGE,
        reference: "autoheal:local",
        startedAt: 1,
        finishedAt: 2,
        message: SELF_UPDATE_TEXT.notHealthy,
        recovery: null,
        dataRestored: true,
      },
      { settled },
    );

  // A runner reports the host, then collects whatever is waiting for it.
  const report = async () =>
    controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      payload: heartbeatWith({ dryRun: false }),
      headers: { authorization: `Bearer ${token}` },
    });
  // The runner's own call for what is waiting: the one that hands jobs out.
  const collected = async () => {
    const answer = await controlPlane.runnerApp.inject({
      method: "GET",
      url: RUNNER_ROUTES.work,
      headers: { authorization: `Bearer ${token}` },
    });
    return (answer.json<{ jobs?: { id: string }[] }>().jobs ?? []).map(({ id }) => id);
  };
  const askRestart = async (containerName: string) =>
    (
      await admin.post(apiPath(API_ROUTES.containerActions, { hostId, containerName }), {
        action: JOB_ACTION.restart,
      })
    ).json<JobView>();
  const settle = () =>
    settleSelfUpdateRollback(
      controlPlane.services.databaseHandle,
      outcomes,
      controlPlane.services.auditLog,
      controlPlane.clock.now,
    );
  const jobNow = (id: string) =>
    controlPlane.services.databaseHandle.database
      .select()
      .from(jobs)
      .all()
      .find((job) => job.id === id)!;
  const audit = async () => JSON.stringify((await admin.get(API_ROUTES.audit)).json());

  it("closes a job the hosts may already have carried out, rather than handing it out a second time", async () => {
    await report();
    const job = await askRestart("paperless");
    expect(await collected()).toContain(job.id);
    expect(jobNow(job.id).status).toBe(JOB_STATUS.delivered);
    wentBack();

    const settlement = settle();

    expect(settlement).toEqual({ cancelledIncidents: 0 });
    expect(jobNow(job.id)).toMatchObject({
      status: JOB_STATUS.expired,
      outcome: JOB_CANCELLED_BY_SELF_UPDATE_ROLLBACK,
    });
    // The runner asks again, as it does after the control plane restarts: nothing is handed to it.
    expect(await collected()).toEqual([]);
    expect(await audit()).toContain(AUDIT_ACTIONS.selfUpdateRollbackSettled);
  });

  it("closes one that was still waiting for its host too, so a restored row cannot be dispatched at all", async () => {
    await report();
    const job = await askRestart("paperless");
    expect(jobNow(job.id).status).toBe(JOB_STATUS.pending);
    wentBack();

    settle();

    expect(jobNow(job.id).status).toBe(JOB_STATUS.expired);
    expect(await collected()).toEqual([]);
  });

  it("settles once, and leaves work alone when no update put the database back", async () => {
    await report();
    const job = await askRestart("paperless");

    // No record at all, and a record of an update that did not touch the database: both leave the job waiting.
    expect(settle()).toBeNull();
    outcomes.write({
      status: SELF_UPDATE_STATUS.rolledBack,
      from: OLD_IMAGE,
      to: NEW_IMAGE,
      reference: "autoheal:local",
      startedAt: 1,
      finishedAt: 2,
      message: SELF_UPDATE_TEXT.notHealthy,
      recovery: null,
    });
    expect(settle()).toBeNull();
    expect(jobNow(job.id).status).toBe(JOB_STATUS.pending);

    wentBack();
    expect(settle()).not.toBeNull();
    expect(outcomeIn(outcomes.read())).toMatchObject({ dataRestored: true, settled: true });
    // A later start of the same control plane finds it done, and does not close newer work again.
    const after = await askRestart("paperless");
    expect(settle()).toBeNull();
    expect(jobNow(after.id).status).toBe(JOB_STATUS.pending);
  });

  it("settles an update once, even when a helper from before the mark was kept wrote its record over", async () => {
    await report();
    wentBack();
    expect(settle()).not.toBeNull();
    const after = await askRestart("paperless");
    // The same update written again without the mark, as a helper did at each step.
    wentBack();

    expect(settle()).toBeNull();
    expect(jobNow(after.id).status).toBe(JOB_STATUS.pending);
    expect(outcomeIn(outcomes.read())).toMatchObject({ dataRestored: true, settled: true });
  });

  it("keeps the mark through later writes of the same update, and starts a new update without it", () => {
    wentBack(true);
    const { audited: _audited, settled: _settled, ...same } = outcomeIn(outcomes.read())!;
    outcomes.write({ ...same, status: SELF_UPDATE_STATUS.failed, message: SELF_UPDATE_TEXT.startedOutside });
    expect(outcomeIn(outcomes.read())).toMatchObject({ status: SELF_UPDATE_STATUS.failed, settled: true });

    outcomes.write({ ...same, startedAt: 3, dataRestored: false });
    expect(outcomeIn(outcomes.read())!.settled).toBe(false);
  });

  it("takes a real rollback end to end: the answered job is waiting again, and the fence closes it", async () => {
    await report();
    const job = await askRestart("paperless");
    // The helper's copy, taken while the job is still waiting for its host.
    const files = new SelfUpdateDatabaseFiles(data);
    const snapshot = await files.snapshot();

    // The replacement collects the job, the host carries it out, and its answer is recorded; then the schema moves on.
    await collected();
    await controlPlane.runnerApp.inject({
      method: "POST",
      url: apiPath(RUNNER_ROUTES.jobResult, { jobId: job.id }),
      payload: { succeeded: true, outcome: "Restarted paperless.", output: null },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(jobNow(job.id)).toMatchObject({ status: JOB_STATUS.succeeded, outcome: "Restarted paperless." });
    const sqlite = controlPlane.services.databaseHandle.sqlite;
    sqlite.pragma(`user_version = ${(sqlite.pragma("user_version", { simple: true }) as number) + 1}`);
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
    controlPlane.services.databaseHandle.close();

    // Health fails: the helper puts the database back, having written the fence first.
    expect(files.restoreIfNeeded(snapshot)).toBe(true);
    wentBack();

    const handle = new DatabaseHandle(join(data, DATABASE_FILE_NAME));
    try {
      const restored = handle.database
        .select()
        .from(jobs)
        .all()
        .find((row) => row.id === job.id)!;
      // Without the fence this row is live again: the host would be asked to restart paperless a second time.
      expect(restored).toMatchObject({ status: JOB_STATUS.pending, outcome: null });

      expect(settleSelfUpdateRollback(handle, outcomes, new AuditLog(handle), 10)).toEqual({ cancelledIncidents: 0 });

      expect(
        handle.database
          .select()
          .from(jobs)
          .all()
          .find((row) => row.id === job.id),
      ).toMatchObject({
        status: JOB_STATUS.expired,
        outcome: JOB_CANCELLED_BY_SELF_UPDATE_ROLLBACK,
      });
    } finally {
      handle.close();
    }
  });
});
