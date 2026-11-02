import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
  runnerTokenOf,
} from "../../../test/support/control-plane.js";
import { containerSnapshot, heartbeatWith, hostHealth, hostMetrics } from "../../../test/support/inventory.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import {
  API_ROUTES,
  apiPath,
  type CreatedWidgetKeyView,
  type EnrolledHostView,
  type WidgetKeyView,
} from "../../shared/api.js";
import { MILLISECONDS_PER_MINUTE } from "../../shared/constants.js";
import { RUNNER_ROUTES } from "../../shared/protocol.js";

describe("the Homepage widget", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  const widget = (key?: string) =>
    controlPlane.client().request({
      method: "GET",
      url: API_ROUTES.widget,
      headers: key === undefined ? {} : { "x-api-key": key },
    });

  it("answers counts, and nothing else, to a valid key", async () => {
    const token = runnerTokenOf((await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>());
    await controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      payload: heartbeatWith({
        containers: [
          containerSnapshot({ name: "paperless" }),
          containerSnapshot({ name: "tika", state: "exited", exitCode: 1, health: "none" }),
          containerSnapshot({
            name: "whoami",
            update: { status: "available", checkedAt: 1, remoteDigest: `sha256:${"d".repeat(64)}` },
          }),
        ],
      }),
      headers: { authorization: `Bearer ${token}` },
    });
    const created = (await admin.post(API_ROUTES.widgetKeys, { name: "Homepage" })).json<CreatedWidgetKeyView>();
    expect(created.secret).toMatch(/^ahw_[A-Za-z0-9_-]{43}$/);
    expect(created.key).toMatchObject({
      name: "Homepage",
      hint: created.secret.slice(-4),
      createdBy: "admin",
      lastUsedAt: null,
    });

    const answered = await widget(created.secret);
    expect(answered.statusCode).toBe(200);
    expect(answered.json()).toEqual({
      hostsOnline: 1,
      hostsTotal: 1,
      containersRunning: 2,
      containersTotal: 3,
      containerProblems: 1,
      updatesAvailable: 1,
      openTasks: 0,
      urgentTasks: 0,
      needsYou: 0,
    });
    const [listed] = (await admin.get(API_ROUTES.widgetKeys)).json<WidgetKeyView[]>();
    expect(listed?.lastUsedAt).toBe(controlPlane.clock.now);
    expect(JSON.stringify(listed)).not.toContain(created.secret);
  });

  it("notes a key's use at most once a minute, however often Homepage asks, and corrects a time from the future", async () => {
    const created = (await admin.post(API_ROUTES.widgetKeys, { name: "Homepage" })).json<CreatedWidgetKeyView>();
    const lastUsed = async () => (await admin.get(API_ROUTES.widgetKeys)).json<WidgetKeyView[]>()[0]!.lastUsedAt;
    const firstUse = controlPlane.clock.now;
    expect((await widget(created.secret)).statusCode).toBe(200);
    controlPlane.clock.now += MILLISECONDS_PER_MINUTE / 2;
    expect((await widget(created.secret)).statusCode).toBe(200);
    expect(await lastUsed()).toBe(firstUse);
    controlPlane.clock.now = firstUse + MILLISECONDS_PER_MINUTE;
    expect((await widget(created.secret)).statusCode).toBe(200);
    expect(await lastUsed()).toBe(firstUse + MILLISECONDS_PER_MINUTE);
    controlPlane.clock.now = firstUse - MILLISECONDS_PER_MINUTE;
    expect((await widget(created.secret)).statusCode).toBe(200);
    expect(await lastUsed()).toBe(firstUse - MILLISECONDS_PER_MINUTE);
  });

  it("refuses a missing, wrong or revoked key, even to someone signed in", async () => {
    const created = (await admin.post(API_ROUTES.widgetKeys, { name: "Homepage" })).json<CreatedWidgetKeyView>();
    expect((await widget()).statusCode).toBe(401);
    expect((await widget(`ahw_${"x".repeat(43)}`)).statusCode).toBe(401);
    expect((await admin.get(API_ROUTES.widget)).statusCode).toBe(401);
    const revoked = await admin.request({
      method: "DELETE",
      url: apiPath(API_ROUTES.widgetKey, { keyId: created.key.id }),
    });
    expect(revoked.statusCode).toBe(204);
    expect((await widget(created.secret)).statusCode).toBe(401);
    expect((await admin.get(API_ROUTES.widgetKeys)).json()).toEqual([]);
    expect(controlPlane.stdout.join("")).toContain('"action":"widget_key.revoked"');
  });

  const metrics = (authorization?: string) =>
    controlPlane.client().request({
      method: "GET",
      url: API_ROUTES.metrics,
      headers: authorization === undefined ? {} : { authorization },
    });
  const keyFor = async (name: string, scope?: string) =>
    (await admin.post(API_ROUTES.widgetKeys, { name, scope })).json<CreatedWidgetKeyView>();

  it("serves a metrics key the fleet's gauges in OpenMetrics, labelled by host and mount but never by container", async () => {
    const token = runnerTokenOf((await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>());
    // Delta was added but has never reported: it says only that it is down. Rowan was revoked: it is gone.
    await admin.post(API_ROUTES.hosts, { label: "Delta" });
    const rowan = (await admin.post(API_ROUTES.hosts, { label: "Rowan" })).json<EnrolledHostView>();
    expect((await admin.post(apiPath(API_ROUTES.hostRevoke, { hostId: rowan.host.id }))).statusCode).toBe(200);
    const report = (url: string, payload: object) =>
      controlPlane.runnerApp.inject({ method: "POST", url, payload, headers: { authorization: `Bearer ${token}` } });
    const health = hostHealth();
    const data = { path: "/mnt/data", totalBytes: 1_000_000, usedBytes: 400_000, availableBytes: 600_000 };
    await report(
      RUNNER_ROUTES.heartbeat,
      heartbeatWith({
        restartBudget: { paperless: 2, tika: 1 },
        host: { ...health, disks: [...health.disks, data] },
        containers: [
          containerSnapshot({ name: "paperless" }),
          containerSnapshot({ name: "tika", state: "exited", exitCode: 1, health: "none" }),
          containerSnapshot({
            name: "whoami",
            update: { status: "available", checkedAt: 1, remoteDigest: `sha256:${"d".repeat(64)}` },
          }),
        ],
      }),
    );
    expect((await report(RUNNER_ROUTES.metrics, { host: hostMetrics(), containers: [] })).statusCode).toBe(204);
    const created = await keyFor("Prometheus", "metrics");
    expect(created.key.scope).toBe("metrics");

    const answered = await metrics(`Bearer ${created.secret}`);
    expect(answered.statusCode).toBe(200);
    expect(answered.headers["content-type"]).toBe("application/openmetrics-text; version=1.0.0; charset=utf-8");
    // Every answer under /api is kept from caches.
    expect(answered.headers["cache-control"]).toBe("no-store");
    const lines = answered.body.split("\n");
    expect(lines).toEqual(
      expect.arrayContaining([
        "autoheal_incidents_awaiting_approval 0",
        'autoheal_host_up{host="Alder"} 1',
        'autoheal_host_up{host="Delta"} 0',
        'autoheal_host_cpu_busy_ratio{host="Alder"} 0.142',
        'autoheal_host_memory_used_bytes{host="Alder"} 7516192768',
        'autoheal_host_memory_total_bytes{host="Alder"} 17179869184',
        'autoheal_host_filesystem_size_bytes{host="Alder",path="/"} 536870912000',
        'autoheal_host_filesystem_used_bytes{host="Alder",path="/"} 225485783040',
        'autoheal_host_filesystem_available_bytes{host="Alder",path="/mnt/data"} 600000',
        'autoheal_host_load1{host="Alder"} 0.5',
        'autoheal_host_load15{host="Alder"} 0.3',
        'autoheal_host_containers{host="Alder"} 3',
        'autoheal_host_containers_running{host="Alder"} 2',
        'autoheal_host_containers_with_problems{host="Alder"} 1',
        'autoheal_host_image_updates{host="Alder"} 1',
        'autoheal_host_os_updates{host="Alder"} 3',
        'autoheal_host_restarts_this_hour{host="Alder"} 3',
      ]),
    );
    expect(
      lines.filter((line) => /^autoheal_tasks_open\{priority="(urgent|high|medium|low)"\} \d+$/.test(line)),
    ).toHaveLength(4);
    expect(lines.filter((line) => line.includes('host="Delta"'))).toEqual(['autoheal_host_up{host="Delta"} 0']);
    expect(answered.body).not.toContain("Rowan");
    expect(answered.body.endsWith("\n# EOF\n")).toBe(true);
    for (const name of ["paperless", "tika", "whoami"]) {
      expect(answered.body).not.toContain(name);
    }
  });

  it("lets each key read only what it was made for, and only as its reader sends it", async () => {
    const homepage = await keyFor("Homepage");
    const prometheus = await keyFor("Prometheus", "metrics");
    const listed = (await admin.get(API_ROUTES.widgetKeys)).json<WidgetKeyView[]>();
    expect(listed.map((key) => [key.name, key.scope])).toEqual([
      ["Homepage", "widget"],
      ["Prometheus", "metrics"],
    ]);
    expect((await widget(homepage.secret)).statusCode).toBe(200);
    expect((await widget(prometheus.secret)).statusCode).toBe(401);
    expect((await metrics(`Bearer ${prometheus.secret}`)).statusCode).toBe(200);
    expect((await metrics(`Bearer ${homepage.secret}`)).statusCode).toBe(401);
    // Prometheus sends a bearer token: the widget's header, or the key alone, is not one.
    const asWidget = await controlPlane.client().request({
      method: "GET",
      url: API_ROUTES.metrics,
      headers: { "x-api-key": prometheus.secret },
    });
    expect(asWidget.statusCode).toBe(401);
    expect((await metrics(prometheus.secret)).statusCode).toBe(401);
    expect((await metrics()).statusCode).toBe(401);
    expect((await admin.get(API_ROUTES.metrics)).statusCode).toBe(401);
    const revoked = await admin.request({
      method: "DELETE",
      url: apiPath(API_ROUTES.widgetKey, { keyId: prometheus.key.id }),
    });
    expect(revoked.statusCode).toBe(204);
    expect((await metrics(`Bearer ${prometheus.secret}`)).statusCode).toBe(401);
    expect(controlPlane.stdout.join("")).toContain('"scope":"metrics"');
  });

  it("lets only admins manage keys", async () => {
    const { client: viewer } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    expect((await viewer.get(API_ROUTES.widgetKeys)).statusCode).toBe(403);
    expect((await viewer.post(API_ROUTES.widgetKeys, { name: "mine" })).statusCode).toBe(403);
  });
});
