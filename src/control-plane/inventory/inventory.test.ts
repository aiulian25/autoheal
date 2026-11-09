import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
  runnerTokenOf,
} from "../../../test/support/control-plane.js";
import {
  containerSnapshot,
  containerUsage,
  heartbeatWith,
  hostHealth,
  hostMetrics,
} from "../../../test/support/inventory.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import {
  API_ROUTES,
  apiPath,
  type ContainerUsageView,
  type ContainerView,
  type EnrolledHostView,
  type HostChangeView,
  type HostMetricsView,
  type HostView,
  type OverviewView,
} from "../../shared/api.js";
import {
  HOST_CHANGE_RETENTION_MILLISECONDS,
  HOST_SILENT_AFTER_MILLISECONDS,
  METRICS_FRESH_MILLISECONDS,
  METRICS_HISTORY_MILLISECONDS,
  METRICS_HISTORY_POINTS,
  METRICS_INTERVAL_MILLISECONDS,
} from "../../shared/constants.js";
import { RUNNER_ROUTES, type Heartbeat, type MetricsReport } from "../../shared/protocol.js";
import { MetricsStore } from "./metrics-store.js";

describe("the inventory", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let tokens: Record<string, string>;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
    tokens = {};
    for (const label of ["Alder", "Mini"]) {
      tokens[label] = runnerTokenOf((await admin.post(API_ROUTES.hosts, { label })).json<EnrolledHostView>());
    }
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  const report = async (label: string, heartbeat: Heartbeat) => {
    const response = await controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      payload: heartbeat,
      headers: { authorization: `Bearer ${tokens[label]}` },
    });
    expect(response.statusCode).toBe(200);
  };
  const reportMetrics = (label: string, metrics: MetricsReport) =>
    controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.metrics,
      payload: metrics,
      headers: { authorization: `Bearer ${tokens[label]}` },
    });
  const host = async (label: string) =>
    (await admin.get(API_ROUTES.hosts)).json<HostView[]>().find((candidate) => candidate.label === label)!;
  const containers = async (query = "") =>
    (await admin.get(`${API_ROUTES.containers}${query}`)).json<ContainerView[]>();

  it("shows what a report left out to fit, keeping the last of each, until a report comes whole", async () => {
    await report("Alder", heartbeatWith());
    expect((await host("Alder")).reportTrimmed).toBeNull();

    await report("Alder", heartbeatWith({ networks: undefined, host: null, trimmed: ["networks", "host"] }));
    const trimmed = await host("Alder");
    expect(trimmed.reportTrimmed).toEqual(["networks", "host"]);
    expect(trimmed.health).not.toBeNull();

    await report("Alder", heartbeatWith());
    expect((await host("Alder")).reportTrimmed).toBeNull();
  });

  it("shows a reporting runner's recovery hold on its host until it ends, the runner goes quiet or holds nothing", async () => {
    const until = controlPlane.clock.now + HOST_SILENT_AFTER_MILLISECONDS / 2;
    await report("Alder", heartbeatWith({ recoveryHold: { reason: "no_saved_state", until } }));
    expect((await host("Alder")).recoveryHold).toEqual({ reason: "no_saved_state", until });
    expect((await host("Mini")).recoveryHold).toBeNull();
    // Its time is up before its runner next reports.
    controlPlane.clock.now = until;
    expect((await host("Alder")).recoveryHold).toBeNull();

    const fixNeeded = { reason: "save_failed", until: null } as const;
    await report("Alder", heartbeatWith({ recoveryHold: fixNeeded }));
    expect((await host("Alder")).recoveryHold).toEqual(fixNeeded);
    // A runner from before holds were reported, or one that holds nothing now.
    await report("Alder", heartbeatWith());
    expect((await host("Alder")).recoveryHold).toBeNull();

    await report("Alder", heartbeatWith({ recoveryHold: fixNeeded }));
    // A quiet runner's last hold may be over by now: its host shows it is silent instead.
    controlPlane.clock.now += HOST_SILENT_AFTER_MILLISECONDS + 1;
    expect((await host("Alder")).recoveryHold).toBeNull();
  });

  it("shows how far a host's clock is from the control plane's as its last full report found it, while it reports", async () => {
    await report(
      "Alder",
      heartbeatWith({ hostClock: controlPlane.clock.now - 95_000, host: hostHealth({ ntpActive: false }) }),
    );
    expect(await host("Alder")).toMatchObject({ clockOffsetSeconds: -95, health: { ntpActive: false } });
    expect((await host("Mini")).clockOffsetSeconds).toBeNull();
    // A report of its containers alone keeps it; a full one says it anew, or that its runner could not tell.
    await report("Alder", heartbeatWith({ host: null }));
    expect((await host("Alder")).clockOffsetSeconds).toBe(-95);
    await report("Alder", heartbeatWith({ hostClock: controlPlane.clock.now + 3_000 }));
    expect((await host("Alder")).clockOffsetSeconds).toBe(3);
    await report("Alder", heartbeatWith());
    expect((await host("Alder")).clockOffsetSeconds).toBeNull();
    // A quiet host's last reading may be long out of date.
    await report("Alder", heartbeatWith({ hostClock: controlPlane.clock.now - 95_000 }));
    controlPlane.clock.now += HOST_SILENT_AFTER_MILLISECONDS + 1;
    expect((await host("Alder")).clockOffsetSeconds).toBeNull();
  });

  it("shows where a container's image's code lives as its runner read it, and nothing from a runner before that", async () => {
    const source = "https://github.com/paperless-ngx/paperless-ngx";
    await report("Alder", heartbeatWith({ containers: [containerSnapshot({ name: "paperless", source })] }));
    expect((await containers())[0]).toMatchObject({ name: "paperless", source });
    await report("Alder", heartbeatWith({ containers: [containerSnapshot({ name: "paperless" })] }));
    expect((await containers())[0]!.source).toBeNull();
  });

  it("preserves optional rollback recovery metadata through heartbeat and dashboard views", async () => {
    await report(
      "Alder",
      heartbeatWith({ containers: [containerSnapshot({ name: "paperless", recovery: { owner: "paperless" } })] }),
    );
    expect((await containers())[0]).toMatchObject({ name: "paperless", recovery: { owner: "paperless" } });
    await report("Alder", heartbeatWith({ containers: [containerSnapshot({ name: "paperless" })] }));
    expect((await containers())[0]!.recovery).toBeUndefined();
  });

  it("shows each host's health and container counts from its runner's latest report", async () => {
    await report(
      "Alder",
      heartbeatWith({
        containers: [
          containerSnapshot({ name: "paperless" }),
          containerSnapshot({ name: "tika", state: "exited", exitCode: 1, health: "none" }),
          containerSnapshot({ name: "backup-job", state: "exited", exitCode: 0, health: "none" }),
        ],
      }),
    );
    expect(await host("Alder")).toMatchObject({
      state: "online",
      health: hostHealth(),
      containerCount: 3,
      runningCount: 1,
      problemCount: 1,
    });
    expect(await host("Mini")).toMatchObject({ state: "never_seen", health: null, containerCount: 0 });
  });

  it("journals what changed between two reports, nothing on the first, one container's on request, two weeks long", async () => {
    const hostId = (await host("Alder")).id;
    const changes = async (query = "") =>
      (await admin.get(`${apiPath(API_ROUTES.hostChanges, { hostId })}${query}`)).json<HostChangeView[]>();
    const database = (id: string, image: string) => containerSnapshot({ name: "paperless-db", containerId: id, image });
    await report("Alder", heartbeatWith({ containers: [database("aaaaaaaaaaaa", "postgres:16")] }));
    expect(await changes()).toEqual([]);

    controlPlane.clock.now += METRICS_INTERVAL_MILLISECONDS;
    await report(
      "Alder",
      heartbeatWith({ containers: [database("bbbbbbbbbbbb", "postgres:17"), containerSnapshot()] }),
    );
    expect((await changes()).map((change) => [change.kind, change.containerName])).toEqual([
      ["appeared", "paperless"],
      ["recreated", "paperless-db"],
    ]);
    expect(await changes("?containerName=paperless-db")).toMatchObject([
      { kind: "recreated", details: { imageBefore: "postgres:16", imageAfter: "postgres:17" } },
    ]);
    expect((await admin.get(`${apiPath(API_ROUTES.hostChanges, { hostId })}?limit=0`)).statusCode).toBe(400);

    // Two weeks later the next report clears what is older (read through the service: the session is long over).
    controlPlane.clock.now += HOST_CHANGE_RETENTION_MILLISECONDS + METRICS_INTERVAL_MILLISECONDS;
    await report("Alder", heartbeatWith({ containers: [database("bbbbbbbbbbbb", "postgres:17")] }));
    const kept = controlPlane.services.inventoryService.changes(hostId, { limit: 10 });
    expect(kept.map((change) => [change.kind, change.containerName])).toEqual([["removed", "paperless"]]);
  });

  it("keeps the last health when a report could not read it", async () => {
    await report("Alder", heartbeatWith({ host: hostHealth({ pendingUpdates: 7 }) }));
    await report("Alder", heartbeatWith({ host: null }));
    expect((await host("Alder")).health?.pendingUpdates).toBe(7);
  });

  it("lists every host's containers, problems first, with protected ones marked", async () => {
    await report(
      "Alder",
      heartbeatWith({
        protectedContainers: ["npm"],
        containers: [
          containerSnapshot({ name: "npm", image: "jc21/nginx-proxy-manager:latest", composeProject: "npm" }),
          containerSnapshot({ name: "paperless", health: "unhealthy" }),
        ],
      }),
    );
    await report(
      "Mini",
      heartbeatWith({
        containers: [containerSnapshot({ name: "ollama", image: "ollama/ollama:0.12", composeProject: null })],
      }),
    );
    const listed = await containers();
    expect(listed.map((container) => `${container.hostLabel}/${container.name}`)).toEqual([
      "Alder/paperless",
      "Alder/npm",
      "Mini/ollama",
    ]);
    expect(listed[0]).toMatchObject({ problem: "unhealthy", protected: false, hostState: "online" });
    expect(listed[1]).toMatchObject({ problem: null, protected: true });
  });

  it("reads a host's report once rather than on every look, and the new one once it comes", async () => {
    await report("Alder", heartbeatWith({ containers: [containerSnapshot({ name: "paperless" })] }));
    const inventory = controlPlane.services.inventoryService;
    const hostId = (await host("Alder")).id;
    inventory.containers();
    inventory.hosts();
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(inventory.containers({ hostId }).map(({ name }) => name)).toEqual(["paperless"]);
      expect(inventory.hosts().find(({ id }) => id === hostId)?.containerCount).toBe(1);
      expect(parse.mock.calls.filter(([text]) => String(text).includes('"paperless"'))).toEqual([]);

      await report("Alder", heartbeatWith({ containers: [containerSnapshot({ name: "tika" })] }));
      expect(inventory.containers({ hostId }).map(({ name }) => name)).toEqual(["tika"]);
    } finally {
      parse.mockRestore();
    }
  });

  it("filters by host, by problems and by search text", async () => {
    await report(
      "Alder",
      heartbeatWith({
        containers: [
          containerSnapshot({ name: "paperless", state: "restarting" }),
          containerSnapshot({ name: "redis", image: "redis:7", composeProject: "paperless" }),
        ],
      }),
    );
    await report(
      "Mini",
      heartbeatWith({
        containers: [containerSnapshot({ name: "ollama", image: "ollama/ollama:0.12", composeProject: null })],
      }),
    );
    const alder = await host("Alder");
    const names = (listed: ContainerView[]) => listed.map((container) => container.name);
    expect(names(await containers(`?hostId=${alder.id}`))).toEqual(["paperless", "redis"]);
    expect(names(await containers("?problemsOnly=true"))).toEqual(["paperless"]);
    expect(names(await containers("?search=REDIS"))).toEqual(["redis"]);
    expect(names(await containers("?search=paperless"))).toEqual(["paperless", "redis"]);
    expect(names(await containers("?search=mini"))).toEqual(["ollama"]);
    expect(names(await containers("?search=%20%20"))).toHaveLength(3);
    expect((await admin.get(`${API_ROUTES.containers}?hostId=not-a-uuid`)).statusCode).toBe(400);
  });

  it("marks a silent host's containers as last seen, and drops a revoked host's", async () => {
    await report("Alder", heartbeatWith());
    await report("Mini", heartbeatWith({ containers: [containerSnapshot({ name: "ollama" })] }));
    controlPlane.clock.now += HOST_SILENT_AFTER_MILLISECONDS + 1;
    expect((await containers()).map((container) => container.hostState)).toEqual(["silent", "silent"]);
    const mini = await host("Mini");
    await admin.post(apiPath(API_ROUTES.hostRevoke, { hostId: mini.id }));
    expect((await containers()).map((container) => container.hostLabel)).toEqual(["Alder"]);
  });

  it("sums it all up for the overview", async () => {
    await report(
      "Alder",
      heartbeatWith({
        containers: [
          containerSnapshot({ name: "paperless" }),
          containerSnapshot({ name: "tika", state: "exited", exitCode: 1, health: "none" }),
          containerSnapshot({ name: "job", state: "exited", exitCode: 0, health: "none" }),
        ],
      }),
    );
    expect((await admin.get(API_ROUTES.overview)).json<OverviewView>()).toEqual({
      hosts: { total: 2, online: 1, silent: 0, neverSeen: 1 },
      containers: { total: 3, running: 1, stopped: 2, problems: 1, updates: 0 },
      tasks: { open: 0, byPriority: { urgent: 0, high: 0, medium: 0, low: 0 }, mine: 0 },
      homeAssistant: null,
    });
  });

  it("shows each host's latest stats, each running container's usage, and their last half hour", async () => {
    await report(
      "Alder",
      heartbeatWith({
        containers: [
          containerSnapshot({ name: "paperless" }),
          containerSnapshot({ name: "tika", state: "exited", exitCode: 1, health: "none" }),
        ],
      }),
    );
    const firstAt = controlPlane.clock.now;
    // tika stopped after this report; the newer inventory wins.
    const first = await reportMetrics("Alder", {
      host: hostMetrics(),
      containers: [containerUsage({ name: "paperless" }), containerUsage({ name: "tika" })],
    });
    expect(first.statusCode).toBe(204);
    controlPlane.clock.now += METRICS_INTERVAL_MILLISECONDS;
    const busier = hostMetrics({ cpu: { ...hostMetrics().cpu, busyPercent: 90 } });
    await reportMetrics("Alder", { host: busier, containers: [containerUsage({ name: "paperless", cpuPercent: 40 })] });

    const alder = await host("Alder");
    expect(alder.metrics).toEqual({ ...busier, at: controlPlane.clock.now });
    expect((await host("Mini")).metrics).toBeNull();
    const listed = await containers(`?hostId=${alder.id}`);
    const usageOf = (name: string) => listed.find((container) => container.name === name)?.usage;
    expect(usageOf("paperless")).toMatchObject({ cpuPercent: 40, at: controlPlane.clock.now });
    expect(usageOf("tika")).toBeNull();

    const hostHistory = (await admin.get(apiPath(API_ROUTES.hostMetrics, { hostId: alder.id }))).json<
      HostMetricsView[]
    >();
    expect(hostHistory.map((point) => [point.at, point.cpu.busyPercent])).toEqual([
      [firstAt, 14.2],
      [controlPlane.clock.now, 90],
    ]);
    const containerHistory = await admin.get(
      apiPath(API_ROUTES.containerMetrics, { hostId: alder.id, containerName: "paperless" }),
    );
    expect(containerHistory.json<ContainerUsageView[]>().map((point) => point.cpuPercent)).toEqual([3.5, 40]);
    expect(containerHistory.json<ContainerUsageView[]>()[0]).not.toHaveProperty("name");
    const unknown = apiPath(API_ROUTES.containerMetrics, { hostId: alder.id, containerName: "nothing" });
    expect((await admin.get(unknown)).json()).toEqual([]);
    expect((await admin.get(apiPath(API_ROUTES.hostMetrics, { hostId: "not-a-uuid" }))).statusCode).toBe(400);
  });

  it("blanks the dials once a runner stops sending stats, keeping the history", async () => {
    await report("Alder", heartbeatWith());
    await reportMetrics("Alder", { host: hostMetrics(), containers: [containerUsage()] });
    controlPlane.clock.now += METRICS_FRESH_MILLISECONDS + 1;
    const alder = await host("Alder");
    expect(alder.metrics).toBeNull();
    expect((await containers())[0]?.usage).toBeNull();
    expect((await admin.get(apiPath(API_ROUTES.hostMetrics, { hostId: alder.id }))).json()).toHaveLength(1);
  });

  it("expires offline history and removes revoked-host metrics without another report", async () => {
    await reportMetrics("Alder", { host: hostMetrics(), containers: [containerUsage()] });
    await reportMetrics("Mini", { host: hostMetrics(), containers: [containerUsage()] });
    const alder = await host("Alder"),
      mini = await host("Mini");
    expect(controlPlane.services.metricsStore.retained).toEqual({ hosts: 2, points: 4 });
    expect((await admin.post(apiPath(API_ROUTES.hostRevoke, { hostId: alder.id }))).statusCode).toBe(200);
    expect(controlPlane.services.metricsStore.retained).toEqual({ hosts: 1, points: 2 });
    // A request whose authentication completed before revoke must not repopulate the removed series.
    controlPlane.services.metricsStore.record(alder.id, { host: hostMetrics(), containers: [containerUsage()] });
    expect((await admin.get(apiPath(API_ROUTES.hostMetrics, { hostId: alder.id }))).json()).toEqual([]);
    expect((await reportMetrics("Alder", { host: hostMetrics(), containers: [] })).statusCode).toBe(401);
    controlPlane.clock.now += METRICS_HISTORY_MILLISECONDS + 1;
    controlPlane.services.metricsStore.sweep();
    expect(controlPlane.services.metricsStore.retained).toEqual({ hosts: 0, points: 0 });
    expect((await admin.get(apiPath(API_ROUTES.hostMetrics, { hostId: mini.id }))).json()).toEqual([]);
    expect(
      (await admin.get(apiPath(API_ROUTES.containerMetrics, { hostId: mini.id, containerName: "paperless" }))).json(),
    ).toEqual([]);
  });

  it("refuses a stats report that is malformed or out of bounds", async () => {
    const tooBusy = hostMetrics({ cpu: { ...hostMetrics().cpu, busyPercent: 101 } });
    expect((await reportMetrics("Alder", { host: tooBusy, containers: [] })).statusCode).toBe(400);
    const negative = containerUsage({ readBytesPerSecond: -1 });
    expect((await reportMetrics("Alder", { host: null, containers: [negative] })).statusCode).toBe(400);
    const stranger = await controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.metrics,
      payload: { host: hostMetrics(), containers: [] },
      headers: { authorization: "Bearer not-a-runner" },
    });
    expect(stranger.statusCode).toBe(401);
  });

  it("is readable by viewers and by nobody signed out", async () => {
    const { client: viewer } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    const alder = await host("Alder");
    const histories = [
      apiPath(API_ROUTES.hostMetrics, { hostId: alder.id }),
      apiPath(API_ROUTES.containerMetrics, { hostId: alder.id, containerName: "paperless" }),
    ];
    for (const route of [API_ROUTES.hosts, API_ROUTES.containers, API_ROUTES.overview, ...histories]) {
      expect((await viewer.get(route)).statusCode).toBe(200);
      expect((await controlPlane.client().get(route)).statusCode).toBe(401);
    }
  });
});

describe("MetricsStore", () => {
  it("keeps half an hour, and no more points or containers than a runner reporting on time would send", () => {
    let now = Date.UTC(2026, 9, 21, 12);
    const store = new MetricsStore(() => now);
    const start = now;
    // Twice as fast as runners report, for an hour, with a new container name every time.
    for (let report = 0; report < (2 * 2 * METRICS_HISTORY_MILLISECONDS) / METRICS_INTERVAL_MILLISECONDS; report += 1) {
      store.record("host", { host: hostMetrics(), containers: [containerUsage({ name: `job-${report}` })] });
      now += METRICS_INTERVAL_MILLISECONDS / 2;
    }
    const history = store.hostHistory("host");
    expect(history).toHaveLength(METRICS_HISTORY_POINTS);
    expect(history[0]!.at).toBeGreaterThanOrEqual(now - METRICS_HISTORY_MILLISECONDS);
    expect(store.containerHistory("host", "job-0")).toEqual([]);
    expect(store.hostHistory("other")).toEqual([]);
    expect(start).toBeLessThan(history[0]!.at);
  });
});
