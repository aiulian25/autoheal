import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { EVERY_RUNNER_CAPABILITY, heartbeatWith } from "../../../test/support/inventory.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { API_ERRORS, API_ROUTES, apiPath, type EnrolledHostView } from "../../shared/api.js";
import { AGENT_AUTOHEAL, DETECTOR_KEYS, HTTP_HEADERS } from "../../shared/constants.js";
import { RUNNER_ROUTES, type WorkResponse } from "../../shared/protocol.js";
import {
  PROBE_LIMITS,
  PROBE_SCOPE,
  PROBE_STATE,
  PROBE_TEXT,
  type ProbeBody,
  type ProbeTarget,
  type ProbeView,
} from "../../shared/probes.js";
import { hosts, jobs, tasks } from "../database/schema.js";
import type { DatabaseHandle } from "../database/connection.js";
import { nextStreak, ProbeService } from "./probe-service.js";
import { serviceProbes, serviceProbeSamples } from "./probe-schema.js";

const INTERVAL_MILLISECONDS = 60_000;

describe("how long a change must last", () => {
  const fresh = { state: PROBE_STATE.unknown, failures: 0, answers: 0 };
  it("goes down only after the failures asked for, and a good answer starts them over", () => {
    let streak = nextStreak(fresh, false, 3);
    streak = nextStreak(streak, false, 3);
    expect(streak.state).toBe(PROBE_STATE.unknown);
    expect(nextStreak(streak, false, 3).state).toBe(PROBE_STATE.down);
    expect(nextStreak(nextStreak(streak, true, 3), false, 3).failures).toBe(1);
  });
  it("comes back only after answers in a row, while a first answer counts at once", () => {
    expect(nextStreak(fresh, true, 3).state).toBe(PROBE_STATE.up);
    const down = { state: PROBE_STATE.down, failures: 3, answers: 0 };
    const once = nextStreak(down, true, 3);
    expect(once.state).toBe(PROBE_STATE.down);
    expect(nextStreak(once, true, 3).state).toBe(PROBE_STATE.up);
    expect(nextStreak(nextStreak(once, false, 3), true, 3).state).toBe(PROBE_STATE.down);
  });
});

describe("a host's service checks", () => {
  let plane: TestControlPlane;
  let admin: TestClient;
  let hostId: string;
  let token: string;
  let server: Server;
  let port: number;
  let hits: number;
  let status: number;

  const startServer = async (handler = true) => {
    server = createServer((_request, response) => {
      hits += 1;
      if (handler) response.writeHead(status).end();
    });
    await new Promise<void>((resolve) => server.listen(port ?? 0, "127.0.0.1", () => resolve()));
    port = (server.address() as AddressInfo).port;
  };
  const stopServer = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  const route = () => apiPath(API_ROUTES.hostProbes, { hostId });
  const bodyWith = (target: ProbeTarget, change: Partial<ProbeBody> = {}): ProbeBody => ({
    name: "Wiki",
    scope: PROBE_SCOPE.thisMachine,
    vantage: null,
    intervalSeconds: 60,
    timeoutSeconds: 1,
    failuresBeforeDown: 2,
    objectivePercent: null,
    target,
    ...change,
  });
  const web = (url = `http://127.0.0.1:${port}/`): ProbeTarget => ({
    kind: "http",
    url,
    expectedStatus: 200,
    ignoreCertificate: false,
  });
  const add = async (change: Partial<ProbeBody> = {}) => {
    const response = await admin.post(route(), bodyWith(web(), change));
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ id: string }>().id;
  };
  const shown = async () => (await admin.get(route())).json<ProbeView[]>()[0]!;
  const check = async () => {
    plane.clock.now += INTERVAL_MILLISECONDS;
    await plane.services.probes.tick();
    await plane.services.detectorService.run();
  };
  const openTasks = () =>
    plane.services.tasksService.openDetectorKeys().filter((key) => key.startsWith(DETECTOR_KEYS.probe));
  const maintenance = async (containerName: string | null = null) => {
    const response = await admin.post(apiPath(API_ROUTES.hostMaintenance, { hostId }), {
      containerName,
      reason: "Planned work",
      expiresAt: plane.clock.now + 60 * 60 * 1000,
    });
    expect(response.statusCode, response.body).toBe(200);
  };

  beforeEach(async () => {
    plane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(plane)).client;
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    hostId = enrolled.host.id;
    token = runnerTokenOf(enrolled);
    await plane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      payload: { ...heartbeatWith({ dryRun: false, containers: [] }), maintenanceGeneration: 0 },
      headers: { authorization: `Bearer ${token}`, [HTTP_HEADERS.runnerCapabilities]: EVERY_RUNNER_CAPABILITY },
    });
    hits = 0;
    status = 200;
    port = 0;
    await startServer();
  });

  afterEach(async () => {
    if (server.listening) await stopServer();
    await plane.app.close();
    await plane.runnerApp.close();
  });

  it("refuses destinations it was not allowed, and shapes that could carry a secret", async () => {
    const refused = async (target: ProbeTarget, scope: ProbeBody["scope"]) =>
      (await admin.post(route(), bodyWith(target, { scope }))).statusCode;
    expect(await refused(web("http://169.254.169.254/latest/"), PROBE_SCOPE.internet)).toBe(400);
    expect(await refused(web("http://169.254.169.254/latest/"), PROBE_SCOPE.localNetwork)).toBe(400);
    expect(await refused(web("http://192.168.10.2/"), PROBE_SCOPE.thisMachine)).toBe(400);
    expect(await refused(web("http://127.0.0.1/"), PROBE_SCOPE.internet)).toBe(400);
    expect(await refused({ kind: "tcp", host: "169.254.169.254", port: 80 }, PROBE_SCOPE.internet)).toBe(400);
    expect(await refused(web("http://user:secret@127.0.0.1/"), PROBE_SCOPE.thisMachine)).toBe(400);
    expect(await refused(web("http://127.0.0.1/?token=secret"), PROBE_SCOPE.thisMachine)).toBe(400);
    expect(await refused(web("file:///etc/passwd"), PROBE_SCOPE.thisMachine)).toBe(400);
    expect((await admin.get(route())).json()).toEqual([]);
  });

  it("is for admins: reading, adding and removing", async () => {
    const id = await add();
    const viewer = await fullySignedInUser(plane, admin, "operator", "viewer");
    expect((await viewer.client.get(route())).statusCode).toBe(403);
    expect((await viewer.client.post(route(), bodyWith(web()))).statusCode).toBe(403);
    expect((await viewer.client.delete(apiPath(API_ROUTES.hostProbe, { hostId, probeId: id }))).statusCode).toBe(403);
  });

  it("sees a service answer, and shows how available and how fast it was", async () => {
    await add({ objectivePercent: 99 });
    await check();
    const probe = await shown();
    expect(hits).toBe(1);
    expect(probe).toMatchObject({ state: PROBE_STATE.up, lastProblem: null, objectivePercent: 99 });
    expect(probe.day.percent).toBe(100);
    expect(probe.samples).toHaveLength(1);
    expect(probe.samples[0]!.outcome).toBe("up");
    expect(probe.lastLatencyMilliseconds).toBeGreaterThanOrEqual(0);
    expect(openTasks()).toEqual([]);
  });

  it("checks only when due", async () => {
    await add();
    await check();
    await plane.services.probes.tick();
    expect(hits).toBe(1);
  });

  it("opens a task only for a sustained outage, closes it on a sustained recovery, and changes nothing else", async () => {
    await add();
    await check();
    await stopServer();
    await check();
    expect((await shown()).state).toBe(PROBE_STATE.up);
    expect(openTasks()).toEqual([]);

    await check();
    expect((await shown()).state).toBe(PROBE_STATE.down);
    expect(openTasks()).toHaveLength(1);

    await startServer();
    await check();
    expect((await shown()).state).toBe(PROBE_STATE.down);
    expect(openTasks()).toHaveLength(1);
    await check();
    expect((await shown()).state).toBe(PROBE_STATE.up);
    expect(openTasks()).toEqual([]);
    const availability = (await shown()).day;
    expect(availability.down).toBe(2);
    expect(availability.percent).toBeCloseTo((3 / 5) * 100);
  });

  it("gives up in time on a service that hangs, and the reason reaches the task", async () => {
    await stopServer();
    await startServer(false);
    await add();
    await check();
    await check();
    expect((await shown()).lastProblem).toBe(PROBE_TEXT.timedOut(1));
    const [row] = plane.services.databaseHandle.database.select().from(tasks).all();
    expect(row!.title).toContain(PROBE_TEXT.timedOut(1));
    expect(row!.hostId).toBe(hostId);
  });

  it("does not ask or count anything during a window over the whole host, and says so", async () => {
    await add();
    await check();
    await maintenance();
    await stopServer();
    await check();
    await check();
    await check();
    const probe = await shown();
    expect(probe.inMaintenance).toBe(true);
    expect(probe.state).toBe(PROBE_STATE.up);
    expect(probe.day.down).toBe(0);
    expect(probe.day.maintenance).toBe(3);
    expect(probe.day.percent).toBe(100);
    expect(probe.samples.map(({ outcome }) => outcome)).toEqual(["up", "maintenance", "maintenance", "maintenance"]);
    expect(openTasks()).toEqual([]);
    expect(hits).toBe(1);
  });

  it("leaves a task as it was through a window, rather than closing and reopening it", async () => {
    await stopServer();
    await add();
    await check();
    await check();
    expect(openTasks()).toHaveLength(1);
    await maintenance();
    await check();
    expect(openTasks()).toHaveLength(1);
  });

  it("opens no task for an outage first noticed during a window", async () => {
    await stopServer();
    await add({ failuresBeforeDown: 1 });
    plane.clock.now += INTERVAL_MILLISECONDS;
    await plane.services.probes.tick();
    expect((await shown()).state).toBe(PROBE_STATE.down);
    await maintenance();
    await plane.services.detectorService.run();
    expect(openTasks()).toEqual([]);
  });

  it("is not held by a window over one container", async () => {
    await add();
    await maintenance("some-container");
    await check();
    expect(hits).toBe(1);
    expect((await shown()).inMaintenance).toBe(false);
  });

  it("does no privileged work however long a service is down, and gives the task to no agent", async () => {
    await stopServer();
    await add({ failuresBeforeDown: 1 });
    await check();
    await check();
    expect(openTasks()).toHaveLength(1);
    await plane.services.repairWorker.run();
    await plane.services.autohealWorker.run();
    await plane.services.autohealWorker.adviseUpdates();
    await plane.services.detectorService.run();
    const database = plane.services.databaseHandle.database;
    expect(database.select().from(jobs).all()).toEqual([]);
    const [task] = database.select().from(tasks).all();
    expect(task!.assigneeAgent).not.toBe(AGENT_AUTOHEAL);
    const work = await plane.runnerApp.inject({
      method: "GET",
      url: RUNNER_ROUTES.work,
      headers: { authorization: `Bearer ${token}`, [HTTP_HEADERS.runnerCapabilities]: EVERY_RUNNER_CAPABILITY },
    });
    expect(work.json<WorkResponse>().jobs).toEqual([]);
  });

  it("closes its task when removed, with its history", async () => {
    await stopServer();
    const id = await add({ failuresBeforeDown: 1 });
    await check();
    expect(openTasks()).toHaveLength(1);
    const removed = await admin.delete(apiPath(API_ROUTES.hostProbe, { hostId, probeId: id }));
    expect(removed.statusCode).toBe(204);
    await plane.services.detectorService.run();
    expect(openTasks()).toEqual([]);
    const database = plane.services.databaseHandle.database;
    expect(database.select().from(serviceProbeSamples).where(eq(serviceProbeSamples.probeId, id)).all()).toEqual([]);
    expect((await admin.delete(apiPath(API_ROUTES.hostProbe, { hostId, probeId: id }))).statusCode).toBe(404);
  });

  it("keeps to its limit per host", async () => {
    for (let index = 0; index < PROBE_LIMITS.perHost; index += 1) await add({ name: `Check ${index}` });
    expect((await admin.post(route(), bodyWith(web()))).statusCode).toBe(409);
  });

  it("keeps its samples within bounds, the newest kept", async () => {
    const id = await add();
    const database = plane.services.databaseHandle.database;
    const start = plane.clock.now - PROBE_LIMITS.samplesKept * 1000;
    database
      .insert(serviceProbeSamples)
      .values(
        Array.from({ length: PROBE_LIMITS.samplesKept + 10 }, (_, index) => ({
          probeId: id,
          at: start + index,
          outcome: "up" as const,
          latencyMilliseconds: 1,
        })),
      )
      .run();
    await check();
    const kept = database.select().from(serviceProbeSamples).where(eq(serviceProbeSamples.probeId, id)).all();
    expect(kept).toHaveLength(PROBE_LIMITS.samplesKept);
    expect(kept.some(({ at }) => at === plane.clock.now)).toBe(true);
    expect((await shown()).samples.length).toBe(PROBE_LIMITS.samplesShown);
  });

  it("says how much of the time it did not look, rather than counting that as up", async () => {
    await add();
    await check();
    plane.clock.now += 10 * INTERVAL_MILLISECONDS;
    const probe = await shown();
    expect(probe.day.percent).toBe(100);
    expect(probe.day.unknownPercent).toBeGreaterThan(80);
  });
});

describe("running many checks", () => {
  const body: ProbeBody = {
    name: "Wiki",
    scope: PROBE_SCOPE.thisMachine,
    vantage: null,
    intervalSeconds: 60,
    timeoutSeconds: 1,
    failuresBeforeDown: 1,
    objectivePercent: null,
    target: { kind: "tcp", host: "127.0.0.1", port: 1 },
  };
  let plane: TestControlPlane;
  let hostId: string;
  let database: DatabaseHandle;
  let admin: TestClient;
  beforeEach(async () => {
    plane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(plane)).client;
    hostId = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>().host.id;
    database = plane.services.databaseHandle;
  });
  afterEach(async () => {
    await plane.app.close();
    await plane.runnerApp.close();
  });
  const serviceWith = (check: ConstructorParameters<typeof ProbeService>[0]["check"]) =>
    new ProbeService({
      databaseHandle: database,
      maintenance: plane.services.maintenance,
      clock: () => plane.clock.now,
      check,
    });

  describe("asking for more checks than it may have, all at once", () => {
    const idle = () => serviceWith(async () => ({ ok: true, latencyMilliseconds: 1, problem: null }));
    const stored = () => database.database.select().from(serviceProbes).all().length;
    const racing = async (service: ProbeService, host: string, howMany: number) => {
      const asked = await Promise.allSettled(
        Array.from({ length: howMany }, (_, index) => service.create(host, { ...body, name: `Racing ${index}` })),
      );
      return {
        made: asked.filter(({ status }) => status === "fulfilled").length,
        refused: asked.flatMap((one) => (one.status === "rejected" ? [one.reason as { code?: string }] : [])),
      };
    };

    it("takes only the one place left on a host, however many ask for it at once", async () => {
      const service = idle();
      for (let index = 0; index < PROBE_LIMITS.perHost - 1; index += 1) await service.create(hostId, body);

      const { made, refused } = await racing(service, hostId, 4);

      expect(made).toBe(1);
      expect(stored()).toBe(PROBE_LIMITS.perHost);
      expect(refused.map(({ code }) => code)).toEqual(Array.from({ length: 3 }, () => API_ERRORS.probeLimitReached));
    });

    it("keeps the fleet's own bound, counting checks on every host together", async () => {
      const service = idle();
      const second = (await admin.post(API_ROUTES.hosts, { label: "Cedar" })).json<EnrolledHostView>().host.id;
      // Filled to one short of the fleet's limit, spread so no host is at its own.
      for (let index = 0; index < PROBE_LIMITS.total - 1; index += 1) {
        const host = index % 2 === 0 ? hostId : second;
        if (index < PROBE_LIMITS.perHost * 2) await service.create(host, body);
        else
          database.database
            .insert(serviceProbes)
            .values({
              id: `filler-${index}`,
              hostId: host,
              bodyJson: JSON.stringify(body),
              state: PROBE_STATE.unknown,
              stateSince: 0,
              failures: 0,
              answers: 0,
              createdAt: 0,
            })
            .run();
      }
      expect(stored()).toBe(PROBE_LIMITS.total - 1);

      const third = (await admin.post(API_ROUTES.hosts, { label: "Delta" })).json<EnrolledHostView>().host.id;
      const { made, refused } = await racing(service, third, 4);

      expect(made).toBe(1);
      expect(stored()).toBe(PROBE_LIMITS.total);
      expect(refused.map(({ code }) => code)).toEqual(Array.from({ length: 3 }, () => API_ERRORS.probeLimitReached));
    });

    it("gives a host nothing when it was revoked while its destination was being looked up", async () => {
      const service = idle();
      const asked = service.create(hostId, body);
      // Revoked in the window the look-up leaves open, as another request could.
      database.database.update(hosts).set({ status: "revoked" }).where(eq(hosts.id, hostId)).run();

      await expect(asked).rejects.toMatchObject({ code: API_ERRORS.hostRevoked });
      expect(stored()).toBe(0);
    });
  });

  it("runs no more than its limit at once, the rest waiting for a later tick", async () => {
    let running = 0;
    let highest = 0;
    let started = 0;
    const service = serviceWith(async () => {
      running += 1;
      started += 1;
      highest = Math.max(highest, running);
      await Promise.resolve();
      running -= 1;
      return { ok: true, latencyMilliseconds: 1, problem: null };
    });
    for (let index = 0; index < PROBE_LIMITS.atOnce + 3; index += 1) await service.create(hostId, body);
    await service.tick();
    expect(highest).toBeLessThanOrEqual(PROBE_LIMITS.atOnce);
    expect(started).toBe(PROBE_LIMITS.atOnce);
    await service.tick();
    expect(started).toBe(PROBE_LIMITS.atOnce + 3);
  });

  it("drops an answer that arrives after it was told to stop", async () => {
    let answer: () => void = () => undefined;
    const service = serviceWith(
      () =>
        new Promise((resolve) => {
          answer = () => resolve({ ok: false, latencyMilliseconds: null, problem: "late" });
        }),
    );
    await service.create(hostId, body);
    const ticked = service.tick();
    await new Promise((resolve) => setImmediate(resolve));
    service.reset();
    answer();
    await ticked;
    expect(service.ofHost(hostId)[0]).toMatchObject({ state: PROBE_STATE.unknown, lastCheckedAt: null });
  });
});
