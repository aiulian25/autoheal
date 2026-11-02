import { hosts } from "../database/schema.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startTestControlPlane,
  runnerTokenOf,
  TEST_BACKUP_PASSPHRASE,
  type TestControlPlane,
  type TestClient,
} from "../../../test/support/control-plane.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import { heartbeatWith, containerSnapshot } from "../../../test/support/inventory.js";
import { API_ERRORS, API_ROUTES, apiPath, type EnrolledHostView } from "../../shared/api.js";
import { RUNNER_ROUTES } from "../../shared/protocol.js";
import { HTTP_STATUS, ROLE_VIEWER, TAR, USER_STATUS_DEACTIVATED } from "../../shared/constants.js";
import { singleEntryArchive } from "../../runner/tar.js";
import type { HostRow } from "../hosts/hosts-service.js";
import { applicationBackupTaskSchema } from "../../shared/application-backups.js";
import {
  APPLICATION_BACKUP_FAILURE,
  APPLICATION_BACKUPS,
  type ApplicationBackupResult,
} from "../../shared/application-backups.js";
import { ApplicationPlansService } from "./application-plans-service.js";
const definition = {
  version: 1,
  name: "Shared fixture",
  containerName: "app",
  consistency: "coordinated-clean-stop",
  exclusiveDockerWriters: true,
  sqlite: null,
  intervalHours: 1,
  retain: 2,
};
describe("durable application backup plans", () => {
  let plane: TestControlPlane, admin: TestClient, hostId: string;
  const service = () => plane.services.applicationBackups;
  const actor = () => ({
    userId: plane.services.databaseHandle.sqlite.prepare("SELECT id FROM users WHERE username='admin'").get() as {
      id: string;
    },
    username: "admin",
    ip: "127.0.0.1",
    requestId: randomUUID(),
  });
  function person() {
    const a = actor();
    return { ...a, userId: a.userId.id };
  }
  function host() {
    return plane.services.databaseHandle.database
      .select()
      .from(hosts)
      .all()
      .find((h) => h.id === hostId)! as HostRow;
  }
  beforeEach(async () => {
    plane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(plane)).client;
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "App-lab" })).json<EnrolledHostView>();
    hostId = enrolled.host.id;
    await plane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      headers: {
        authorization: `Bearer ${runnerTokenOf(enrolled)}`,
        "x-autoheal-capabilities": "application-backups,operation-previews,resource-permissions",
      },
      payload: {
        ...heartbeatWith({ dryRun: false, containerAccess: false, containers: [containerSnapshot({ name: "app" })] }),
        applicationBackups: true,
      },
    });
  });
  afterEach(async () => {
    await plane.app.close();
    await plane.runnerApp.close();
  });
  async function plan() {
    const response = await admin.post(API_ROUTES.applicationBackups, { hostId, definition, enabled: true });
    expect(response.statusCode).toBe(200);
    return service().view().plans[0]!.id;
  }
  async function captured() {
    const id = await plan(),
      run = await service().run(person(), id, { operation: "capture", requestKey: randomUUID() }),
      tasks = await service().take(host());
    const task = tasks[0]!;
    const cipher = Buffer.from("age-encryption.org/v1\nsynthetic-encrypted-placeholder"),
      archive = singleEntryArchive({ name: "payload.age", type: TAR.types.file, mode: 0o600, uid: 0, gid: 0 }, cipher);
    await service().upload(host(), run.id, task.artifactId, Readable.from([archive]));
    const result: ApplicationBackupResult = {
      id: run.id,
      artifactId: task.artifactId,
      ok: true,
      message: "captured",
      writers: ["app", "worker"],
      stopped: [],
      payloadBytes: archive.length,
      payloadSha256: createHash("sha256").update(archive).digest("hex"),
      integrity: "metadata-verified",
      fingerprint: "a".repeat(64),
    };
    await service().complete(host(), result);
    return { id, run, task, result };
  }
  it("claims once, acknowledges duplicate results and binds artifacts to the reporting host", async () => {
    const { run, task, result } = await captured();
    expect(await service().take(host())).toEqual([]);
    expect(await service().complete(host(), result)).toEqual({ ok: true });
    await expect(service().complete({ ...host(), id: randomUUID() }, result)).rejects.toThrow();
    const saved = plane.services.databaseHandle.sqlite
      .prepare("SELECT * FROM application_backup_runs WHERE id=?")
      .get(run.id) as { task_json: string };
    expect(saved.task_json).not.toContain("AGE-SECRET-KEY");
    expect(JSON.stringify(service().view())).not.toContain("key_ciphertext");
    expect(task.identity).toBeUndefined();
  });
  it("materializes drill identity only in the bound runner response, never persisted or displayed", async () => {
    const { id, task } = await captured();
    const drill = await service().run(person(), id, {
      operation: "drill",
      artifactId: task.artifactId,
      requestKey: randomUUID(),
    });
    const delivery = (await service().take(host()))[0]!;
    expect(delivery.identity).toMatch(/^AGE-SECRET-KEY-/u);
    const row = plane.services.databaseHandle.sqlite
      .prepare("SELECT task_json FROM application_backup_runs WHERE id=?")
      .get(drill.id) as { task_json: string };
    expect(row.task_json).not.toContain(delivery.identity);
    expect(JSON.stringify(service().view())).not.toContain(delivery.identity);
    expect(
      JSON.stringify(plane.services.databaseHandle.sqlite.prepare("SELECT details_json FROM audit_events").all()),
    ).not.toContain(delivery.identity);
  });
  describe("boot drills", () => {
    const IMAGE = "sha256:backed-up";
    const TEST_VALUE = "a-test-value";
    const recipe = { readySeconds: 30, environment: [{ name: "MODE", value: TEST_VALUE }] };
    const planWith = async (bootDrill: typeof recipe | null) => {
      const response = await admin.post(API_ROUTES.applicationBackups, {
        hostId,
        definition: { ...definition, bootDrill },
        enabled: true,
      });
      expect(response.statusCode, response.body).toBe(200);
      return service().view().plans[0]!.id;
    };
    const capture = async (id: string, imageId: string | null = IMAGE) => {
      const run = await service().run(person(), id, { operation: "capture", requestKey: randomUUID() });
      const [task] = await service().take(host());
      const cipher = Buffer.from("age-encryption.org/v1\nsynthetic-encrypted-placeholder");
      const archive = singleEntryArchive(
        { name: "payload.age", type: TAR.types.file, mode: 0o600, uid: 0, gid: 0 },
        cipher,
      );
      await service().upload(host(), run.id, task!.artifactId, Readable.from([archive]));
      await service().complete(host(), {
        id: run.id,
        artifactId: task!.artifactId,
        ok: true,
        message: "captured",
        writers: ["app"],
        stopped: [],
        payloadBytes: archive.length,
        payloadSha256: createHash("sha256").update(archive).digest("hex"),
        integrity: "metadata-verified",
        ...(imageId === null ? {} : { imageId }),
      });
      return task!;
    };
    const capable = () => ({ ...host(), applicationBootDrills: true });
    const artifactOf = (artifactId: string) =>
      service()
        .view()
        .artifacts.find(({ id }) => id === artifactId)!;
    const asked = (id: string, artifactId: string) =>
      service().run(person(), id, { operation: "boot-drill", artifactId, requestKey: randomUUID() });
    const finish = (runId: string, artifactId: string, ok: boolean) =>
      service().complete(host(), {
        id: runId,
        artifactId,
        ok,
        message: ok ? "started" : "did not start",
        writers: ["app"],
        stopped: [],
        boot: {
          imageId: IMAGE,
          readySeconds: 30,
          readiness: ok ? "healthy" : null,
          problem: ok ? null : "it stopped (exit 3)",
          logs: null,
          left: [],
        },
      });

    it("is refused for a plan that did not ask for it", async () => {
      const id = await planWith(null);
      const task = await capture(id);
      await expect(asked(id, task.artifactId)).rejects.toThrow();
    });

    it("is refused for a backup that recorded no image", async () => {
      const id = await planWith(recipe);
      const task = await capture(id, null);
      expect(artifactOf(task.artifactId).imageId).toBeNull();
      await expect(asked(id, task.artifactId)).rejects.toThrow();
    });

    it("goes only to a runner that can do it, with the key and the image, its key never kept", async () => {
      const id = await planWith(recipe);
      const { artifactId } = await capture(id);
      const run = await asked(id, artifactId);
      expect(await service().take(host())).toEqual([]);
      const [delivered] = await service().take(capable());
      expect(delivered).toMatchObject({ id: run.id, operation: "boot-drill", imageId: IMAGE });
      expect(delivered!.identity).toMatch(/^AGE-SECRET-KEY-/u);
      expect(delivered!.definition.bootDrill).toEqual(recipe);
      expect(JSON.stringify(service().view())).not.toContain(delivered!.identity);
    });

    it("sends other tasks none of the recipe, as an older runner reads them strictly", async () => {
      const id = await planWith(recipe);
      const run = await service().run(person(), id, { operation: "capture", requestKey: randomUUID() });
      const [task] = await service().take(host());
      expect(task?.id).toBe(run.id);
      expect(JSON.stringify(task)).not.toContain(TEST_VALUE);
      expect(task!.definition).not.toHaveProperty("bootDrill");
      expect(applicationBackupTaskSchema.safeParse(task).success).toBe(true);
    });

    it("marks the backup only when the application started, keeping integrity's mark apart", async () => {
      const id = await planWith(recipe);
      const { artifactId } = await capture(id);
      const run = await asked(id, artifactId);
      await service().take(capable());
      await finish(run.id, artifactId, true);
      expect(artifactOf(artifactId)).toMatchObject({ imageId: IMAGE, lastDrillAt: null, status: "ready" });
      expect(artifactOf(artifactId).bootVerifiedAt).not.toBeNull();
    });

    it("does not mark a backup whose application only stayed up, as that is no proof", async () => {
      const id = await planWith(recipe);
      const { artifactId } = await capture(id);
      const before = artifactOf(artifactId);
      const run = await asked(id, artifactId);
      await service().take(capable());
      service().complete(host(), {
        id: run.id,
        artifactId,
        ok: true,
        message: "stayed up",
        writers: ["app"],
        stopped: [],
        boot: { imageId: IMAGE, readySeconds: 30, readiness: "stayed-running", problem: null, logs: null, left: [] },
      });
      expect(artifactOf(artifactId)).toEqual(before);
      const finished = service()
        .view()
        .runs.find(({ id: runId }) => runId === run.id)!;
      expect(finished.status).toBe("succeeded");
    });

    it("leaves a backup as it was when the application would not start, the evidence kept", async () => {
      const id = await planWith(recipe);
      const { artifactId } = await capture(id);
      const before = artifactOf(artifactId);
      const run = await asked(id, artifactId);
      await service().take(capable());
      await finish(run.id, artifactId, false);
      expect(artifactOf(artifactId)).toEqual(before);
      const finished = service()
        .view()
        .runs.find(({ id: runId }) => runId === run.id)!;
      expect(finished.status).toBe("failed");
      expect(finished.result?.boot?.problem).toBe("it stopped (exit 3)");
    });
  });

  it("requires one fresh session-bound app writer preview before queuing live restoration", async () => {
    const { id, task } = await captured();
    const preview = await service().prepareRestore(person(), "session-a", id, task.artifactId);
    const delivered = (await service().take(host()))[0]!;
    expect(delivered.operation).toBe("preview");
    await service().complete(host(), {
      id: preview.id,
      artifactId: task.artifactId,
      ok: true,
      message: "review",
      writers: ["app", "worker"],
      stopped: [],
      fingerprint: "a".repeat(64),
    });
    await expect(
      service().restore(person(), "session-b", id, {
        artifactId: task.artifactId,
        previewRunId: preview.id,
        requestKey: randomUUID(),
      }),
    ).rejects.toThrow();
    const restore = await service().restore(person(), "session-a", id, {
      artifactId: task.artifactId,
      previewRunId: preview.id,
      requestKey: randomUUID(),
    });
    const next = (await service().take(host()))[0]!;
    expect(next).toMatchObject({ id: restore.id, operation: "restore", expectedFingerprint: "a".repeat(64) });
    expect(next.safetyArtifactId).not.toBe(task.artifactId);
    await expect(
      service().restore(person(), "session-a", id, {
        artifactId: task.artifactId,
        previewRunId: preview.id,
        requestKey: randomUUID(),
      }),
    ).rejects.toThrow();
  });
  it("rejects plaintext or multi-entry archives before storing a successful artifact", async () => {
    const id = await plan();
    const run = await service().run(person(), id, { operation: "capture", requestKey: randomUUID() });
    const task = (await service().take(host()))[0]!;
    const archive = singleEntryArchive(
      { name: "payload.age", type: TAR.types.file, mode: 0o600, uid: 0, gid: 0 },
      Buffer.from("plaintext application file contents should never be accepted"),
    );
    await expect(service().upload(host(), run.id, task.artifactId, Readable.from([archive]))).rejects.toThrow();
  });
  it("turns a lost claim into explicit recovery and rejects a late result from the previous attempt", async () => {
    const id = await plan();
    const run = await service().run(person(), id, { operation: "capture", requestKey: randomUUID() });
    const original = (await service().take(host()))[0]!;
    plane.clock.now += 15 * 60000 + 1;
    expect(
      service()
        .view()
        .runs.find((item) => item.id === run.id)?.status,
    ).toBe("recovery-required");
    plane.services.databaseHandle.sqlite
      .prepare("UPDATE hosts SET last_heartbeat_at=? WHERE id=?")
      .run(plane.clock.now, hostId);
    service().resume(person(), run.id);
    const resumed = (await service().take(host()))[0]!;
    expect(resumed.attempt).toBe(1);
    await expect(
      service().complete(host(), {
        id: run.id,
        attempt: original.attempt,
        artifactId: original.artifactId,
        ok: false,
        message: "late old report",
        writers: ["app"],
        stopped: [],
      }),
    ).rejects.toThrow("result_conflict");
    await service().complete(host(), {
      id: run.id,
      attempt: resumed.attempt,
      artifactId: resumed.artifactId,
      ok: false,
      message: "new attempt settled",
      writers: ["app"],
      stopped: [],
    });
    expect(
      service()
        .view()
        .runs.find((item) => item.id === run.id)?.result?.message,
    ).toBe("new attempt settled");
  });
  it("refuses delivery after the requesting admin loses authority, and says so", async () => {
    const id = await plan();
    await service().run(person(), id, { operation: "capture", requestKey: randomUUID() });
    plane.services.databaseHandle.sqlite.prepare("UPDATE users SET role='viewer' WHERE id=?").run(person().userId);
    expect(await service().take(host())).toEqual([]);
    expect(service().view().runs[0]).toMatchObject({
      status: "failed",
      result: null,
      failure: APPLICATION_BACKUP_FAILURE.requesterLostAccess,
    });
  });
  it.each([
    ["must change their password", "must_change_password=1", HTTP_STATUS.forbidden, API_ERRORS.passwordChangeRequired],
    ["has no two-step sign-in", "totp_enabled=0", HTTP_STATUS.forbidden, API_ERRORS.totpSetupRequired],
    ["is no longer an admin", `role='${ROLE_VIEWER}'`, HTTP_STATUS.forbidden, API_ERRORS.adminOnly],
    ["was deactivated", `status='${USER_STATUS_DEACTIVATED}'`, HTTP_STATUS.unauthorized, API_ERRORS.notSignedIn],
  ])("refuses a run asked for by an admin who %s, before any run exists", async (_case, change, status, error) => {
    const id = await plan();
    plane.services.databaseHandle.sqlite.prepare(`UPDATE users SET ${change} WHERE username='admin'`).run();
    const response = await admin.post(apiPath(API_ROUTES.applicationBackupRun, { planId: id }), {
      operation: "capture",
      requestKey: randomUUID(),
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error });
    expect(service().view().runs).toEqual([]);
  });
  it("says why a scheduled capture was dropped when its plan was turned off before the runner collected it", async () => {
    const id = await plan();
    plane.services.databaseHandle.sqlite
      .prepare("UPDATE application_backup_plans SET next_due_at=? WHERE id=?")
      .run(plane.clock.now, id);
    await service().schedule();
    expect(service().view().runs[0]?.status).toBe("queued");
    service().save(person(), { id, revision: 1, hostId, definition, enabled: false });
    expect(await service().take(host())).toEqual([]);
    expect(service().view().runs[0]).toMatchObject({
      status: "failed",
      result: null,
      failure: APPLICATION_BACKUP_FAILURE.planChanged,
    });
  });
  it("says why a run was dropped when its runner did not collect it in time", async () => {
    const id = await plan();
    await service().run(person(), id, { operation: "capture", requestKey: randomUUID() });
    plane.clock.now += APPLICATION_BACKUPS.taskMilliseconds;
    expect(await service().take(host())).toEqual([]);
    expect(service().view().runs[0]).toMatchObject({
      status: "failed",
      result: null,
      failure: APPLICATION_BACKUP_FAILURE.expired,
    });
  });
  it("hands a runner no run while its task is still being written, and the task once it is", async () => {
    const id = await plan();
    // The run's row is in before its key is made and its task written: a poll can come in between.
    const preparing = service().run(person(), id, { operation: "capture", requestKey: randomUUID() });
    expect(service().view().runs[0]).toMatchObject({ status: "queued" });
    await expect(service().take(host())).resolves.toEqual([]);
    const run = await preparing;
    expect(await service().take(host())).toMatchObject([{ id: run.id, operation: "capture" }]);
  });
  it("ends a run nobody collected once its window has passed, poll or none, and lets its key go", async () => {
    const id = await plan();
    const run = await service().run(person(), id, { operation: "capture", requestKey: randomUUID() });
    const sqlite = plane.services.databaseHandle.sqlite;
    const artifactOf = (runId: string) =>
      sqlite
        .prepare(
          "SELECT a.status, a.key_ciphertext AS key FROM application_backup_artifacts a JOIN application_backup_runs r ON r.artifact_id=a.id WHERE r.id=?",
        )
        .get(runId) as { status: string; key: string };
    // One still being prepared, as a run is between its row and its task: it has no window yet, so it is left alone.
    const preparing = randomUUID();
    sqlite
      .prepare(
        "INSERT INTO application_backup_runs(id,plan_id,host_id,operation,status,task_json,request_key,created_at) VALUES(?,?,?,'capture','queued','{}',?,?)",
      )
      .run(preparing, id, hostId, randomUUID(), plane.clock.now);

    plane.clock.now += APPLICATION_BACKUPS.taskMilliseconds;
    // No poll: the runner may never ask again.
    const runs = service().view().runs;
    expect(runs.find((each) => each.id === run.id)).toMatchObject({
      status: "failed",
      result: null,
      failure: APPLICATION_BACKUP_FAILURE.expired,
    });
    expect(runs.find((each) => each.id === preparing)).toMatchObject({ status: "queued", failure: null });
    expect(artifactOf(run.id).status).toBe("pending");

    // The next scheduling pass lets its pending artifact and key go.
    await service().schedule();
    expect(artifactOf(run.id)).toEqual({ status: "failed", key: "" });
  });
  it("says why a run never started when the dashboard could not save its encryption key", async () => {
    const id = await plan();
    // A file where the data folder should be: nothing can be written under it.
    const dataDirectory = join(mkdtempSync(join(tmpdir(), "autoheal-data-")), "not-a-folder");
    writeFileSync(dataDirectory, "");
    const unwritable = new ApplicationPlansService(
      plane.services.databaseHandle,
      { dataDirectory, offboxBackupDirectory: null, backupPassphrase: TEST_BACKUP_PASSPHRASE },
      { wake: () => {} },
      plane.services.auditLog,
      () => plane.clock.now,
    );
    await expect(unwritable.run(person(), id, { operation: "capture", requestKey: randomUUID() })).rejects.toThrow();
    expect(service().view().runs[0]).toMatchObject({
      status: "failed",
      result: null,
      failure: APPLICATION_BACKUP_FAILURE.notPrepared,
    });
  });
  it("rejects an old artifact after the plan target changes even with a new review", async () => {
    const { id, task } = await captured();
    service().save(person(), {
      id,
      revision: 1,
      hostId,
      definition: { ...definition, containerName: "other" },
      enabled: true,
    });
    const preview = await service().prepareRestore(person(), "same-session", id, task.artifactId);
    await service().take(host());
    await service().complete(host(), {
      id: preview.id,
      artifactId: task.artifactId,
      ok: true,
      message: "review",
      writers: ["other"],
      stopped: [],
      fingerprint: "a".repeat(64),
    });
    await expect(
      service().restore(person(), "same-session", id, {
        artifactId: task.artifactId,
        previewRunId: preview.id,
        requestKey: randomUUID(),
      }),
    ).rejects.toThrow();
  });
  it("keeps a failed restore resumable even when no writer was originally running", async () => {
    const { id, task } = await captured();
    const preview = await service().prepareRestore(person(), "empty-running-set", id, task.artifactId);
    await service().take(host());
    await service().complete(host(), {
      id: preview.id,
      artifactId: task.artifactId,
      ok: true,
      message: "review",
      writers: ["app"],
      stopped: [],
      fingerprint: "a".repeat(64),
    });
    const restore = await service().restore(person(), "empty-running-set", id, {
      artifactId: task.artifactId,
      previewRunId: preview.id,
      requestKey: randomUUID(),
    });
    const delivery = (await service().take(host()))[0]!;
    await service().complete(host(), {
      id: restore.id,
      attempt: delivery.attempt,
      artifactId: task.artifactId,
      ok: false,
      recoveryRequired: true,
      message: "partial restore",
      writers: ["app"],
      stopped: [],
    });
    expect(
      service()
        .view()
        .runs.find((item) => item.id === restore.id)?.status,
    ).toBe("recovery-required");
    expect(service().resume(person(), restore.id)).toEqual({ id: restore.id });
  });
});
