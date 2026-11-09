import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { API_ROUTES, type EnrolledHostView } from "../../src/shared/api.js";
import { HTTP_HEADERS } from "../../src/shared/constants.js";
import { RUNNER_ROUTES, type ContainerSnapshot, type HostHealth } from "../../src/shared/protocol.js";
import { FakeOllama } from "../fakes/fake-ollama.js";
import { runnerTokenOf, startTestControlPlane } from "../support/control-plane.js";
import {
  EVERY_RUNNER_CAPABILITY,
  containerSnapshot,
  containerUsage,
  heartbeatWith,
  hostHealth,
  hostMetrics,
} from "../support/inventory.js";
import { fullySignedInAdmin } from "../support/second-factor.js";

// The README's pictures, of the real dashboard on made-up hosts, so no real machine's details can reach them.
//   npm run build && README_SCREENSHOTS=1 npm test -- test/screenshots/readme-screenshots.test.ts
const OUT = resolve("docs/screenshots");
const ORIGIN = "https://autoheal.example.org";
const GIBIBYTE = 1024 ** 3;
const MINUTE = 60_000;
const REPORTS = 10;
const VIEWPORT = { width: 1440, height: 900 };

const app = (name: string, image: string, change: Partial<ContainerSnapshot> = {}) =>
  containerSnapshot({
    name,
    image,
    composeProject: name,
    composeService: name,
    containerId: createHash("sha256").update(name).digest("hex").slice(0, 12),
    ...change,
  });
const HOSTS: { label: string; health: Partial<HostHealth>; containers: ContainerSnapshot[]; busy: number }[] = [
  {
    label: "atlas",
    busy: 22,
    health: { cpuCount: 12, memoryTotalBytes: 64 * GIBIBYTE, memoryAvailableBytes: 38 * GIBIBYTE, pendingUpdates: 4 },
    containers: [
      app("paperless", "ghcr.io/paperless-ngx/paperless-ngx:2.13", { composeService: "webserver" }),
      app("paperless-db", "postgres:16", { composeProject: "paperless", composeService: "db", health: "healthy" }),
      app("paperless-redis", "redis:7", { composeProject: "paperless", composeService: "broker", health: "none" }),
      app("jellyfin", "jellyfin/jellyfin:10.10", {
        state: "restarting",
        health: "none",
        restartCount: 6,
        exitCode: 137,
      }),
      app("uptime-kuma", "louislam/uptime-kuma:1", {}),
    ],
  },
  {
    label: "orion",
    busy: 41,
    health: { cpuCount: 8, memoryTotalBytes: 32 * GIBIBYTE, memoryAvailableBytes: 11 * GIBIBYTE, pendingUpdates: 0 },
    containers: [
      app("immich-server", "ghcr.io/immich-app/immich-server:v1", { composeProject: "immich" }),
      app("immich-db", "postgres:16", { composeProject: "immich" }),
      app("grafana", "grafana/grafana:11", {}),
    ],
  },
  {
    label: "vega",
    busy: 6,
    health: { cpuCount: 4, memoryTotalBytes: 16 * GIBIBYTE, memoryAvailableBytes: 12 * GIBIBYTE, rebootRequired: true },
    containers: [
      app("nginx-proxy", "nginx:1.27", { health: "none" }),
      app("forgejo", "codeberg.org/forgejo/forgejo:9", {}),
    ],
  },
];

it.runIf(process.env.README_SCREENSHOTS === "1")(
  "takes the README's screenshots",
  async () => {
    mkdirSync(OUT, { recursive: true });
    const ollama = await FakeOllama.start("plain");
    const plane = await startTestControlPlane({ webAssetsDirectory: resolve("dist/web"), ollamaUrl: ollama.url() });
    plane.clock.now = Date.now() - REPORTS * MINUTE;
    const { client: admin } = await fullySignedInAdmin(plane);
    const hostIds: Record<string, string> = {};
    const enrolled = new Map<string, Record<string, string>>();
    for (const { label } of HOSTS) {
      const added = (await admin.post(API_ROUTES.hosts, { label })).json<EnrolledHostView>();
      hostIds[label] = added.host.id;
      enrolled.set(label, {
        authorization: `Bearer ${runnerTokenOf(added)}`,
        [HTTP_HEADERS.runnerCapabilities]: EVERY_RUNNER_CAPABILITY,
      });
    }
    const report = async (minute: number) => {
      for (const { label, health, containers, busy } of HOSTS) {
        const headers = enrolled.get(label)!;
        const wave = busy + (busy / 3) * Math.sin(minute / 2);
        const metrics = hostMetrics();
        const beat = await plane.runnerApp.inject({
          method: "POST",
          url: RUNNER_ROUTES.heartbeat,
          headers,
          payload: heartbeatWith({
            dryRun: false,
            protectedContainers: ["autoheal"],
            restartBudget: {},
            containers,
            host: hostHealth({ hostname: label, ...health }),
          }),
        });
        expect(beat.statusCode, beat.body).toBe(200);
        const sent = await plane.runnerApp.inject({
          method: "POST",
          url: RUNNER_ROUTES.metrics,
          headers,
          payload: {
            host: { ...metrics, cpu: { ...metrics.cpu, busyPercent: wave } },
            containers: containers.map(({ name }) =>
              containerUsage({ name, cpuPercent: wave / 4, memoryBytes: (busy + name.length) * 16 * 1024 ** 2 }),
            ),
          },
        });
        expect(sent.statusCode, sent.body).toBeLessThan(300);
      }
    };
    await plane.services.ollamaPool.checkAll();
    for (let minute = REPORTS; minute >= 0; minute -= 1) {
      await report(minute);
      await plane.services.detectorService.run();
      plane.clock.now += minute === 0 ? 0 : MINUTE;
    }
    // Pages ask for the time as the browser does, a moment later than the last report.
    plane.clock.now = Date.now();

    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: "dark", ignoreHTTPSErrors: true });
    await context.route(`${ORIGIN}/**`, async (route) => {
      const request = route.request();
      const path = request.url().slice(ORIGIN.length);
      if (path.startsWith(API_ROUTES.live)) return route.abort();
      const answer = await admin.request({
        method: request.method() as "GET",
        url: path,
        ...(request.postData() === null ? {} : { payload: request.postData()! }),
        headers: { "content-type": request.headers()["content-type"] ?? "application/json" },
      });
      const { "set-cookie": _cookie, ...headers } = answer.headers;
      return route.fulfill({
        status: answer.statusCode,
        headers: headers as Record<string, string>,
        body: answer.rawPayload,
      });
    });
    const page = await context.newPage();
    const shot = async (name: string, path: string, opened?: string) => {
      await page.goto(`${ORIGIN}${path}`);
      await page.waitForLoadState("networkidle");
      if (opened !== undefined) await page.getByText(opened, { exact: true }).first().click();
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${OUT}/${name}.png` });
    };
    await shot("attention", "/");
    await shot("fleet", "/hosts");
    await shot("host", `/hosts/${hostIds.atlas!}`);
    await shot("board", "/board");
    await shot("containers", "/containers");
    await shot("settings", "/settings");
    await browser.close();
    await plane.app.close();
    await plane.runnerApp.close();
  },
  120_000,
);
