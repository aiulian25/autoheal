import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { heartbeatWith } from "../../../test/support/inventory.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import { API_ROUTES, apiPath, type EnrolledHostView, type HostNetworksView, type JobView } from "../../shared/api.js";
import type { NetworkReport } from "../../shared/networks.js";
import { RUNNER_ROUTES, type Heartbeat, type WorkResponse } from "../../shared/protocol.js";

const LEFT: NetworkReport = {
  name: "wyrmrss_default",
  driver: "bridge",
  subnet: "192.168.96.0/20",
  gateway: "192.168.96.1",
  internal: false,
  project: "wyrmrss",
  projectHere: false,
  own: false,
  members: [],
};
const BRIDGE: NetworkReport = { ...LEFT, name: "bridge", project: null };
const NEW = { name: "media", driver: "bridge", internal: false, subnet: null, parent: null, containers: ["radarr"] };

describe("a host's networks", () => {
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
  const view = async () => (await admin.get(apiPath(API_ROUTES.hostNetworks, { hostId }))).json<HostNetworksView>();
  const act = (body: object) => admin.post(apiPath(API_ROUTES.hostActions, { hostId }), body);
  const removal = (names: string[]) => ({ action: "remove_networks", removal: { names, evenIfStoppedNeedIt: false } });
  const work = async () => (await runner("GET", RUNNER_ROUTES.work)).json<WorkResponse>().jobs;

  it("lists what the runner last reported, and keeps it when Docker could not list them that time", async () => {
    await report({});
    expect(await view()).toEqual({ networks: null, lastJob: null });

    await report({ networks: [LEFT, BRIDGE] });
    await report({});

    expect((await view()).networks).toEqual([LEFT, BRIDGE]);
  });

  it("asks nothing of a runner from before networks were reported", async () => {
    await report({});
    expect((await act(removal(["wyrmrss_default"]))).json()).toMatchObject({ error: "job_unavailable" });
    expect((await act({ action: "create_network", network: NEW })).json()).toMatchObject({ error: "job_unavailable" });
  });

  it("sends a removal to the runner, the same one once however it was ticked", async () => {
    await report({ networks: [LEFT, { ...LEFT, name: "other" }] });

    const first = (await act(removal(["wyrmrss_default", "other"]))).json<JobView>();
    const again = (await act(removal(["other", "wyrmrss_default"]))).json<JobView>();

    expect(again.id).toBe(first.id);
    expect((await view()).lastJob?.id).toBe(first.id);
    expect(await work()).toMatchObject([
      {
        action: "remove_networks",
        containerName: "",
        removal: { names: ["other", "wyrmrss_default"], evenIfStoppedNeedIt: false },
      },
    ]);
  });

  it("refuses to remove Docker's own, the runner's own, or what the host never reported", async () => {
    await report({ networks: [LEFT, BRIDGE, { ...LEFT, name: "autoheal_default", own: true }] });

    for (const name of ["bridge", "autoheal_default", "nobody-knows"]) {
      expect((await act(removal([name]))).json()).toMatchObject({ error: "network_not_found" });
    }
    expect(await work()).toEqual([]);
  });

  it("sends a new network to the runner, unless the name is taken or not a name", async () => {
    await report({ networks: [LEFT] });

    expect(
      (await act({ action: "create_network", network: { ...NEW, name: "wyrmrss_default" } })).json(),
    ).toMatchObject({
      error: "network_name_taken",
    });
    expect((await act({ action: "create_network", network: { ...NEW, name: "no spaces" } })).statusCode).toBe(400);
    expect((await act({ action: "create_network", network: { ...NEW, subnet: "not-a-range" } })).statusCode).toBe(400);

    await act({ action: "create_network", network: NEW });
    expect(await work()).toMatchObject([{ action: "create_network", network: NEW }]);
  });
});
