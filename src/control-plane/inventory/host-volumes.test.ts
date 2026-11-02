import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { heartbeatWith } from "../../../test/support/inventory.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import { API_ROUTES, apiPath, type EnrolledHostView, type HostVolumesView, type JobView } from "../../shared/api.js";
import { RUNNER_ROUTES, type Heartbeat, type WorkResponse } from "../../shared/protocol.js";
import type { VolumeReport } from "../../shared/volumes.js";

const EMPTY: VolumeReport = {
  name: "936121521c03",
  driver: "local",
  sizeBytes: 0,
  createdAt: "",
  nameless: true,
  project: null,
  projectHere: false,
  own: false,
  ownedBy: null,
  members: [],
};
const GUARD: VolumeReport = { ...EMPTY, name: "autoheal-guard-370", nameless: false, own: true };

describe("a host's volumes", () => {
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
  const view = async () => (await admin.get(apiPath(API_ROUTES.hostVolumes, { hostId }))).json<HostVolumesView>();
  const act = (body: object) => admin.post(apiPath(API_ROUTES.hostActions, { hostId }), body);
  const removal = (names: string[], evenWithData = false) => ({
    action: "remove_volumes",
    volumeRemoval: { names, evenWithData },
  });
  const work = async () => (await runner("GET", RUNNER_ROUTES.work)).json<WorkResponse>().jobs;

  it("lists what the runner last reported, and keeps it when Docker could not list them that time", async () => {
    await report({});
    expect(await view()).toEqual({ volumes: null, lastJob: null });

    await report({ volumes: [EMPTY, GUARD] });
    await report({});

    expect((await view()).volumes).toEqual([EMPTY, GUARD]);
  });

  it("asks nothing of a runner from before volumes were reported", async () => {
    await report({});
    expect((await act(removal(["936121521c03"]))).json()).toMatchObject({ error: "job_unavailable" });
    expect((await act({ action: "create_volume", volume: { name: "a", share: null } })).json()).toMatchObject({
      error: "job_unavailable",
    });
  });

  it("sends a removal to the runner with whether a person said yes, the same one once", async () => {
    await report({ volumes: [EMPTY, { ...EMPTY, name: "other" }] });

    const first = (await act(removal(["936121521c03", "other"], true))).json<JobView>();
    const again = (await act(removal(["other", "936121521c03"], true))).json<JobView>();

    expect(again.id).toBe(first.id);
    expect((await view()).lastJob?.id).toBe(first.id);
    expect(await work()).toMatchObject([
      {
        action: "remove_volumes",
        containerName: "",
        removal: { names: ["936121521c03", "other"], evenWithData: true },
      },
    ]);
  });

  it("refuses to remove Autoheal's own records, or what the host never reported", async () => {
    await report({ volumes: [EMPTY, GUARD] });

    for (const name of ["autoheal-guard-370", "nobody-knows"]) {
      expect((await act(removal([name], true))).json()).toMatchObject({ error: "volume_not_found" });
    }
    expect(await work()).toEqual([]);
  });

  it("sends a new volume to the runner, unless the name is taken, or its share would add mount options", async () => {
    await report({ volumes: [EMPTY] });
    const volume = { name: "media", share: { kind: "nfs", address: "192.168.10.5", path: "/export" } };

    expect(
      (await act({ action: "create_volume", volume: { name: "936121521c03", share: null } })).json(),
    ).toMatchObject({
      error: "volume_name_taken",
    });
    const sneaky = { ...volume, share: { ...volume.share, address: "nas,uid=0" } };
    expect((await act({ action: "create_volume", volume: sneaky })).statusCode).toBe(400);

    await act({ action: "create_volume", volume });
    expect(await work()).toMatchObject([{ action: "create_volume", volume }]);
  });

  it("asks the runner what a volume holds, and answers with what it says", async () => {
    await report({ volumes: [EMPTY] });
    const asked = admin.post(apiPath(API_ROUTES.hostVolumeLook, { hostId }), { name: "936121521c03" });
    const taken = (await runner("GET", RUNNER_ROUTES.containerAccess)).json<{
      volumeLooks: { id: string; name: string }[];
    }>();
    expect(taken.volumeLooks).toMatchObject([{ name: "936121521c03" }]);
    const answer = {
      error: null,
      entries: [{ path: "a", folder: false, sizeBytes: 1, modifiedAt: 5 }],
      partial: false,
    };

    await runner("POST", apiPath(RUNNER_ROUTES.volumeLookAnswer, { requestId: taken.volumeLooks[0]!.id }), answer);

    expect((await asked).json()).toEqual(answer);
  });
});
