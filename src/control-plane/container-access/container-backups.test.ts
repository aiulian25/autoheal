import { eq } from "drizzle-orm";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeOllama } from "../../../test/fakes/fake-ollama.js";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { containerSnapshot, heartbeatWith } from "../../../test/support/inventory.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { API_ERRORS, API_ROUTES, apiPath, type EnrolledHostView, type JobView } from "../../shared/api.js";
import { JOB_ACTION, JOB_STATUS } from "../../shared/constants.js";
import { BACKUP_ASK, CONTAINER_BACKUP, backupJobSchema } from "../../shared/container-backups.js";
import { RUNNER_ROUTES, type ContainerAccessWork, type WorkResponse } from "../../shared/protocol.js";
import { jobs } from "../database/schema.js";

const TARGET = { container: "app", stack: null };

describe("container backups", () => {
  let ollama: FakeOllama;
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let hostId: string;
  let token: string;

  beforeEach(async () => {
    ollama = await FakeOllama.start();
    controlPlane = await startTestControlPlane({ ollamaUrl: ollama.url() });
    admin = (await fullySignedInAdmin(controlPlane)).client;
    const host = (await admin.post(API_ROUTES.hosts, { label: "HP" })).json<EnrolledHostView>();
    hostId = host.host.id;
    token = runnerTokenOf(host);
    await runner(
      "POST",
      RUNNER_ROUTES.heartbeat,
      heartbeatWith({ containers: [containerSnapshot({ name: "app" })], dryRun: false }),
    );
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
    await ollama.close();
  });

  const runner = (method: "GET" | "POST", url: string, payload?: object) =>
    controlPlane.runnerApp.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  const route = (template: string) => apiPath(template, { hostId });
  const start = (client = admin) => client.post(route(API_ROUTES.hostBackupStart), { target: TARGET });
  const delivered = async () => (await runner("GET", RUNNER_ROUTES.work)).json<WorkResponse>().jobs;

  it("is an admin's", async () => {
    const { client: viewer } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    expect(
      (await viewer.post(route(API_ROUTES.hostBackupAsk), { kind: BACKUP_ASK.list, target: TARGET })).statusCode,
    ).toBe(403);
    expect((await start(viewer)).statusCode).toBe(403);
    expect(
      (await viewer.post(route(API_ROUTES.hostBackupRestore), { target: TARGET, id: "20261101T000000Z" })).statusCode,
    ).toBe(403);
    expect((await viewer.get(API_ROUTES.containerBackupSettings)).statusCode).toBe(403);
  });

  it("hands the runner a job with a sealed key, and no key that opens anything", async () => {
    const job = (await start()).json<JobView>();
    const stored = controlPlane.services.databaseHandle.database.select().from(jobs).where(eq(jobs.id, job.id)).get()!;
    expect(stored.backupJson).not.toContain("AGE-SECRET-KEY");
    const [item] = await delivered();
    expect(item).toMatchObject({ action: JOB_ACTION.backupContainer, containerName: "app" });
    const { backup } = item as unknown as { backup: unknown };
    const details = backupJobSchema.parse(backup);
    expect(details.directory).toBe(CONTAINER_BACKUP.defaultDirectory);
    expect(JSON.stringify(details)).not.toContain("AGE-SECRET-KEY");
    expect(details.key.recipient).toMatch(/^age1/);
  });

  it("opens that key only for that job, while it runs, on that host", async () => {
    const job = (await start()).json<JobView>();
    const [item] = await delivered();
    const { key } = backupJobSchema.parse((item as unknown as { backup: unknown }).backup);
    const open = (jobId: string) =>
      runner("POST", apiPath(RUNNER_ROUTES.jobBackupKey, { jobId }), { sealedKey: key.sealedKey });
    const opened = await open(job.id);
    expect(opened.statusCode).toBe(200);
    const { identity } = opened.json<{ identity: string }>();
    expect(await identityToRecipient(identity)).toBe(key.recipient);
    await runner("POST", apiPath(RUNNER_ROUTES.jobResult, { jobId: job.id }), {
      succeeded: true,
      outcome: "done",
      output: null,
    });
    expect((await open(job.id)).json<{ error: string }>().error).toBe(API_ERRORS.backupKeyRefused);
    expect((await open("11111111-1111-4111-8111-111111111111")).json<{ error: string }>().error).toBe(
      API_ERRORS.backupKeyRefused,
    );
  });

  it("refuses a key this passphrase did not seal", async () => {
    const job = (await start()).json<JobView>();
    await delivered();
    const forged = Buffer.from(await generateX25519Identity()).toString("base64");
    const answer = await runner("POST", apiPath(RUNNER_ROUTES.jobBackupKey, { jobId: job.id }), { sealedKey: forged });
    expect(answer.json<{ error: string }>().error).toBe(API_ERRORS.backupKeyRefused);
  });

  it("does not start a second of the same while one is open", async () => {
    const one = (await start()).json<JobView>();
    const two = (await start()).json<JobView>();
    expect(two.id).toBe(one.id);
    expect(one.status).toBe(JOB_STATUS.pending);
  });

  it("asks the runner, and passes its answer on", async () => {
    const asking = admin.post(route(API_ROUTES.hostBackupAsk), { kind: BACKUP_ASK.list, target: TARGET });
    const work = await runner("GET", RUNNER_ROUTES.containerAccess);
    const [request] = work.json<ContainerAccessWork>().backups ?? [];
    expect(request).toMatchObject({
      kind: BACKUP_ASK.list,
      target: TARGET,
      directory: CONTAINER_BACKUP.defaultDirectory,
    });
    await runner("POST", apiPath(RUNNER_ROUTES.backupAnswer, { requestId: request!.id }), { refusal: "not today" });
    expect((await asking).json()).toEqual({ refusal: "not today" });
  });

  it.each(["/", "/etc", "/etc/autoheal", "relative", "/srv/../etc"])(
    "will not put backups in %s",
    async (directory) => {
      const answer = await admin.put(API_ROUTES.containerBackupSettings, { directory, copyDirectory: null });
      expect(answer.statusCode).toBe(400);
    },
  );

  it("takes its folder from the settings", async () => {
    const settings = { directory: "/srv/backups", copyDirectory: "/mnt/storage/backups" };
    expect((await admin.put(API_ROUTES.containerBackupSettings, settings)).statusCode).toBe(204);
    expect((await admin.get(API_ROUTES.containerBackupSettings)).json()).toEqual(settings);
    await start();
    const [item] = await delivered();
    expect((item as unknown as { backup: { directory: string } }).backup.directory).toBe("/srv/backups");
  });
});
