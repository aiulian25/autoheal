import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { containerSnapshot, heartbeatWith } from "../../../test/support/inventory.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import {
  API_ROUTES,
  apiPath,
  type EnrolledHostView,
  type TaskSummaryView,
  type UpdateRunView,
} from "../../shared/api.js";
import { JOB_ANSWER_MILLISECONDS } from "../../shared/constants.js";
import { RUNNER_ROUTES, type ContainerSnapshot, type WorkResponse } from "../../shared/protocol.js";

const update = { status: "available" as const, checkedAt: 1, remoteDigest: `sha256:${"c".repeat(64)}` };
const healthy = (name: string) => ({ succeeded: true, outcome: `Updated ${name}, and it is healthy.`, output: null });

describe("updating several containers one at a time", () => {
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
    await report(
      [
        containerSnapshot({ name: "radicale", composeProject: null, update }),
        containerSnapshot({ name: "quantum", composeProject: null, update }),
        containerSnapshot({ name: "whoami", composeProject: null, update }),
        containerSnapshot({ name: "paperless" }),
        containerSnapshot({ name: "newt", composeProject: null, update }),
      ],
      ["newt"],
    );
    await controlPlane.services.detectorService.run();
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  async function report(containers: ContainerSnapshot[], protectedContainers: string[] = []) {
    const response = await controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      payload: heartbeatWith({ containers, dryRun: false, protectedContainers }),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
  }
  const runs = () => apiPath(API_ROUTES.containerUpdates, { hostId });
  const start = (names: string[], client = admin) => client.post(runs(), { names });
  const latest = async () => (await admin.get(runs())).json<UpdateRunView | null>();
  const takeWork = async () =>
    (
      await controlPlane.runnerApp.inject({
        method: "GET",
        url: RUNNER_ROUTES.work,
        headers: { authorization: `Bearer ${token}` },
      })
    ).json<WorkResponse>().jobs;
  const answer = (jobId: string, result: object) =>
    controlPlane.runnerApp.inject({
      method: "POST",
      url: apiPath(RUNNER_ROUTES.jobResult, { jobId }),
      payload: result,
      headers: { authorization: `Bearer ${token}` },
    });
  const openTitles = async () =>
    (await admin.get(API_ROUTES.tasks)).json<TaskSummaryView[]>().map((task) => task.title);

  it("says there is no run before the first", async () => {
    const response = await admin.get(runs());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toBeNull();
  });

  it("updates the ticked containers one after another, each closing its task once it is healthy", async () => {
    const started = await start(["radicale", "quantum"]);
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json<UpdateRunView>()).toMatchObject({
      names: ["radicale", "quantum"],
      status: "running",
      current: "radicale",
      done: [],
      failed: null,
    });

    const [first] = await takeWork();
    expect(first).toMatchObject({ action: "update", containerName: "radicale", requestedBy: "admin" });
    expect(await takeWork()).toEqual([]);
    expect((await answer(first!.id, healthy("radicale"))).statusCode).toBe(204);
    expect(await latest()).toMatchObject({ status: "running", current: "quantum", done: ["radicale"] });

    const [second] = await takeWork();
    expect(second).toMatchObject({ action: "update", containerName: "quantum", requestedBy: "Autoheal" });
    await answer(second!.id, healthy("quantum"));
    expect(await latest()).toMatchObject({ status: "finished", current: null, done: ["radicale", "quantum"] });
    expect(await takeWork()).toEqual([]);

    const open = await openTitles();
    expect(open).not.toContain("Update radicale on Alder");
    expect(open).not.toContain("Update quantum on Alder");
    expect(open).toContain("Update whoami on Alder");
    expect(controlPlane.stdout.join("")).toContain('"action":"container.update_run_started"');
  });

  it("stops at the first that does not come back healthy, and the ones after it wait", async () => {
    await start(["radicale", "quantum", "whoami"]);
    const [first] = await takeWork();
    await answer(first!.id, {
      succeeded: false,
      outcome: "radicale did not settle: it keeps restarting.",
      output: null,
    });
    expect(await latest()).toMatchObject({ status: "stopped", current: null, done: [], failed: "radicale" });
    expect(await takeWork()).toEqual([]);
    expect(await openTitles()).toEqual(
      expect.arrayContaining(["Update radicale on Alder", "Update quantum on Alder", "Update whoami on Alder"]),
    );
    // Stopped is ended: a person can start again with what is left.
    expect((await start(["quantum"])).statusCode).toBe(200);
  });

  it("stops when the runner takes one and never says how it went", async () => {
    await start(["radicale", "quantum"]);
    await takeWork();
    controlPlane.clock.now += JOB_ANSWER_MILLISECONDS + 1;
    expect(await takeWork()).toEqual([]);
    expect(await latest()).toMatchObject({ status: "stopped", failed: "radicale" });
  });

  it("stops when the next one can no longer be changed from here", async () => {
    await start(["radicale", "quantum"]);
    await report(
      [
        containerSnapshot({ name: "radicale", composeProject: null, update }),
        containerSnapshot({ name: "quantum", composeProject: null, update }),
      ],
      ["quantum"],
    );
    const [first] = await takeWork();
    await answer(first!.id, healthy("radicale"));
    expect(await latest()).toMatchObject({ status: "stopped", done: ["radicale"], failed: "quantum" });
    expect(await takeWork()).toEqual([]);
  });

  it("runs one at a time per host, and only for containers with a new image someone may apply", async () => {
    expect((await start(["radicale"])).statusCode).toBe(200);
    expect((await start(["quantum"])).json()).toEqual({ error: "update_run_busy" });
    const [first] = await takeWork();
    await answer(first!.id, healthy("radicale"));

    expect((await start(["paperless"])).json()).toEqual({ error: "no_update" });
    expect((await start(["ghost"])).json()).toEqual({ error: "container_not_found" });
    expect((await start(["newt"])).json()).toEqual({ error: "hands_off" });
    expect((await start([])).statusCode).toBe(400);
    expect(await takeWork()).toEqual([]);

    const { client: viewer } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    expect((await start(["quantum"], viewer)).statusCode).toBe(403);
    expect((await viewer.get(runs())).json<UpdateRunView>()).toMatchObject({ status: "finished", done: ["radicale"] });
  });
});
