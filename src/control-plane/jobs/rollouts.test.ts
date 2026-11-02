import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startTestControlPlane,
  runnerTokenOf,
  type TestControlPlane,
  type TestClient,
} from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { containerSnapshot, heartbeatWith } from "../../../test/support/inventory.js";
import { API_ROUTES, apiPath, type EnrolledHostView } from "../../shared/api.js";
import { HTTP_HEADERS } from "../../shared/constants.js";
import { RUNNER_ROUTES, type ContainerAccessWork, type WorkResponse } from "../../shared/protocol.js";
import type { OperationImpactView } from "../../shared/topology.js";
import { ROLLOUT_LIMITS, ROLLOUT_REASONS, ROLLOUT_ROUTES, type RolloutView } from "../../shared/rollouts.js";
const digest = `ghcr.io/example/app@sha256:${"b".repeat(64)}`;
const source = "ghcr.io/example/app:latest";
describe("staged immutable rollouts", () => {
  let plane: TestControlPlane, admin: TestClient, hostId: string, token: string;
  const headers = () => ({
    authorization: `Bearer ${token}`,
    [HTTP_HEADERS.runnerCapabilities]: "resource-permissions,operation-previews,rollouts",
  });
  async function report(replacement = false, health: "healthy" | "unhealthy" = "healthy") {
    const containers = [
      containerSnapshot({
        name: "canary",
        image: replacement ? digest : source,
        containerId: replacement ? "222222222222" : "111111111111",
        health,
      }),
      containerSnapshot({ name: "follower", image: source, containerId: "333333333333", health: "healthy" }),
    ];
    return plane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      headers: headers(),
      payload: {
        ...heartbeatWith({ containers, dryRun: false }),
        operationPreviews: true,
        rollouts: true,
        topology: {
          capturedAt: plane.clock.now,
          nodes: containers.map((container) => ({
            name: container.name,
            containerId: container.containerId!,
            composeProject: null,
          })),
          edges: [],
          truncated: false,
          notes: [],
        },
      },
    });
  }
  async function review(name: string, writableData: "none" | "present" | "unknown" = "none") {
    const pending = admin.post(apiPath(API_ROUTES.operationPreview, { hostId, containerName: name }), {
      action: "update",
    });
    const work = (
      await plane.runnerApp.inject({ method: "GET", url: RUNNER_ROUTES.containerAccess, headers: headers() })
    ).json<ContainerAccessWork>();
    expect(work.previews).toHaveLength(1);
    await plane.runnerApp.inject({
      method: "POST",
      url: apiPath(RUNNER_ROUTES.operationPreviewAnswer, { requestId: work.previews![0]!.id }),
      headers: headers(),
      payload: {
        ok: true,
        fingerprint: "a".repeat(64),
        members: [{ name, protected: false }],
        resources: [],
        refusals: [],
        rolloutSafety: {
          writableData,
          platform: "linux/amd64",
          sourceContainerId: name === "canary" ? "1".repeat(64) : "3".repeat(64),
        },
      },
    });
    return (await pending).json<OperationImpactView>().id;
  }
  async function create(writableData: "none" | "present" = "none") {
    const targets = [];
    for (const name of ["canary", "follower"])
      targets.push({
        hostId,
        containerName: name,
        previewId: await review(name, writableData),
        targetReference: digest,
      });
    return admin.post(ROLLOUT_ROUTES.rollouts, {
      targets,
      observeMinutes: 1,
      externalDataIsolated: true,
      serviceVerificationRequired: true,
    });
  }
  const work = async (capable = true) =>
    (
      await plane.runnerApp.inject({
        method: "GET",
        url: RUNNER_ROUTES.work,
        headers: capable ? headers() : { authorization: `Bearer ${token}` },
      })
    ).json<WorkResponse>().jobs;
  const current = async () => (await admin.get(ROLLOUT_ROUTES.rollouts)).json<RolloutView[]>()[0]!;
  async function complete(id: string, succeeded = true) {
    return plane.runnerApp.inject({
      method: "POST",
      url: apiPath(RUNNER_ROUTES.jobResult, { jobId: id }),
      headers: headers(),
      payload: { succeeded, outcome: succeeded ? "Updated" : "Failed", output: null },
    });
  }
  beforeEach(async () => {
    plane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(plane)).client;
    const enrolled = await admin.post(API_ROUTES.hosts, { label: "Rollout-lab" });
    expect(enrolled.statusCode, enrolled.body).toBe(200);
    const host = enrolled.json<EnrolledHostView>();
    hostId = host.host.id;
    token = runnerTokenOf(host);
    const reported = await report();
    expect(reported.statusCode, reported.body).toBe(200);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await plane.app.close();
    await plane.runnerApp.close();
  });
  it("goes on past saved states it cannot read, shows each with a reason, and leaves them as they were", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const sqlite = plane.services.databaseHandle.sqlite;
    const insert = (state: string) => {
      const id = randomUUID();
      sqlite.prepare("INSERT INTO rollouts VALUES(?,?,?,?)").run(id, plane.clock.now, plane.clock.now, state);
      return { id, state };
    };
    const unreadable = [
      insert("{ not json"),
      insert(JSON.stringify({ id: "older", status: "updating", targets: "every host" })),
    ];
    const response = await create();
    expect(response.statusCode, response.body).toBe(200);
    const plan = response.json<RolloutView>();
    // Saved by a newer version, or past its own targets: refused, not trimmed to fit.
    const saved = JSON.parse(
      (sqlite.prepare("SELECT state_json FROM rollouts WHERE id=?").get(plan.id) as { state_json: string }).state_json,
    );
    unreadable.push(
      insert(JSON.stringify({ ...saved, id: randomUUID(), addedLater: true })),
      insert(JSON.stringify({ ...saved, id: randomUUID(), current: saved.targets.length })),
    );
    const [canary] = await work();
    await complete(canary!.id);
    plane.clock.now += 1000;
    await report(true);
    const listed = (await admin.get(ROLLOUT_ROUTES.rollouts)).json<RolloutView[]>();
    expect(listed.find((value) => value.id === plan.id)?.status).toBe("observing");
    for (const row of unreadable)
      expect(listed.find((value) => value.id === row.id)).toMatchObject({
        status: "inconclusive",
        reason: ROLLOUT_REASONS.unreadable,
        targets: [],
      });
    plane.clock.now += ROLLOUT_LIMITS.retention + 1;
    plane.services.rollouts.tick();
    for (const row of unreadable)
      expect(sqlite.prepare("SELECT state_json FROM rollouts WHERE id=?").get(row.id)).toEqual({
        state_json: row.state,
      });
    const reports = logged.mock.calls.filter(([line]) => String(line).includes("saved state could not be read"));
    expect(reports).toHaveLength(unreadable.length);
  });
  it("pins canary and follower jobs, gates promotion on fresh observation and service verification, and rejects a legacy reader", async () => {
    const response = await create();
    expect(response.statusCode, response.body).toBe(200);
    const plan = response.json<RolloutView>();
    expect(await work(false)).toEqual([]);
    const [canary] = await work();
    expect(canary).toMatchObject({
      containerName: "canary",
      automatic: true,
      rollout: { targetReference: digest, expectedSourceContainerId: "1".repeat(64), requireStateless: true },
    });
    expect(await work()).toEqual([]);
    // An ordinary update cannot attach a sequential mutable-tag run to this rollout job.
    const normal = await admin.post(apiPath(API_ROUTES.containerActions, { hostId, containerName: "canary" }), {
      action: "update",
      previewId: await review("canary"),
    });
    expect(normal.statusCode).toBe(409);
    expect(
      (await admin.post(apiPath(ROLLOUT_ROUTES.rolloutPromote, { rolloutId: plan.id }), { serviceVerified: true }))
        .statusCode,
    ).toBe(409);
    await complete(canary!.id);
    plane.clock.now += 1000;
    await report(true);
    expect((await current()).status).toBe("observing");
    for (let at = 0; at < 2; at++) {
      plane.clock.now += 31000;
      await report(true);
      await current();
    }
    expect((await current()).status).toBe("ready");
    expect(
      (await admin.post(apiPath(ROLLOUT_ROUTES.rolloutPromote, { rolloutId: plan.id }), { serviceVerified: false }))
        .statusCode,
    ).toBe(409);
    expect(
      (await admin.post(apiPath(ROLLOUT_ROUTES.rolloutPromote, { rolloutId: plan.id }), { serviceVerified: true }))
        .statusCode,
    ).toBe(200);
    expect((await work())[0]).toMatchObject({ containerName: "follower", rollout: { targetReference: digest } });
  });
  it("snapshots targets across hosts and keeps the follower on its own host", async () => {
    const firstHost = hostId,
      firstToken = token;
    const firstPreview = await review("canary");
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Follower-host" })).json<EnrolledHostView>();
    hostId = enrolled.host.id;
    token = runnerTokenOf(enrolled);
    expect((await report()).statusCode).toBe(200);
    const secondHost = hostId;
    const secondPreview = await review("follower");
    hostId = firstHost;
    token = firstToken;
    const created = await admin.post(ROLLOUT_ROUTES.rollouts, {
      targets: [
        { hostId: firstHost, containerName: "canary", previewId: firstPreview, targetReference: digest },
        { hostId: secondHost, containerName: "follower", previewId: secondPreview, targetReference: digest },
      ],
      observeMinutes: 1,
      externalDataIsolated: true,
      serviceVerificationRequired: true,
    });
    expect(created.statusCode, created.body).toBe(200);
    const plan = created.json<RolloutView>();
    expect(plan.targets.map((target) => target.hostId)).toEqual([firstHost, secondHost]);
    expect((await work())[0]).toMatchObject({
      containerName: "canary",
      rollout: { expectedSourceContainerId: "1".repeat(64) },
    });
  });
  it("fails a bad canary, blocks writable data, and refuses viewer promotion", async () => {
    expect((await create("present")).statusCode).toBe(409);
    const response = await create();
    expect(response.statusCode, response.body).toBe(200);
    const plan = response.json<RolloutView>();
    const viewer = (await fullySignedInUser(plane, admin, "rollout-viewer", "viewer")).client;
    expect(
      (await viewer.post(apiPath(ROLLOUT_ROUTES.rolloutPromote, { rolloutId: plan.id }), { serviceVerified: true }))
        .statusCode,
    ).toBe(403);
    const [job] = await work();
    await complete(job!.id);
    plane.clock.now += 1000;
    await report(true, "unhealthy");
    expect((await current()).status).toBe("failed");
    expect(
      (await admin.post(apiPath(ROLLOUT_ROUTES.rolloutPromote, { rolloutId: plan.id }), { serviceVerified: true }))
        .statusCode,
    ).toBe(409);
    expect(await work()).toEqual([]);
  });
  it("makes absent fresh reports inconclusive without dispatching a follower", async () => {
    const plan = (await create()).json<RolloutView>();
    const [job] = await work();
    await complete(job!.id);
    plane.clock.now += 190_000;
    expect((await current()).status).toBe("inconclusive");
    expect(
      (await admin.post(apiPath(ROLLOUT_ROUTES.rolloutPromote, { rolloutId: plan.id }), { serviceVerified: true }))
        .statusCode,
    ).toBe(409);
    expect(await work()).toEqual([]);
  });
  it("Hold revokes admission before mutation", async () => {
    const plan = (await create()).json<RolloutView>();
    const [job] = await work();
    const authorize = () =>
      plane.runnerApp.inject({
        method: "POST",
        url: apiPath(RUNNER_ROUTES.jobAuthorization, { jobId: job!.id }),
        headers: headers(),
        payload: { members: [{ name: "canary", composeProject: null }] },
      });
    expect((await authorize()).json()).toEqual({ authorized: true });
    expect((await admin.post(apiPath(ROLLOUT_ROUTES.rolloutHold, { rolloutId: plan.id }))).statusCode).toBe(200);
    expect((await authorize()).json()).toEqual({ authorized: false });
    await complete(job!.id);
    expect((await current()).status).toBe("held");
    expect(await work()).toEqual([]);
  });
});
