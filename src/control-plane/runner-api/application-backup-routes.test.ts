import { randomUUID, createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startTestControlPlane,
  runnerTokenOf,
  type TestControlPlane,
  type TestClient,
} from "../../../test/support/control-plane.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import { heartbeatWith, containerSnapshot } from "../../../test/support/inventory.js";
import { API_ROUTES, apiPath, type EnrolledHostView } from "../../shared/api.js";
import { HTTP_HEADERS, TAR, TAR_CONTENT_TYPE } from "../../shared/constants.js";
import { RUNNER_ROUTES } from "../../shared/protocol.js";
import type { ApplicationBackupTask } from "../../shared/application-backups.js";
import { singleEntryArchive } from "../../runner/tar.js";
const definition = {
  version: 1,
  name: "HTTP app fixture",
  containerName: "app",
  consistency: "coordinated-clean-stop",
  exclusiveDockerWriters: true,
  sqlite: null,
  intervalHours: null,
  retain: 2,
};
const archive = () =>
  singleEntryArchive(
    { name: "payload.age", type: TAR.types.file, mode: 0o600, uid: 0, gid: 0 },
    Buffer.from("age-encryption.org/v1\nsynthetic encrypted app fixture"),
  );
describe("assembled application runner routes", () => {
  let plane: TestControlPlane, admin: TestClient, hostId: string, token: string, otherToken: string;
  const headers = (bearer = token, capable = true) => ({
    authorization: `Bearer ${bearer}`,
    ...(capable ? { [HTTP_HEADERS.runnerCapabilities]: "application-backups" } : {}),
  });
  const upload = (task: ApplicationBackupTask) =>
    apiPath(RUNNER_ROUTES.applicationBackupUpload, { taskId: task.id, artifactId: task.artifactId }) +
    `?attempt=${task.attempt}`;
  const download = (task: ApplicationBackupTask) =>
    apiPath(RUNNER_ROUTES.applicationBackupDownload, { taskId: task.id, artifactId: task.artifactId }) +
    `?attempt=${task.attempt}`;
  async function enqueue() {
    expect((await admin.post(API_ROUTES.applicationBackups, { hostId, definition, enabled: true })).statusCode).toBe(
      200,
    );
    const plan = plane.services.applicationBackups.view().plans[0]!;
    const response = await admin.post(apiPath(API_ROUTES.applicationBackupRun, { planId: plan.id }), {
      operation: "capture",
      requestKey: randomUUID(),
    });
    expect(response.statusCode, response.body).toBe(200);
    return { planId: plan.id, id: response.json<{ id: string }>().id };
  }
  async function take(bearer = token, capable = true) {
    return (
      await plane.runnerApp.inject({
        method: "GET",
        url: RUNNER_ROUTES.applicationBackupWork,
        headers: headers(bearer, capable),
      })
    ).json<{ tasks: ApplicationBackupTask[] }>().tasks;
  }
  beforeEach(async () => {
    plane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(plane)).client;
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "HTTP-app" })).json<EnrolledHostView>();
    hostId = enrolled.host.id;
    token = runnerTokenOf(enrolled);
    otherToken = runnerTokenOf((await admin.post(API_ROUTES.hosts, { label: "Other-app" })).json<EnrolledHostView>());
    for (const bearer of [token, otherToken])
      expect(
        (
          await plane.runnerApp.inject({
            method: "POST",
            url: RUNNER_ROUTES.heartbeat,
            headers: headers(bearer),
            payload: {
              ...heartbeatWith({ dryRun: false, containers: [containerSnapshot({ name: "app" })] }),
              applicationBackups: true,
            },
          })
        ).statusCode,
      ).toBe(200);
  });
  afterEach(async () => {
    await plane.app.close();
    await plane.runnerApp.close();
  });
  it("authenticates every endpoint and never hands marked tasks to a downgraded reader", async () => {
    const run = await enqueue();
    expect(await take(token, false)).toEqual([]);
    expect(await take(otherToken)).toEqual([]);
    const [task] = await take();
    expect(task).toMatchObject({ id: run.id, hostId, operation: "capture", attempt: 0 });
    expect(await take()).toEqual([]);
    for (const [method, url, payload] of [
      ["GET", RUNNER_ROUTES.applicationBackupWork, undefined],
      ["POST", RUNNER_ROUTES.applicationBackupAuthorization.replace(":taskId", task!.id), { attempt: 0 }],
      ["POST", RUNNER_ROUTES.applicationBackupResult, { id: task!.id }],
      ["POST", upload(task!), archive()],
      ["GET", download(task!), undefined],
    ] as const) {
      const response = await plane.runnerApp.inject({
        method,
        url,
        payload,
        headers: method === "POST" && Buffer.isBuffer(payload) ? { [HTTP_HEADERS.contentType]: TAR_CONTENT_TYPE } : {},
      });
      expect(response.statusCode).toBe(401);
    }
    expect(
      (
        await plane.runnerApp.inject({
          method: "POST",
          url: apiPath(RUNNER_ROUTES.applicationBackupAuthorization, { taskId: task!.id }),
          headers: headers(otherToken),
          payload: { attempt: 0 },
        })
      ).json(),
    ).toEqual({ allowed: false });
    expect(
      (
        await plane.runnerApp.inject({
          method: "POST",
          url: upload(task!),
          headers: { ...headers(otherToken), [HTTP_HEADERS.contentType]: TAR_CONTENT_TYPE },
          payload: archive(),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await plane.runnerApp.inject({
          method: "POST",
          url: upload(task!),
          headers: { ...headers(token, false), [HTTP_HEADERS.contentType]: TAR_CONTENT_TYPE },
          payload: archive(),
        })
      ).statusCode,
    ).toBe(409);
  });
  it("streams exact ciphertext, acknowledges one completion, and serves only the bound drill attempt", async () => {
    const { planId } = await enqueue();
    const [task] = await take();
    const data = archive();
    const put = await plane.runnerApp.inject({
      method: "POST",
      url: upload(task!),
      headers: { ...headers(), [HTTP_HEADERS.contentType]: TAR_CONTENT_TYPE },
      payload: data,
    });
    expect(put.statusCode, put.body).toBe(200);
    const result = {
      id: task!.id,
      attempt: 0,
      artifactId: task!.artifactId,
      ok: true,
      message: "captured",
      writers: ["app"],
      stopped: [],
      payloadBytes: data.length,
      payloadSha256: createHash("sha256").update(data).digest("hex"),
      fingerprint: "a".repeat(64),
    };
    for (let retry = 0; retry < 2; retry++)
      expect(
        (
          await plane.runnerApp.inject({
            method: "POST",
            url: RUNNER_ROUTES.applicationBackupResult,
            headers: headers(),
            payload: result,
          })
        ).statusCode,
      ).toBe(200);
    expect(
      (
        await plane.runnerApp.inject({
          method: "POST",
          url: RUNNER_ROUTES.applicationBackupResult,
          headers: headers(otherToken),
          payload: result,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await admin.post(apiPath(API_ROUTES.applicationBackupRun, { planId }), {
          operation: "drill",
          artifactId: task!.artifactId,
          requestKey: randomUUID(),
        })
      ).statusCode,
    ).toBe(200);
    const [drill] = await take();
    expect(drill?.identity).toMatch(/^AGE-SECRET-KEY-/);
    const get = await plane.runnerApp.inject({ method: "GET", url: download(drill!), headers: headers() });
    expect(get.statusCode, get.body).toBe(200);
    expect(get.rawPayload).toEqual(data);
    expect(
      (
        await plane.runnerApp.inject({
          method: "GET",
          url: download(drill!).replace("attempt=0", "attempt=1"),
          headers: headers(),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await plane.runnerApp.inject({ method: "GET", url: download(drill!), headers: headers(otherToken) })).statusCode,
    ).toBe(409);
  });
  it("rejects wrong attempts, unknown task/artifact IDs and revoked admission before mutation", async () => {
    await enqueue();
    const [task] = await take();
    const authorize = apiPath(RUNNER_ROUTES.applicationBackupAuthorization, { taskId: task!.id });
    expect(
      (
        await plane.runnerApp.inject({ method: "POST", url: authorize, headers: headers(), payload: { attempt: 0 } })
      ).json(),
    ).toEqual({ allowed: true });
    expect(
      (
        await plane.runnerApp.inject({ method: "POST", url: authorize, headers: headers(), payload: { attempt: 1 } })
      ).json(),
    ).toEqual({ allowed: false });
    expect(
      (
        await plane.runnerApp.inject({
          method: "POST",
          url: upload(task!).replace("attempt=0", "attempt=1"),
          headers: { ...headers(), [HTTP_HEADERS.contentType]: TAR_CONTENT_TYPE },
          payload: archive(),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await plane.runnerApp.inject({
          method: "POST",
          url: upload(task!).replace(task!.artifactId, randomUUID()),
          headers: { ...headers(), [HTTP_HEADERS.contentType]: TAR_CONTENT_TYPE },
          payload: archive(),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await plane.runnerApp.inject({
          method: "POST",
          url: authorize.replace(task!.id, randomUUID()),
          headers: headers(),
          payload: { attempt: 0 },
        })
      ).statusCode,
    ).toBe(404);
    plane.services.databaseHandle.sqlite.prepare("UPDATE hosts SET dry_run=1 WHERE id=?").run(hostId);
    expect(
      (
        await plane.runnerApp.inject({ method: "POST", url: authorize, headers: headers(), payload: { attempt: 0 } })
      ).json(),
    ).toEqual({ allowed: false });
    plane.services.databaseHandle.sqlite.prepare("UPDATE hosts SET dry_run=0 WHERE id=?").run(hostId);
    plane.services.databaseHandle.sqlite.prepare("UPDATE users SET role='viewer' WHERE username='admin'").run();
    expect(
      (
        await plane.runnerApp.inject({ method: "POST", url: authorize, headers: headers(), payload: { attempt: 0 } })
      ).json(),
    ).toEqual({ allowed: false });
  });
});
