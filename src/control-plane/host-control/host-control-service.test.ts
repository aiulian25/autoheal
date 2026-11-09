import type { NetworkReport } from "../../shared/networks.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { containerSnapshot, heartbeatWith, hostHealth } from "../../../test/support/inventory.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import {
  API_ERRORS,
  API_ROUTES,
  apiPath,
  type ContainerView,
  type EnrolledHostView,
  type HostControlView,
  type HostView,
  type JobView,
} from "../../shared/api.js";
import {
  RUNNER_ROUTES,
  type ContainerSnapshot,
  type HeartbeatResponse,
  type PackageFacts,
  type WorkResponse,
} from "../../shared/protocol.js";
import { IGNORE_EVERY_VERSION, RESTART_CHOICE, UPDATE_CHOICE } from "../../shared/constants.js";
import type { Actor } from "../audit/audit-log.js";
import { auditEvents, ignoredVersions, users } from "../database/schema.js";

const update = { status: "available" as const, checkedAt: 1, remoteDigest: `sha256:${"c".repeat(64)}` };
// Sunday 25 October 2026, 03:30 in London: inside the default window, the clocks just gone back.
const IN_SUNDAY_WINDOW = Date.UTC(2026, 9, 25, 3, 30);
const NEXT_SUNDAY_OPENS = Date.UTC(2026, 9, 25, 3, 0);
const packages: PackageFacts = {
  setting: "off",
  unsupported: null,
  unattendedUpgrades: false,
  rebootPackages: [],
  kernelWaiting: null,
  timeZone: "Europe/Lisbon",
  recentChanges: [],
};

describe("what each host's page lets Autoheal do on its own", () => {
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

  // A live host with paperless, its database, and the runner's own container, protected.
  async function report(
    dryRun = false,
    more: ContainerSnapshot[] = [],
    networks?: NetworkReport[],
  ): Promise<HeartbeatResponse> {
    const response = await controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      payload: heartbeatWith({
        dryRun,
        protectedContainers: ["autoheal"],
        host: hostHealth({ packages }),
        ...(networks === undefined ? {} : { networks }),
        containers: [
          containerSnapshot({ name: "paperless", image: "ghcr.io/paperless-ngx/paperless-ngx:2", update }),
          containerSnapshot({ name: "paperless-db", image: "postgres:16-alpine" }),
          containerSnapshot({ name: "autoheal", image: "autoheal:local" }),
          ...more,
        ],
      }),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    return response.json<HeartbeatResponse>();
  }
  const containers = async () => (await admin.get(`${API_ROUTES.containers}?hostId=${hostId}`)).json<ContainerView[]>();
  const byName = async (name: string) => (await containers()).find((container) => container.name === name)!;
  const tick = (payload: object, client = admin) =>
    client.put(apiPath(API_ROUTES.containerControls, { hostId }), payload);
  const control = async () => (await admin.get(apiPath(API_ROUTES.hostControl, { hostId }))).json<HostControlView>();
  const takeWork = async () =>
    (
      await controlPlane.runnerApp.inject({
        method: "GET",
        url: RUNNER_ROUTES.work,
        headers: { authorization: `Bearer ${token}` },
      })
    ).json<WorkResponse>().jobs;

  it("asks first for everything on a host added now, and tells its runner so", async () => {
    const answer = await report();

    expect(answer.control).toEqual({
      restartByDefault: false,
      restart: { paperless: false, "paperless-db": false, autoheal: false },
      whenFailingByDefault: "ask",
      whenFailing: { paperless: "ask", "paperless-db": "ask", autoheal: "ask" },
      undoFailedUpdates: [],
      clearBuildCache: false,
      restartsResetAt: {},
    });
    expect((await byName("paperless")).byItself).toEqual({
      restart: "ask",
      update: "ask",
      restartLock: null,
      updateLock: null,
    });
    expect((await byName("paperless-db")).byItself.updateLock).toBe("database");
    expect((await byName("autoheal")).byItself).toMatchObject({ restartLock: "protected", updateLock: "protected" });
    expect(await control()).toMatchObject({
      restartDefault: "ask",
      updateDefault: "ask",
      imageCleanup: "off",
      nextCleanupAt: null,
    });
  });

  it("lets an admin clear a container's restarts this hour, and tells its runner with each answer for an hour", async () => {
    const resetPath = (containerName: string) => apiPath(API_ROUTES.restartsReset, { hostId, containerName });
    // A runner from before restart waits takes no reset.
    await report();
    expect((await admin.post(resetPath("paperless"))).json()).toEqual({ error: "restart_reset_unsupported" });

    const againAt = controlPlane.clock.now + 30 * 60_000;
    const answer = async () =>
      (
        await controlPlane.runnerApp.inject({
          method: "POST",
          url: RUNNER_ROUTES.heartbeat,
          payload: heartbeatWith({
            dryRun: false,
            protectedContainers: ["autoheal"],
            containers: [containerSnapshot({ name: "paperless" })],
            restartBudget: { paperless: 2 },
            restartWait: { paperless: { againAt, looksAgainAt: null } },
          }),
          headers: { authorization: `Bearer ${token}` },
        })
      ).json<HeartbeatResponse>();
    const host = async () => (await admin.get(API_ROUTES.hosts)).json<HostView[]>().find((each) => each.id === hostId)!;
    expect((await answer()).control?.restartsResetAt).toEqual({});
    expect(await host()).toMatchObject({
      restartBudget: { paperless: 2 },
      restartWait: { paperless: { againAt, looksAgainAt: null } },
      restartResets: {},
    });

    const asked = controlPlane.clock.now;
    expect((await admin.post(resetPath("paperless"))).statusCode).toBe(204);
    expect((await host()).restartResets).toEqual({ paperless: asked });
    expect((await answer()).control?.restartsResetAt).toEqual({ paperless: asked });
    const audited = controlPlane.services.databaseHandle.database
      .select()
      .from(auditEvents)
      .all()
      .filter((event) => event.action === "container.restarts_reset");
    expect(audited.map((event) => JSON.parse(event.detailsJson) as unknown)).toEqual([{ containerName: "paperless" }]);

    expect((await admin.post(resetPath("gone"))).json()).toEqual({ error: "container_not_found" });
    const viewer = (await fullySignedInUser(controlPlane, admin, "observer", "viewer")).client;
    expect((await viewer.post(resetPath("paperless"))).statusCode).toBe(403);
    // After the hour the restarts it cleared would have left the window anyway: it is no longer sent.
    controlPlane.clock.now += 60 * 60_000;
    expect((await answer()).control?.restartsResetAt).toEqual({});
  });

  it("answers for one container or several, and the runner and the update rules follow", async () => {
    await report();

    expect((await tick({ names: ["paperless", "paperless-db"], restart: "restart" })).statusCode).toBe(204);
    expect((await tick({ names: ["paperless"], update: "apply" })).statusCode).toBe(204);

    expect((await byName("paperless")).byItself).toMatchObject({ restart: "restart", update: "apply" });
    expect((await byName("paperless")).update.policy).toBe("auto");
    expect((await byName("paperless-db")).byItself).toMatchObject({ restart: "restart", update: "ask" });
    expect((await report()).control?.restart).toEqual({ paperless: true, "paperless-db": true, autoheal: false });
  });

  it("only tells about one container, and never updates it: its runner neither restarts nor asks", async () => {
    await report();
    await controlPlane.services.detectorService.run();
    expect((await tick({ names: ["paperless"], restart: "tell", update: "never" })).statusCode).toBe(204);

    const paperless = await byName("paperless");
    expect(paperless.byItself).toMatchObject({ restart: "tell", update: "never" });
    expect(paperless.update.policy).toBe("off");
    const control = (await report()).control!;
    // A runner from before telling reads restart: false, and asks first instead.
    expect(control.restart.paperless).toBe(false);
    expect(control.whenFailing?.paperless).toBe("tell");
    await controlPlane.services.detectorService.run();
    const titles = (await admin.get(API_ROUTES.tasks)).json<{ title: string }[]>().map((task) => task.title);
    expect(titles).not.toContain("Update paperless on Alder");
    const updateJob = await admin.post(apiPath(API_ROUTES.containerActions, { hostId, containerName: "paperless" }), {
      action: "update",
    });
    expect(updateJob.json()).toEqual({ error: "job_unavailable" });

    await admin.put(apiPath(API_ROUTES.hostControl, { hostId }), { restartDefault: "tell" });
    expect((await report()).control).toMatchObject({ restartByDefault: false, whenFailingByDefault: "tell" });
    // Going unwatched is one container's answer, never a whole host's.
    const unwatchedHost = await admin.put(apiPath(API_ROUTES.hostControl, { hostId }), { restartDefault: "ignore" });
    expect(unwatchedHost.statusCode).toBe(400);
  });

  it("leaves one container unwatched: no problem shown, not counted while stopped, and its runner told", async () => {
    const nightly = containerSnapshot({
      name: "nightly",
      image: "busybox:1",
      state: "exited",
      health: "none",
      exitCode: 1,
    });
    await report(false, [nightly]);
    const alder = async () => (await admin.get(API_ROUTES.hosts)).json<HostView[]>()[0]!;
    expect(await alder()).toMatchObject({ containerCount: 4, runningCount: 3, problemCount: 1 });

    expect((await tick({ names: ["nightly"], restart: "ignore" })).statusCode).toBe(204);
    expect(await byName("nightly")).toMatchObject({ problem: null, byItself: { restart: "ignore" } });
    expect(await alder()).toMatchObject({ containerCount: 3, runningCount: 3, problemCount: 0 });
    const control = (await report(false, [nightly])).control!;
    expect(control.whenFailing?.nightly).toBe("ignore");
    expect(control.restart.nightly).toBe(false);
  });

  it("gives a container to Ollama: its runner restarts it first, and undoes a new image that fails at once", async () => {
    await report();
    expect((await tick({ names: ["paperless"], restart: "repair", update: "always" })).statusCode).toBe(204);

    const paperless = await byName("paperless");
    expect(paperless.byItself).toMatchObject({ restart: "repair", update: "always" });
    expect(paperless.update.policy).toBe("always");
    const control = (await report()).control!;
    expect(control.restart.paperless).toBe(true);
    expect(control.whenFailing?.paperless).toBe("restart");
    expect(control.undoFailedUpdates).toEqual(["paperless"]);
    // A database waits for a person, whatever else it is given.
    expect((await tick({ names: ["paperless-db"], update: "always" })).json()).toMatchObject({
      error: "control_locked",
    });
  });

  it("refuses a tick that is fixed, a container the host does not have, and a viewer", async () => {
    await report();
    const { client: viewer } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");

    expect((await tick({ names: ["paperless-db"], update: "apply" })).json()).toMatchObject({
      error: "control_locked",
    });
    expect((await tick({ names: ["autoheal"], restart: "restart" })).statusCode).toBe(409);
    expect((await tick({ names: ["nextcloud"], restart: "restart" })).statusCode).toBe(404);
    expect((await tick({ names: ["paperless"] })).statusCode).toBe(400);
    expect((await tick({ names: ["paperless"], restart: true })).statusCode).toBe(400);
    expect((await tick({ names: ["paperless"], restart: "restart" }, viewer)).statusCode).toBe(403);
  });

  it("keeps its hands off the old container an update keeps aside: no tick, no update, nothing but its logs", async () => {
    const parked = containerSnapshot({
      name: "paperless-autoheal-old",
      image: "ghcr.io/paperless-ngx/paperless-ngx:2",
      state: "exited",
      exitCode: 143,
      updatePolicy: "auto",
      update,
    });
    const answer = await report(false, [parked]);
    const act = (action: string) =>
      admin.post(apiPath(API_ROUTES.containerActions, { hostId, containerName: parked.name }), { action });

    expect(answer.control?.restart[parked.name]).toBe(false);
    expect(await byName(parked.name)).toMatchObject({
      handsOff: "parked",
      byItself: { restart: "ask", update: "ask", restartLock: "parked", updateLock: "parked" },
      update: { status: "available", policy: "off" },
      problem: null,
    });
    expect((await tick({ names: [parked.name], update: "apply" })).statusCode).toBe(409);
    expect((await act("update")).json()).toMatchObject({ error: "hands_off" });
    expect((await act("start")).json()).toMatchObject({ error: "hands_off" });
    expect((await act("logs")).json<JobView>()).toMatchObject({ action: "logs", status: "pending" });
  });

  it("keeps the host's own settings, and says when the next clean-up comes on a host that acts", async () => {
    await report(true);
    const saved = await admin.put(apiPath(API_ROUTES.hostControl, { hostId }), {
      restartDefault: "restart",
      imageCleanup: "weekly",
      clearBuildCache: true,
    });

    expect(saved.json<HostControlView>()).toMatchObject({
      restartDefault: "restart",
      updateDefault: "ask",
      imageCleanup: "weekly",
      clearBuildCache: true,
      timeZone: "Europe/Lisbon",
      // Only watching: nothing is removed.
      nextCleanupAt: null,
    });
    expect((await report()).control).toMatchObject({ restartByDefault: true, clearBuildCache: true });
    expect((await control()).nextCleanupAt).toBe(NEXT_SUNDAY_OPENS);
    expect((await admin.put(apiPath(API_ROUTES.hostControl, { hostId }), {})).statusCode).toBe(400);
  });

  describe("networks left behind", () => {
    const left: NetworkReport = {
      name: "wyrmrss_default",
      driver: "bridge",
      subnet: null,
      gateway: null,
      internal: false,
      project: "wyrmrss",
      projectHere: false,
      own: false,
      members: [],
    };
    const networks = [left, { ...left, name: "by-hand", project: null }];

    it("stay unless the host's page says to clear them", async () => {
      await admin.put(apiPath(API_ROUTES.hostControl, { hostId }), { imageCleanup: "weekly" });
      controlPlane.clock.now = IN_SUNDAY_WINDOW;
      await report(false, [], networks);
      controlPlane.services.hostControl.tick();
      expect((await takeWork()).map(({ action }) => action)).toEqual(["prune_images"]);
    });

    it("go with the nightly clean-up when it does, but never one a person made", async () => {
      await admin.put(apiPath(API_ROUTES.hostControl, { hostId }), { imageCleanup: "weekly", clearLeftNetworks: true });
      controlPlane.clock.now = IN_SUNDAY_WINDOW;
      await report(false, [], networks);
      controlPlane.services.hostControl.tick();
      const work = await takeWork();
      expect(work.map(({ action }) => action)).toEqual(["prune_images", "remove_networks"]);
      expect(work[1]).toMatchObject({
        requestedBy: "Autoheal",
        removal: { names: ["wyrmrss_default"], evenIfStoppedNeedIt: false },
      });
    });
  });

  it("removes unused images in the host's window, once, and only where the host acts", async () => {
    await admin.put(apiPath(API_ROUTES.hostControl, { hostId }), { imageCleanup: "weekly" });
    controlPlane.clock.now = IN_SUNDAY_WINDOW;
    await report(true);
    controlPlane.services.hostControl.tick();
    expect(await takeWork()).toEqual([]);

    await report();
    controlPlane.services.hostControl.tick();
    controlPlane.services.hostControl.tick();
    const [cleanup] = await takeWork();
    expect(cleanup).toMatchObject({ action: "prune_images", containerName: "", requestedBy: "Autoheal" });

    const answer = { succeeded: true, outcome: "Removed 3 images (24 MB).", output: null };
    await controlPlane.runnerApp.inject({
      method: "POST",
      url: apiPath(RUNNER_ROUTES.jobResult, { jobId: cleanup!.id }),
      payload: answer,
      headers: { authorization: `Bearer ${token}` },
    });
    controlPlane.services.hostControl.tick();
    expect(await takeWork()).toEqual([]);
    // Days later the admin's session has long expired: read what the page would show directly.
    expect(controlPlane.services.hostControl.view(hostId).lastCleanup).toMatchObject({
      status: "succeeded",
      outcome: "Removed 3 images (24 MB).",
    });
  });

  it("ignores a newer version, or every one, so it asks nothing, until a person stops ignoring it", async () => {
    const pinned = (name: string, newerTag: string) =>
      containerSnapshot({
        name,
        image: `example/${name}:1.0`,
        update: { status: "current", checkedAt: 1, remoteDigest: null, newerTag },
      });
    await report(false, [pinned("wiki", "1.1"), pinned("cache", "2.0")]);
    await controlPlane.services.detectorService.run();
    const open = async () =>
      (await admin.get(API_ROUTES.tasks))
        .json<{ title: string; status: string }[]>()
        .filter((task) => task.status !== "done" && task.title.includes(" is out for "))
        .map((task) => task.title)
        .toSorted();
    expect(await open()).toEqual(["1.1 is out for wiki on Alder", "2.0 is out for cache on Alder"]);
    const route = apiPath(API_ROUTES.hostIgnoredVersions, { hostId });

    const ignored = await admin.put(route, {
      changes: [
        { container: "wiki", version: "1.1" },
        { container: "cache", version: "*" },
      ],
    });
    expect(ignored.statusCode, ignored.body).toBe(204);
    const containers = async () =>
      (await admin.get(`${API_ROUTES.containers}?hostId=${hostId}`)).json<ContainerView[]>();
    const byName = (list: ContainerView[], name: string) => list.find((container) => container.name === name)!;
    expect(byName(await containers(), "wiki").update).toMatchObject({ newerTag: "1.1", ignored: "1.1" });
    expect(byName(await containers(), "cache").update).toMatchObject({ newerTag: "2.0", ignored: "*" });
    await controlPlane.services.detectorService.run();
    expect(await open()).toEqual([]);

    // A version after the ignored one shows again; a container ignored for every version stays quiet.
    await report(false, [pinned("wiki", "1.2"), pinned("cache", "2.1")]);
    await controlPlane.services.detectorService.run();
    expect(await open()).toEqual(["1.2 is out for wiki on Alder"]);

    await admin.put(route, { changes: [{ container: "cache", version: null }] });
    await controlPlane.services.detectorService.run();
    expect(await open()).toEqual(["1.2 is out for wiki on Alder", "2.1 is out for cache on Alder"]);
  });

  it("lets only an admin ignore versions, of containers the host has", async () => {
    await report();
    const { client: viewer } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    const route = apiPath(API_ROUTES.hostIgnoredVersions, { hostId });
    expect((await viewer.put(route, { changes: [{ container: "paperless", version: "*" }] })).statusCode).toBe(403);
    expect((await admin.put(route, { changes: [{ container: "gone", version: "*" }] })).json()).toEqual({
      error: "container_not_found",
    });
  });

  describe("asked directly", () => {
    let actor: Actor;

    beforeEach(async () => {
      await report();
      const { id } = controlPlane.services.databaseHandle.database.select({ id: users.id }).from(users).get()!;
      actor = { userId: id, username: "admin", ip: "127.0.0.1", requestId: "test" };
    });

    const service = () => controlPlane.services.hostControl;
    const stored = () =>
      controlPlane.services.databaseHandle.database
        .select({ container: ignoredVersions.containerName, version: ignoredVersions.version })
        .from(ignoredVersions)
        .all()
        .toSorted((left, right) => left.container.localeCompare(right.container));

    it.each([
      { restart: RESTART_CHOICE.restart, update: UPDATE_CHOICE.ask, told: RESTART_CHOICE.restart, undone: false },
      { restart: RESTART_CHOICE.repair, update: UPDATE_CHOICE.ask, told: RESTART_CHOICE.restart, undone: true },
      { restart: RESTART_CHOICE.ask, update: UPDATE_CHOICE.ask, told: RESTART_CHOICE.ask, undone: false },
      { restart: RESTART_CHOICE.tell, update: UPDATE_CHOICE.ask, told: RESTART_CHOICE.tell, undone: false },
      { restart: RESTART_CHOICE.ignore, update: UPDATE_CHOICE.ask, told: RESTART_CHOICE.ignore, undone: false },
      { restart: RESTART_CHOICE.ask, update: UPDATE_CHOICE.always, told: RESTART_CHOICE.ask, undone: true },
    ])(
      "tells the runner what a container answered $restart and $update for comes to",
      ({ restart, update, told, undone }) => {
        service().setContainers(actor, hostId, { names: ["paperless"], restart, update });
        const control = service().forRunner(hostId);
        expect(control.whenFailing?.paperless).toBe(told);
        expect(control.restart.paperless).toBe(told === RESTART_CHOICE.restart);
        expect(control.undoFailedUpdates?.includes("paperless")).toBe(undone);
        expect(control.whenFailing?.["paperless-db"]).toBe(RESTART_CHOICE.ask);
      },
    );

    it("ignores versions all at once or not at all", () => {
      const refused = expect.objectContaining({ code: API_ERRORS.containerNotFound });
      const valid = { container: "paperless", version: "2.14" };
      expect(() => service().ignoreVersions(actor, hostId, [valid, { container: "gone", version: "1.0" }])).toThrow(
        refused,
      );
      expect(() =>
        service().ignoreVersions(actor, hostId, [valid, { container: "paperless-db", version: "not a tag" }]),
      ).toThrow(refused);
      expect(stored()).toEqual([]);
    });

    it("keeps one ignored version per container, replaced by the latest, and forgets it on none", () => {
      service().ignoreVersions(actor, hostId, [
        { container: "paperless", version: "2.14" },
        { container: "paperless-db", version: "17" },
      ]);
      service().ignoreVersions(actor, hostId, [{ container: "paperless", version: IGNORE_EVERY_VERSION }]);
      expect(stored()).toEqual([
        { container: "paperless", version: IGNORE_EVERY_VERSION },
        { container: "paperless-db", version: "17" },
      ]);
      service().ignoreVersions(actor, hostId, [{ container: "paperless-db", version: null }]);
      expect(stored()).toEqual([{ container: "paperless", version: IGNORE_EVERY_VERSION }]);
    });
  });
});
