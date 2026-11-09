import Database from "better-sqlite3";
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
import { EVERY_RUNNER_CAPABILITY, containerSnapshot, heartbeatWith } from "../../../test/support/inventory.js";
import { currentCode, fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { API_ERRORS, API_ROUTES, apiPath, type EnrolledHostView, type StackRestartView } from "../../shared/api.js";
import { HTTP_HEADERS, STACK_RESTARTS_KEPT, STACK_RESTART_INTERRUPTED } from "../../shared/constants.js";
import { RUNNER_ROUTES, type WorkResponse } from "../../shared/protocol.js";
import type { ResourceGrant, ResourcePermissionsView } from "../../shared/resource-permissions.js";
import type { TopologySnapshot } from "../../shared/topology.js";
import { restartOrder } from "./stack-restarts-service.js";

type Edge = TopologySnapshot["edges"][number];
const edge = (from: string, to: string, kind: Edge["kind"] = "declared_dependency"): Edge => ({
  from,
  to,
  kind,
  source: "docker",
});

describe("the order a stack restarts in", () => {
  it("puts what a container depends on first and the rest by name, and breaks a loop at the first by name", () => {
    expect(restartOrder(["web", "db", "cache"], [edge("web", "db"), edge("web", "cache")])).toEqual([
      "cache",
      "db",
      "web",
    ]);
    expect(restartOrder(["vpn-client", "app"], [edge("app", "vpn-client", "network_namespace")])).toEqual([
      "vpn-client",
      "app",
    ]);
    // A shared project or shared data says nothing of order, and a link to a container outside the stack neither.
    const unordered = [edge("a", "b", "compose_association"), edge("a", "b", "shared_writable_data"), edge("a", "z")];
    expect(restartOrder(["b", "a"], unordered)).toEqual(["a", "b"]);
    expect(restartOrder(["x", "y", "z"], [edge("x", "y"), edge("y", "x"), edge("z", "x")])).toEqual(["x", "y", "z"]);
  });
});

const STACK = "musicbox";
const MEMBERS = ["musicbox", "musicbox-pg", "musicbox-redis", "musicbox-backup"];
// musicbox waits for its database and its cache, as its Compose depends_on says.
const topology: TopologySnapshot = {
  capturedAt: 1,
  nodes: MEMBERS.map((name) => ({ name, containerId: `${name}-id`, composeProject: STACK })),
  edges: [edge("musicbox", "musicbox-pg"), edge("musicbox", "musicbox-redis")],
  truncated: false,
  notes: [],
};
const restarted = (name: string) => ({ succeeded: true, outcome: `Restarted ${name}.`, output: null });

describe("restarting a Compose stack one container at a time", () => {
  let plane: TestControlPlane;
  let admin: TestClient;
  let token: string;
  let hostId: string;

  const runner = (method: "GET" | "POST", url: string, payload?: object) =>
    plane.runnerApp.inject({
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${token}`, [HTTP_HEADERS.runnerCapabilities]: EVERY_RUNNER_CAPABILITY },
    });
  async function report() {
    const response = await runner("POST", RUNNER_ROUTES.heartbeat, {
      ...heartbeatWith({
        dryRun: false,
        containers: [
          ...MEMBERS.map((name) => containerSnapshot({ name, composeProject: STACK })),
          containerSnapshot({ name: "lonely", composeProject: null }),
        ],
        // Autoheal may not change it, so the stack restarts without it.
        protectedContainers: ["musicbox-backup"],
        topology,
      }),
      resourcePermissions: true,
    });
    expect(response.statusCode).toBe(200);
  }
  const restartPath = (stack = STACK) => apiPath(API_ROUTES.stackRestart, { hostId, stack });
  const latest = async () =>
    (await admin.get(apiPath(API_ROUTES.stackRestarts, { hostId }))).json<StackRestartView | null>();
  const takeWork = async () => (await runner("GET", RUNNER_ROUTES.work)).json<WorkResponse>().jobs;
  const answer = (jobId: string, result: object) => runner("POST", apiPath(RUNNER_ROUTES.jobResult, { jobId }), result);

  beforeEach(async () => {
    plane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(plane)).client;
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    token = runnerTokenOf(enrolled);
    hostId = enrolled.host.id;
    await report();
  });

  afterEach(async () => {
    await plane.app.close();
    await plane.runnerApp.close();
  });

  it("restarts the stack one container at a time, the ones the others depend on first", async () => {
    expect(await latest()).toBeNull();
    const started = await admin.post(restartPath());
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json<StackRestartView>()).toMatchObject({
      stack: STACK,
      names: ["musicbox-pg", "musicbox-redis", "musicbox"],
      status: "running",
      current: "musicbox-pg",
      done: [],
    });
    for (const [index, name] of ["musicbox-pg", "musicbox-redis", "musicbox"].entries()) {
      const work = await takeWork();
      expect(work).toEqual([expect.objectContaining({ action: "restart", containerName: name, requestedBy: "admin" })]);
      expect((await answer(work[0]!.id, restarted(name))).statusCode).toBe(204);
      expect((await latest())!.done).toHaveLength(index + 1);
    }
    expect(await latest()).toMatchObject({ status: "finished", current: null, failed: null });
    expect(await takeWork()).toEqual([]);
  });

  it("stops at the first restart that fails, and leaves the rest as they were", async () => {
    await admin.post(restartPath());
    const [first] = await takeWork();
    const failure = "Could not restart musicbox-pg: the container is gone.";
    await answer(first!.id, { succeeded: false, outcome: failure, output: null });
    expect(await latest()).toMatchObject({
      status: "stopped",
      current: null,
      failed: "musicbox-pg",
      outcome: failure,
      refusal: null,
      done: [],
    });
    expect(await takeWork()).toEqual([]);
  });

  it("restarts one stack per host at a time, and only a stack with a container Autoheal may restart", async () => {
    expect((await admin.post(restartPath("elsewhere"))).json()).toEqual({ error: "stack_not_found" });
    expect((await admin.post(restartPath("Not a project"))).statusCode).toBe(400);
    expect((await admin.post(restartPath())).statusCode).toBe(200);
    const busy = await admin.post(restartPath());
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ error: "stack_restart_busy" });
  });

  it("lets a viewer restart a stack only when grants cover every container it would restart", async () => {
    const viewer = await fullySignedInUser(plane, admin, "operator", "viewer");
    async function grant(grants: ResourceGrant[]) {
      const path = apiPath(API_ROUTES.userGrants, { userId: viewer.userId });
      const current = (await admin.get(path)).json<ResourcePermissionsView>();
      expect((await admin.put(path, { revision: current.revision, grants })).statusCode).toBe(200);
      // Saving grants ends the person's sessions.
      plane.clock.now += 30_000;
      await viewer.client.signIn("operator", viewer.password);
      await viewer.client.post(API_ROUTES.secondFactor, { code: currentCode(viewer.secret, plane.clock.now) });
      await report();
    }
    expect((await viewer.client.post(restartPath())).statusCode).toBe(403);
    await grant([{ hostId, scope: "container", resource: "musicbox-pg", actions: ["lifecycle"] }]);
    expect((await viewer.client.post(restartPath())).statusCode).toBe(403);
    expect(await takeWork()).toEqual([]);

    await grant([{ hostId, scope: "stack", resource: STACK, actions: ["lifecycle"] }]);
    const started = await viewer.client.post(restartPath());
    expect(started.statusCode, started.body).toBe(200);
    expect(await takeWork()).toEqual([
      expect.objectContaining({ action: "restart", containerName: "musicbox-pg", requestedBy: "operator" }),
    ]);
  });
});

describe("a stack restart across a control plane restart", () => {
  const FILE_NAME = "autoheal.sqlite";
  const FAILURE = "Could not restart it: the container is gone.";
  let databasePath: string;
  let plane: TestControlPlane;
  let admin: TestClient;
  let token: string;
  let hostId: string;

  const runner = (method: "GET" | "POST", url: string, payload?: object) =>
    plane.runnerApp.inject({
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${token}`, [HTTP_HEADERS.runnerCapabilities]: EVERY_RUNNER_CAPABILITY },
    });
  const takeWork = async () => (await runner("GET", RUNNER_ROUTES.work)).json<WorkResponse>().jobs;
  const succeed = (jobId: string) =>
    runner("POST", apiPath(RUNNER_ROUTES.jobResult, { jobId }), {
      succeeded: true,
      outcome: "Restarted.",
      output: null,
    });
  const latest = () => plane.services.stackRestarts.latest(hostId);
  const stop = async () => {
    await plane.app.close();
    await plane.runnerApp.close();
  };
  const restarted = async () => {
    await stop();
    plane = await startTestControlPlane({ databasePath });
  };
  // What a crash left, written while nothing runs, as nothing else can put a database in that state.
  const whileDown = async (change: (sqlite: Database.Database) => void) => {
    await stop();
    const sqlite = new Database(databasePath);
    change(sqlite);
    sqlite.close();
    plane = await startTestControlPlane({ databasePath });
  };
  const jobsOf = () =>
    plane.services.databaseHandle.sqlite.prepare("SELECT container_name AS name FROM jobs ORDER BY rowid").all() as {
      name: string;
    }[];

  beforeEach(async () => {
    databasePath = join(mkdtempSync(join(tmpdir(), "autoheal-stack-restart-")), FILE_NAME);
    plane = await startTestControlPlane({ databasePath });
    admin = (await fullySignedInAdmin(plane)).client;
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    token = runnerTokenOf(enrolled);
    hostId = enrolled.host.id;
    const reported = await runner("POST", RUNNER_ROUTES.heartbeat, {
      ...heartbeatWith({
        dryRun: false,
        containers: MEMBERS.map((name) => containerSnapshot({ name, composeProject: STACK })),
        protectedContainers: ["musicbox-backup"],
        topology,
      }),
      resourcePermissions: true,
    });
    expect(reported.statusCode).toBe(200);
    expect((await admin.post(apiPath(API_ROUTES.stackRestart, { hostId, stack: STACK }))).statusCode).toBe(200);
  });

  afterEach(stop);

  it("carries on from a restart already asked of the host, each container restarted once", async () => {
    const [first] = await takeWork();
    await restarted();
    expect(latest()).toMatchObject({ status: "running", current: "musicbox-pg", done: [] });

    await succeed(first!.id);
    const [second] = await takeWork();
    expect(second!.containerName).toBe("musicbox-redis");
    await restarted();
    await succeed(second!.id);
    const [third] = await takeWork();
    expect(third!.containerName).toBe("musicbox");
    await succeed(third!.id);

    expect(latest()).toMatchObject({
      status: "finished",
      current: null,
      done: ["musicbox-pg", "musicbox-redis", "musicbox"],
    });
    expect(jobsOf().map(({ name }) => name)).toEqual(["musicbox-pg", "musicbox-redis", "musicbox"]);
    await restarted();
    expect(latest()).toMatchObject({ status: "finished" });
  });

  it("still gives the host a restart it had not yet taken, and still refuses a second at once", async () => {
    await restarted();
    expect((await takeWork()).map((job) => job.containerName)).toEqual(["musicbox-pg"]);
    const actor = { userId: "x", username: "x", ip: "127.0.0.1", requestId: "x" };
    expect(() => plane.services.stackRestarts.start(actor, hostId, STACK)).toThrow(API_ERRORS.stackRestartBusy);
  });

  it("moves on once when a container finished just before the crash, and not again at the next start", async () => {
    await takeWork();
    await whileDown((sqlite) => {
      sqlite.prepare("UPDATE jobs SET status = 'succeeded', completed_at = 1, outcome = 'Restarted.'").run();
    });
    expect(latest()).toMatchObject({ status: "running", current: "musicbox-redis", done: ["musicbox-pg"] });
    await restarted();
    await restarted();
    expect(jobsOf().map(({ name }) => name)).toEqual(["musicbox-pg", "musicbox-redis"]);
  });

  it("is not moved on by another job on the same host finishing", async () => {
    const [first] = await takeWork();
    const other = await admin.post(apiPath(API_ROUTES.containerActions, { hostId, containerName: "musicbox-redis" }), {
      action: "restart",
    });
    expect(other.statusCode, other.body).toBe(200);
    const [unrelated] = await takeWork();
    expect(unrelated!.containerName).toBe("musicbox-redis");
    await succeed(unrelated!.id);
    expect(latest()).toMatchObject({ status: "running", current: "musicbox-pg", done: [] });
    expect(await takeWork()).toEqual([]);
    await succeed(first!.id);
    expect(latest()).toMatchObject({ current: "musicbox-redis", done: ["musicbox-pg"] });
  });

  it("checks the person may still do it before asking for the next, after a crash too", async () => {
    await takeWork();
    await whileDown((sqlite) => {
      sqlite.prepare("UPDATE jobs SET status = 'succeeded', completed_at = 1, outcome = 'Restarted.'").run();
      sqlite.prepare("UPDATE stack_restarts SET actor_json = json_set(actor_json, '$.userId', 'someone-gone')").run();
    });
    expect(latest()).toMatchObject({
      status: "stopped",
      failed: "musicbox-redis",
      refusal: expect.any(String),
      done: ["musicbox-pg"],
    });
    expect(jobsOf()).toHaveLength(1);
  });

  it("stops, saying why, when a container failed just before the crash", async () => {
    await takeWork();
    await whileDown((sqlite) => {
      sqlite.prepare("UPDATE jobs SET status = 'failed', completed_at = 1, outcome = ?").run(FAILURE);
    });
    expect(latest()).toMatchObject({ status: "stopped", failed: "musicbox-pg", outcome: FAILURE, done: [] });
    expect(await takeWork()).toEqual([]);
  });

  it("says it was interrupted when what it waited on is gone, and lets a new one start", async () => {
    await whileDown((sqlite) => {
      sqlite.pragma("foreign_keys = OFF");
      sqlite.prepare("DELETE FROM jobs").run();
    });
    expect(latest()).toMatchObject({
      status: "stopped",
      failed: "musicbox-pg",
      outcome: STACK_RESTART_INTERRUPTED,
      current: null,
    });
    expect(jobsOf()).toEqual([]);
  });

  it("says it was interrupted by a database restore, and never restarts the rest", async () => {
    const { backupService, restoreService } = plane.services;
    const actor = { userId: "first", username: "first", ip: "127.0.0.1", requestId: "first" };
    const [first] = await takeWork();
    const backup = await backupService.create("manual", null);
    const preview = await restoreService.prepareStored(actor, backup.fileName);
    await restoreService.confirm(actor, preview.restoreId);
    expect(latest()).toMatchObject({
      status: "stopped",
      failed: "musicbox-pg",
      current: null,
      outcome: STACK_RESTART_INTERRUPTED,
    });
    await succeed(first!.id);
    expect(await takeWork()).toEqual([]);
    await restarted();
    expect(latest()).toMatchObject({ status: "stopped", outcome: STACK_RESTART_INTERRUPTED });
    // Starting again is the person's fresh look at what is there.
    const { id: userId } = plane.services.databaseHandle.sqlite.prepare("SELECT id FROM users").get() as { id: string };
    const fresh = plane.services.stackRestarts.start({ ...actor, userId }, hostId, STACK);
    expect(fresh).toMatchObject({ status: "running", current: "musicbox-pg", failed: null, outcome: null });
  });

  it("keeps only the latest few of a host's finished restarts", async () => {
    const { sqlite } = plane.services.databaseHandle;
    const finishedRow = sqlite.prepare(
      `INSERT INTO stack_restarts (id, host_id, stack, names_json, status, done_json, actor_json, created_at, updated_at)
       VALUES (?, ?, 'old', '[]', 'finished', '[]', '{}', ?, ?)`,
    );
    for (let index = 0; index < STACK_RESTARTS_KEPT + 3; index += 1)
      finishedRow.run(`old-${index}`, hostId, index, index);
    const [first] = await takeWork();
    await succeed(first!.id);
    const [second] = await takeWork();
    await succeed(second!.id);
    const [third] = await takeWork();
    await succeed(third!.id);
    expect((await admin.post(apiPath(API_ROUTES.stackRestart, { hostId, stack: STACK }))).statusCode).toBe(200);
    const { rows } = sqlite.prepare("SELECT count(*) AS rows FROM stack_restarts WHERE host_id = ?").get(hostId) as {
      rows: number;
    };
    expect(rows).toBe(STACK_RESTARTS_KEPT);
    expect(latest()).toMatchObject({ stack: STACK, status: "running" });
  });
});
