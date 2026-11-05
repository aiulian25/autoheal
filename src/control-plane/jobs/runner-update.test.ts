import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestClient, type TestControlPlane } from "../../../test/support/control-plane.js";
import { heartbeatWith } from "../../../test/support/inventory.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { API_ROUTES, apiPath, type EnrolledHostView, type HostView } from "../../shared/api.js";
import { HOST_KIND, HTTP_STATUS, JOB_ACTION } from "../../shared/constants.js";
import { decodeJoinCode } from "../../shared/join-code.js";
import { RUNNER_ROUTES, type WorkResponse } from "../../shared/protocol.js";
import { hosts, jobs } from "../database/schema.js";

describe("updating a sidecar runner from the dashboard", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let hostId: string;
  let token: string;

  const ask = (client: TestClient = admin) =>
    client.post(apiPath(API_ROUTES.hostActions, { hostId }), { action: JOB_ACTION.updateRunner });
  const runnerSays = (path: string, payload: object) =>
    controlPlane.runnerApp.inject({
      method: "POST",
      url: path,
      payload,
      headers: { authorization: `Bearer ${token}` },
    });
  // The runner's own call for what is waiting: the one that hands jobs out.
  const takeWork = async () =>
    (
      await controlPlane.runnerApp.inject({
        method: "GET",
        url: RUNNER_ROUTES.work,
        headers: { authorization: `Bearer ${token}` },
      })
    ).json<WorkResponse>().jobs;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    token = decodeJoinCode(enrolled.joinCode)!.token;
    await runnerSays(RUNNER_ROUTES.heartbeat, heartbeatWith({ hostLabel: "Alder" }));
    hostId = (await admin.get(API_ROUTES.hosts)).json<HostView[]>().find(({ label }) => label === "Alder")!.id;
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  it("gives a sidecar runner the job, carrying no image of anyone's choosing", async () => {
    expect((await ask()).statusCode).toBe(HTTP_STATUS.ok);

    const work = await takeWork();
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({ action: JOB_ACTION.updateRunner });
    expect(JSON.stringify(work[0])).not.toContain("ghcr.io");
  });

  it("tells every runner the exact release it would move to, never a moving tag", async () => {
    const answer = (await runnerSays(RUNNER_ROUTES.heartbeat, heartbeatWith({ hostLabel: "Alder" }))).json<{
      release: { image: string; version: string };
    }>();

    expect(answer.release.image).toMatch(/:\d+\.\d+\.\d+$/);
    expect(answer.release.image).not.toMatch(/:(latest|\d+)$/);
  });

  it.each([HOST_KIND.local, HOST_KIND.ssh])(
    "refuses it for a %s host, which moves with the control plane",
    async (kind) => {
      controlPlane.services.databaseHandle.database.update(hosts).set({ kind }).where(eq(hosts.id, hostId)).run();

      const refused = await ask();

      expect(refused.json()).toEqual({ error: "runner_update_not_here" });
      expect(controlPlane.services.databaseHandle.database.select().from(jobs).all()).toEqual([]);
    },
  );

  it("is a person's decision: one who may not change the host is refused", async () => {
    const viewer = (await fullySignedInUser(controlPlane, admin, "mira", "viewer")).client;

    expect((await ask(viewer)).statusCode).toBe(HTTP_STATUS.forbidden);
  });
});
