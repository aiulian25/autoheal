import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { heartbeatWith } from "../../../test/support/inventory.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { API_ROUTES, apiPath, type EnrolledHostView, type HostImagesView, type JobView } from "../../shared/api.js";
import { RUNNER_ROUTES, type Heartbeat, type UnusedImage, type WorkResponse } from "../../shared/protocol.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const KEPT: UnusedImage = {
  id: digest("b"),
  tags: ["ghcr.io/paperless-ngx/paperless-ngx:2-autoheal-previous"],
  repository: "ghcr.io/paperless-ngx/paperless-ngx",
  sizeBytes: 480_000_000,
  createdAt: Date.UTC(2026, 9, 12),
  keptByUpdate: true,
};
const NAMELESS: UnusedImage = {
  id: digest("c"),
  tags: [],
  repository: "ghcr.io/immich-app/immich-server",
  sizeBytes: 1_200_000_000,
  createdAt: Date.UTC(2026, 9, 1),
  keptByUpdate: false,
};

describe("a host's old images", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let token: string;
  let hostId: string;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    token = runnerTokenOf(enrolled);
    hostId = enrolled.host.id;
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  const runner = (method: "GET" | "POST", url: string, payload?: object) =>
    controlPlane.runnerApp.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  const report = async (overrides: Partial<Heartbeat>) =>
    expect(
      (await runner("POST", RUNNER_ROUTES.heartbeat, heartbeatWith({ dryRun: false, ...overrides }))).statusCode,
    ).toBe(200);
  const images = async () => (await admin.get(apiPath(API_ROUTES.hostImages, { hostId }))).json<HostImagesView>();
  const remove = (ids: string[], client = admin) =>
    client.post(apiPath(API_ROUTES.hostActions, { hostId }), { action: "remove_images", images: ids });

  it("lists what the runner last reported, and keeps it when Docker could not list them that time", async () => {
    await report({});
    expect(await images()).toEqual({ images: null, lastRemoval: null });

    await report({ unusedImages: [KEPT, NAMELESS] });
    await report({});

    expect((await images()).images).toEqual([KEPT, NAMELESS]);
    const unknownHost = await admin.get(apiPath(API_ROUTES.hostImages, { hostId: randomUUID() }));
    expect(unknownHost.json()).toMatchObject({ error: "host_not_found" });
  });

  it("removes the ones ticked, once, only ones the host reported, and only for an admin", async () => {
    await report({ unusedImages: [KEPT, NAMELESS] });
    const { client: viewer } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");

    const asked = (await remove([NAMELESS.id, KEPT.id])).json<JobView>();
    expect(asked).toMatchObject({ action: "remove_images", containerName: "", status: "pending" });
    expect((await remove([KEPT.id, NAMELESS.id])).json<JobView>().id).toBe(asked.id);
    expect((await remove([digest("9")])).json()).toMatchObject({ error: "image_not_found" });
    expect((await remove(["latest"])).statusCode).toBe(400);
    expect((await remove([KEPT.id], viewer)).statusCode).toBe(403);
    // Every unused image goes only on the host's schedule, which keeps the ones updates kept.
    expect((await admin.post(apiPath(API_ROUTES.hostActions, { hostId }), { action: "prune_images" })).statusCode).toBe(
      400,
    );

    const { jobs } = (await runner("GET", RUNNER_ROUTES.work)).json<WorkResponse>();
    expect(jobs).toEqual([
      expect.objectContaining({ action: "remove_images", images: [KEPT.id, NAMELESS.id], requestedBy: "admin" }),
    ]);
    const outcome = "Removed 2 images (1.7 GB).";
    await runner("POST", apiPath(RUNNER_ROUTES.jobResult, { jobId: asked.id }), {
      succeeded: true,
      outcome,
      output: null,
    });
    expect((await images()).lastRemoval).toMatchObject({ status: "succeeded", outcome });
  });
});
