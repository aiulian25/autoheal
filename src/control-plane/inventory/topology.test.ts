import { HOST_SILENT_AFTER_MILLISECONDS } from "../../shared/constants.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startTestControlPlane,
  runnerTokenOf,
  type TestControlPlane,
  type TestClient,
} from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { containerSnapshot, heartbeatWith } from "../../../test/support/inventory.js";
import { API_ROUTES, apiPath, type EnrolledHostView } from "../../shared/api.js";
import { RUNNER_ROUTES, type ContainerAccessWork, type WorkResponse } from "../../shared/protocol.js";
import {
  TOPOLOGY_LIMITS,
  type OperationImpactView,
  type OperationPreviewAnswer,
  type TopologyView,
} from "../../shared/topology.js";
const HASH = "a".repeat(64);
const available = { status: "available" as const, checkedAt: 1, remoteDigest: `sha256:${"b".repeat(64)}` };
describe("host topology and reviewed operation scope", () => {
  let plane: TestControlPlane;
  let admin: TestClient;
  let hostId: string;
  let token: string;
  const headers = () => ({
    authorization: `Bearer ${token}`,
    "x-autoheal-capabilities": "resource-permissions,operation-previews",
  });
  const impact = (name = "app") => apiPath(API_ROUTES.operationPreview, { hostId, containerName: name });
  const actionPath = (name = "app") => apiPath(API_ROUTES.containerActions, { hostId, containerName: name });
  const answer: OperationPreviewAnswer = {
    ok: true,
    fingerprint: HASH,
    resources: ["resource-0123456789abcdef"],
    members: [{ name: "app", protected: false }],
    refusals: [],
  };
  const heartbeat = (supported = true) =>
    plane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      headers: headers(),
      payload: {
        ...heartbeatWith({
          dryRun: false,
          containerAccess: false,
          containers: [
            containerSnapshot({ name: "app", update: available }),
            containerSnapshot({ name: "worker", update: available }),
          ],
        }),
        ...(supported
          ? {
              operationPreviews: true,
              topology: {
                capturedAt: plane.clock.now,
                nodes: [
                  { name: "app", containerId: "app-id", composeProject: "stack" },
                  { name: "worker", containerId: "worker-id", composeProject: "stack" },
                ],
                edges: [{ from: "app", to: "worker", kind: "compose_association", source: "docker" }],
                truncated: false,
                notes: [],
              },
            }
          : {}),
      },
    });
  beforeEach(async () => {
    plane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(plane)).client;
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Lab" })).json<EnrolledHostView>();
    hostId = enrolled.host.id;
    token = runnerTokenOf(enrolled);
    expect((await heartbeat()).statusCode).toBe(200);
  });
  afterEach(async () => {
    await plane.app.close();
    await plane.runnerApp.close();
  });
  async function reviewed(name = "app", response = answer) {
    const asking = admin.post(impact(name), { action: "update" });
    const work = (
      await plane.runnerApp.inject({ method: "GET", url: RUNNER_ROUTES.containerAccess, headers: headers() })
    ).json<ContainerAccessWork>();
    expect(work.previews).toHaveLength(1);
    expect(work.previews![0]).toMatchObject({ containerName: name, action: "update" });
    expect(
      (
        await plane.runnerApp.inject({
          method: "POST",
          url: apiPath(RUNNER_ROUTES.operationPreviewAnswer, { requestId: work.previews![0]!.id }),
          headers: headers(),
          payload: response,
        })
      ).statusCode,
    ).toBe(204);
    const preview = await asking;
    expect(preview.statusCode).toBe(200);
    return preview.json<OperationImpactView>();
  }
  it("returns scoped read-only links and marks dormant reports stale", async () => {
    const route = apiPath(API_ROUTES.topology, { hostId });
    const viewer = (await fullySignedInUser(plane, admin, "observer", "viewer")).client;
    const view = (await viewer.get(route)).json<TopologyView>();
    expect(view).toMatchObject({ available: true, stale: false });
    expect(view.snapshot!.edges[0]!.kind).toBe("compose_association");
    expect((await viewer.post(impact(), { action: "update" })).statusCode).toBe(403);
    plane.clock.now += HOST_SILENT_AFTER_MILLISECONDS + 1;
    expect((await viewer.get(route)).json<TopologyView>().stale).toBe(true);
    expect((await admin.post(impact(), { action: "update" })).statusCode).toBe(409);
  });
  it("relays previews with inside access off and persists the reviewed fingerprint into the delivered job", async () => {
    const preview = await reviewed();
    const other = (await fullySignedInUser(plane, admin, "another-admin", "admin")).client;
    expect((await other.post(actionPath(), { action: "update", previewId: preview.id })).statusCode).toBe(409);
    const job = await admin.post(actionPath(), { action: "update", previewId: preview.id });
    expect(job.statusCode).toBe(200);
    const work = (
      await plane.runnerApp.inject({ method: "GET", url: RUNNER_ROUTES.work, headers: headers() })
    ).json<WorkResponse>();
    expect(work.jobs[0]).toMatchObject({ expectedResourcesFingerprint: HASH });
    expect((await admin.post(actionPath(), { action: "update", previewId: preview.id })).statusCode).toBe(409);
  });
  it("retains every sequential update fingerprint and rejects expired, blocked or unsupported reviews", async () => {
    const first = await reviewed();
    const second = await reviewed("worker", {
      ...answer,
      ok: true,
      fingerprint: "b".repeat(64),
      members: [{ name: "worker", protected: false }],
    });
    const run = await admin.post(apiPath(API_ROUTES.containerUpdates, { hostId }), {
      names: ["app", "worker"],
      previews: { app: first.id, worker: second.id },
    });
    expect(run.statusCode).toBe(200);
    let work = (
      await plane.runnerApp.inject({ method: "GET", url: RUNNER_ROUTES.work, headers: headers() })
    ).json<WorkResponse>();
    expect(work.jobs[0]).toMatchObject({ expectedResourcesFingerprint: HASH });
    await plane.runnerApp.inject({
      method: "POST",
      url: apiPath(RUNNER_ROUTES.jobResult, { jobId: work.jobs[0]!.id }),
      headers: headers(),
      payload: { succeeded: true, outcome: "Updated", output: null },
    });
    work = (
      await plane.runnerApp.inject({ method: "GET", url: RUNNER_ROUTES.work, headers: headers() })
    ).json<WorkResponse>();
    expect(work.jobs[0]).toMatchObject({ expectedResourcesFingerprint: "b".repeat(64) });
    const expired = await reviewed();
    plane.clock.now += TOPOLOGY_LIMITS.previewTtl;
    expect((await admin.post(actionPath(), { action: "update", previewId: expired.id })).statusCode).toBe(409);
    await heartbeat();
    const blocked = await reviewed("app", { ...answer, ok: true, refusals: ["Protected member"] });
    expect((await admin.post(actionPath(), { action: "update", previewId: blocked.id })).statusCode).toBe(409);
    await heartbeat(false);
    expect((await admin.post(impact(), { action: "update" })).statusCode).toBe(409);
  });
  it("bounds pending/ready reviews and clears them on restore or clock rollback", async () => {
    const service = plane.services.topology;
    const actor = {
      userId: plane.services.usersService.list()[0]!.id,
      username: "admin",
      ip: "127.0.0.1",
      requestId: "fixture",
    };
    const host = plane.services.hostsService.authenticate(token)!;
    async function ready() {
      const asking = service.preview(actor, "session", hostId, "app", "update");
      const request = service.take(host)[0]!;
      service.answer(host, request.id, answer);
      return asking;
    }
    const previews: OperationImpactView[] = [];
    for (let index = 0; index < TOPOLOGY_LIMITS.previews; index++) previews.push(await ready());
    await expect(service.preview(actor, "session", hostId, "app", "update")).rejects.toThrow("topology_busy");
    service.reset();
    expect(() => service.consume("session", hostId, "app", "update", previews[0]!.id)).toThrow(
      "topology_preview_expired",
    );
    const waiting = Array.from({ length: TOPOLOGY_LIMITS.relayPending }, () =>
      service.preview(actor, "session", hostId, "app", "update").then(
        () => "unexpected success",
        (error: Error) => error.message,
      ),
    );
    await expect(service.preview(actor, "session", hostId, "app", "update")).rejects.toThrow("topology_busy");
    service.reset();
    expect(await Promise.all(waiting)).toEqual(Array(TOPOLOGY_LIMITS.relayPending).fill("restore_maintenance"));
    const backwards = await ready();
    plane.clock.now--;
    expect(() => service.consume("session", hostId, "app", "update", backwards.id)).toThrow("topology_preview_expired");
  });
  it("never delivers a reviewed job to a runner that downgraded and ignores scope fingerprints", async () => {
    const first = await reviewed();
    await heartbeat(false);
    expect((await admin.post(actionPath(), { action: "update", previewId: first.id })).statusCode).toBe(409);
    await heartbeat();
    const second = await reviewed();
    const job = (await admin.post(actionPath(), { action: "update", previewId: second.id })).json<{ id: string }>();
    await heartbeat(false);
    const work = (
      await plane.runnerApp.inject({ method: "GET", url: RUNNER_ROUTES.work, headers: headers() })
    ).json<WorkResponse>();
    expect(work.jobs).toEqual([]);
    expect((await admin.get(apiPath(API_ROUTES.job, { jobId: job.id }))).json()).toMatchObject({
      status: "failed",
      outcome: expect.stringContaining("no longer supports"),
    });
    // An explicit legacy administrator request has no claimed review guarantee and retains its prior contract.
    expect((await admin.post(actionPath(), { action: "update" })).statusCode).toBe(200);
    const legacy = (
      await plane.runnerApp.inject({ method: "GET", url: RUNNER_ROUTES.work, headers: headers() })
    ).json<WorkResponse>();
    expect(legacy.jobs).toHaveLength(1);
    expect(legacy.jobs[0]).not.toHaveProperty("expectedResourcesFingerprint");
  });
  it("rejects an old polling process even before it sends an old-format heartbeat", async () => {
    const preview = await reviewed();
    const job = (await admin.post(actionPath(), { action: "update", previewId: preview.id })).json<{ id: string }>();
    const oldProcess = (
      await plane.runnerApp.inject({
        method: "GET",
        url: RUNNER_ROUTES.work,
        headers: { authorization: `Bearer ${token}` },
      })
    ).json<WorkResponse>();
    expect(oldProcess.jobs).toEqual([]);
    expect((await admin.get(apiPath(API_ROUTES.job, { jobId: job.id }))).json()).toMatchObject({
      status: "failed",
      outcome: expect.stringContaining("no longer supports"),
    });
  });
});
