import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { heartbeatWith } from "../../../test/support/inventory.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { API_ROUTES, apiPath, type EnrolledHostView, type JobView } from "../../shared/api.js";
import { HTTP_HEADERS, RUNNER_CAPABILITIES } from "../../shared/constants.js";
import { RUNNER_ROUTES, type WorkResponse } from "../../shared/protocol.js";

const SECRET_VALUE = "a-value-only-its-owner-should-see";
const OWN = {
  own: true,
  folder: "/srv/stacks/wiki",
  compose: "services:\n  wiki:\n    image: wiki:2\n",
  env: `DB_PASSWORD=${SECRET_VALUE}\n`,
  retryOf: null,
};
const OTHER_SPEC = { ...OWN, compose: "services:\n  other:\n    image: other:1\n" };

describe("an install's details, until its job has an outcome", () => {
  let databasePath: string;
  let plane: TestControlPlane;
  let admin: TestClient;
  let token: string;
  let otherToken: string;
  let otherHostId: string;
  let hostId: string;

  const runnerAs = (bearer: string, method: "GET" | "POST", url: string, payload?: object) =>
    plane.runnerApp.inject({
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${bearer}`, [HTTP_HEADERS.runnerCapabilities]: RUNNER_CAPABILITIES },
    });
  const runner = (method: "GET" | "POST", url: string, payload?: object) => runnerAs(token, method, url, payload);
  const takeWork = async () => (await runner("GET", RUNNER_ROUTES.work)).json<WorkResponse>().jobs;
  const details = (jobId: string) => apiPath(RUNNER_ROUTES.jobInstall, { jobId });
  const fetched = (jobId: string) => runner("GET", details(jobId));
  const stored = () =>
    plane.services.databaseHandle.sqlite.prepare("SELECT install_payload AS payload FROM jobs").all() as {
      payload: string | null;
    }[];
  const stop = async () => {
    await plane.app.close();
    await plane.runnerApp.close();
  };
  const restarted = async () => {
    await stop();
    plane = await startTestControlPlane({ databasePath });
  };
  const ask = async (own: object = OWN) => {
    const asked = await admin.post(apiPath(API_ROUTES.hostInstallOwn, { hostId }), own);
    expect(asked.statusCode, asked.body).toBe(200);
    return asked.json<JobView>().id;
  };
  const answerIt = (jobId: string) =>
    runner("POST", apiPath(RUNNER_ROUTES.jobResult, { jobId }), { succeeded: true, outcome: "Up.", output: null });

  beforeEach(async () => {
    databasePath = join(mkdtempSync(join(tmpdir(), "autoheal-install-")), "autoheal.sqlite");
    plane = await startTestControlPlane({ databasePath });
    admin = (await fullySignedInAdmin(plane)).client;
    const enroll = async (label: string) => (await admin.post(API_ROUTES.hosts, { label })).json<EnrolledHostView>();
    const enrolled = await enroll("Alder");
    token = runnerTokenOf(enrolled);
    const other = await enroll("Delta");
    otherToken = runnerTokenOf(other);
    otherHostId = other.host.id;
    hostId = enrolled.host.id;
    const beat = await runner("POST", RUNNER_ROUTES.heartbeat, {
      ...heartbeatWith({ dryRun: false, containers: [] }),
      containerAccess: true,
      hostDeploy: true,
    });
    expect(beat.statusCode, beat.body).toBe(200);
  });

  afterEach(stop);

  it("answers the same as often as asked, so a reply lost on the way costs nothing", async () => {
    const jobId = await ask();
    await takeWork();
    const first = await fetched(jobId);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ compose: OWN.compose, env: OWN.env });
    expect((await fetched(jobId)).json()).toEqual(first.json());
  });

  it("still has them after the control plane restarts, and does not hand the job out again", async () => {
    const jobId = await ask();
    expect((await takeWork()).map(({ id }) => id)).toEqual([jobId]);
    await restarted();
    expect((await fetched(jobId)).json()).toMatchObject({ env: OWN.env });
    expect(await takeWork()).toEqual([]);
  });

  it("keeps them sealed in the database, and out of every view of the job", async () => {
    const jobId = await ask();
    const [row] = stored();
    expect(row?.payload).not.toBeNull();
    expect(row?.payload).not.toContain(SECRET_VALUE);
    const raw = new Database(databasePath, { readonly: true });
    expect(JSON.stringify(raw.prepare("SELECT * FROM jobs").all())).not.toContain(SECRET_VALUE);
    raw.close();
    const seen = await admin.get(apiPath(API_ROUTES.job, { jobId }));
    expect(seen.body).not.toContain(SECRET_VALUE);
    expect(seen.body).not.toContain(row!.payload!);
    expect(JSON.stringify(await takeWork())).not.toContain(row!.payload!);
  });

  it("gives them to no other host", async () => {
    const jobId = await ask();
    expect((await runnerAs(otherToken, "GET", details(jobId))).statusCode).toBe(404);
    expect((await fetched(jobId)).statusCode).toBe(200);
  });

  it("lets go of them with the job's outcome, and a late ask finds nothing", async () => {
    const jobId = await ask();
    await takeWork();
    await fetched(jobId);
    expect((await answerIt(jobId)).statusCode).toBe(204);
    expect(stored().map(({ payload }) => payload)).toEqual([null]);
    expect((await fetched(jobId)).statusCode).toBe(404);
  });

  it("lets go of them when nobody collects the job in time", async () => {
    const jobId = await ask();
    plane.clock.now += 24 * 60 * 60 * 1000;
    expect((await takeWork()).map(({ id }) => id)).not.toContain(jobId);
    expect(stored().map(({ payload }) => payload)).toEqual([null]);
    expect((await fetched(jobId)).statusCode).toBe(404);
  });

  it("lets go of what a crash left beside a job already over, at the next start", async () => {
    const jobId = await ask();
    await takeWork();
    await stop();
    const sqlite = new Database(databasePath);
    sqlite.prepare("UPDATE jobs SET status = 'failed', completed_at = 1 WHERE id = ?").run(jobId);
    sqlite.close();
    plane = await startTestControlPlane({ databasePath });
    expect(stored().map(({ payload }) => payload)).toEqual([null]);
  });

  it("keeps the first details when the same install is asked for twice while it waits", async () => {
    const first = await ask();
    const second = await ask(OTHER_SPEC);
    expect(second).toBe(first);
    await takeWork();
    expect((await fetched(first)).json()).toMatchObject({ compose: OWN.compose });
  });

  describe("a second try", () => {
    const failIt = (jobId: string) =>
      runner("POST", apiPath(RUNNER_ROUTES.jobResult, { jobId }), { succeeded: false, outcome: "No.", output: null });
    const failedInstall = async (own: object = OWN) => {
      const jobId = await ask(own);
      await takeWork();
      await failIt(jobId);
      plane.clock.now += 1_000;
      return jobId;
    };
    const route = () => apiPath(API_ROUTES.hostInstallOwn, { hostId });
    const askFor = (client: TestClient, change: object) => client.post(route(), { ...OWN, ...change });
    const REFUSED = { statusCode: 409, error: "install_retry_refused" };
    const refusal = (response: { statusCode: number; json: <Body>() => Body }) => ({
      statusCode: response.statusCode,
      error: response.json<{ error: string }>().error,
    });

    it("of a failed install goes to the host with what that install wrote, and nothing more", async () => {
      const retryOf = await failedInstall();
      const edited = `${OWN.compose}# edited\n`;
      const again = await askFor(admin, { retryOf, compose: edited });
      expect(again.statusCode, again.body).toBe(200);
      const jobId = again.json<JobView>().id;
      expect(jobId).not.toBe(retryOf);
      await takeWork();
      const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
      const given = (await fetched(jobId)).json<Record<string, unknown>>();
      expect(given).toMatchObject({
        compose: edited,
        retry: { composeSha256: sha256(OWN.compose), envSha256: sha256(OWN.env) },
      });
      expect(given).not.toHaveProperty("retryOf");
    });

    it("is nothing without a failed install to name", async () => {
      const jobId = await ask();
      await takeWork();
      await answerIt(jobId);
      expect(refusal(await askFor(admin, { retryOf: jobId }))).toEqual(REFUSED);
      expect(refusal(await askFor(admin, { retryOf: randomUUID() }))).toEqual(REFUSED);
    });

    it("cannot be an old flag saying so", async () => {
      expect((await askFor(admin, { retryOf: undefined, again: true })).statusCode).toBe(400);
    });

    it("cannot move to another folder or name", async () => {
      const retryOf = await failedInstall();
      expect(refusal(await askFor(admin, { retryOf, folder: "/srv/stacks/other" }))).toEqual(REFUSED);
      expect(refusal(await askFor(admin, { retryOf, folder: "/srv/elsewhere/wiki" }))).toEqual(REFUSED);
    });

    it("cannot move to another host", async () => {
      const retryOf = await failedInstall();
      const beat = await runnerAs(otherToken, "POST", RUNNER_ROUTES.heartbeat, {
        ...heartbeatWith({ dryRun: false, containers: [] }),
        containerAccess: true,
        hostDeploy: true,
      });
      expect(beat.statusCode).toBe(200);
      const asked = await admin.post(apiPath(API_ROUTES.hostInstallOwn, { hostId: otherHostId }), {
        ...OWN,
        retryOf,
      });
      expect(refusal(asked)).toEqual(REFUSED);
    });

    it("is for the person who started it", async () => {
      const retryOf = await failedInstall();
      const second = await fullySignedInUser(plane, admin, "second", "admin");
      expect(refusal(await askFor(second.client, { retryOf }))).toEqual(REFUSED);
    });

    it("works once: tried again since, only the newest failure can be named", async () => {
      const first = await failedInstall();
      const second = await failedInstall({ ...OWN, retryOf: first });
      expect(refusal(await askFor(admin, { retryOf: first }))).toEqual(REFUSED);
      expect((await askFor(admin, { retryOf: second })).statusCode).toBe(200);
    });

    it("cannot name another kind of job", async () => {
      const asked = await admin.post(apiPath(API_ROUTES.hostInstallUndo, { hostId }), {
        name: "wiki",
        removeData: false,
      });
      const undoId = asked.json<JobView>().id;
      await takeWork();
      await failIt(undoId);
      expect(refusal(await askFor(admin, { retryOf: undoId }))).toEqual(REFUSED);
    });

    it("keeps what the install wrote sealed, and through the job's end", async () => {
      await failedInstall();
      const [row] = plane.services.databaseHandle.sqlite
        .prepare("SELECT install_retry AS kept, install_payload AS payload FROM jobs")
        .all() as { kept: string; payload: string | null }[];
      expect(row!.payload).toBeNull();
      const sha = createHash("sha256").update(OWN.env).digest("hex");
      expect(row!.kept).not.toContain(sha);
      expect(row!.kept).not.toContain(OWN.folder);
    });

    it("is judged the same when only checking", async () => {
      const retryOf = await failedInstall();
      const check = apiPath(API_ROUTES.hostInstallOwnCheck, { hostId });
      expect(refusal(await admin.post(check, { ...OWN, retryOf: randomUUID() }))).toEqual(REFUSED);
      expect(refusal(await admin.post(check, { ...OWN, retryOf, folder: "/srv/stacks/other" }))).toEqual(REFUSED);
    });
  });

  it("takes nothing through a database restore", async () => {
    const { backupService, restoreService } = plane.services;
    const actor = { userId: "first", username: "first", ip: "127.0.0.1", requestId: "first" };
    await ask();
    const backup = await backupService.create("manual", null);
    const preview = await restoreService.prepareStored(actor, backup.fileName);
    await restoreService.confirm(actor, preview.restoreId);
    expect(stored().map(({ payload }) => payload)).toEqual([null]);
  });
});
