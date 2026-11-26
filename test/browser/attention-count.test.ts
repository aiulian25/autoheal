import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { expect, it } from "vitest";
import {
  API_ROUTES,
  apiPath,
  type BoardView,
  type EnrolledHostView,
  type TaskDetailView,
} from "../../src/shared/api.js";
import { TASK_SNOOZE } from "../../src/shared/constants.js";
import { RUNNER_ROUTES, type Heartbeat, type PackageFacts } from "../../src/shared/protocol.js";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../support/control-plane.js";
import { containerSnapshot, heartbeatWith, hostHealth } from "../support/inventory.js";
import { fullySignedInAdmin } from "../support/second-factor.js";

// Attention in a real browser: what its count says needs a person is drawn, place by place, with what waits for a
// look and what was put off below it. SCREENSHOT_DIRECTORY keeps a picture of each page.
//   npm run build && DASHBOARD_BROWSER_CHECK=1 npm test -- test/browser/attention-count.test.ts
const ORIGIN = "https://autoheal.example.org";
const BUILD = resolve(process.env.DASHBOARD_BUILD ?? "dist/web");
const GIBIBYTE = 1024 ** 3;
const VIEWPORT = { width: 1440, height: 1000 };
const KERNEL_WAITING: PackageFacts = {
  setting: "apply",
  unsupported: null,
  unattendedUpgrades: false,
  rebootPackages: ["linux-base"],
  kernelWaiting: "6.12.57+deb13-amd64",
  timeZone: "Europe/Lisbon",
  recentChanges: [],
};

async function report(plane: TestControlPlane, host: EnrolledHostView, payload: Partial<Heartbeat>) {
  const beat = await plane.runnerApp.inject({
    method: "POST",
    url: RUNNER_ROUTES.heartbeat,
    headers: { authorization: `Bearer ${runnerTokenOf(host)}` },
    payload: heartbeatWith({ dryRun: false, ...payload }),
  });
  expect(beat.statusCode, beat.body).toBe(200);
}

// The page as a browser shows it, every request answered by the dashboard as the admin signed in.
async function attentionPage(
  browser: Browser,
  admin: TestClient,
  colorScheme: "light" | "dark" = "light",
): Promise<Page> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: VIEWPORT, colorScheme });
  await context.route(`${ORIGIN}/**`, async (route) => {
    const request = route.request();
    const path = request.url().slice(ORIGIN.length);
    if (path.startsWith(API_ROUTES.live)) return route.abort();
    const answer = await admin.request({
      method: request.method() as "GET",
      url: path,
      ...(request.postData() === null ? {} : { payload: request.postData()! }),
      headers: {
        "content-type": request.headers()["content-type"] ?? "application/json",
        accept: request.headers()["accept"] ?? "*/*",
      },
    });
    const { "set-cookie": _cookie, ...headers } = answer.headers;
    return route.fulfill({
      status: answer.statusCode,
      headers: headers as Record<string, string>,
      body: answer.rawPayload,
    });
  });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`);
  return page;
}

async function keepPicture(page: Page, name: string) {
  if (process.env.SCREENSHOT_DIRECTORY === undefined) return;
  await page.screenshot({ path: resolve(process.env.SCREENSHOT_DIRECTORY, `${name}.png`), fullPage: true });
}

const ledeOf = (page: Page) => page.locator(".page-header .lede").first().textContent();

it.runIf(process.env.DASHBOARD_BROWSER_CHECK === "1")(
  "draws everything its count says needs a person, a host's reboot in its place",
  async () => {
    const plane = await startTestControlPlane({ webAssetsDirectory: BUILD });
    const { client: admin } = await fullySignedInAdmin(plane);
    const atlas = (await admin.post(API_ROUTES.hosts, { label: "atlas" })).json<EnrolledHostView>();
    await report(plane, atlas, { host: hostHealth({ hostname: "atlas", packages: KERNEL_WAITING }) });
    await plane.services.detectorService.run();
    const board = (await admin.get(API_ROUTES.board)).json<BoardView>();
    expect(board.needsYou.length).toBeGreaterThan(0);

    const browser = await chromium.launch();
    const page = await attentionPage(browser, admin);
    await page.getByText("atlas needs a reboot", { exact: true }).first().waitFor();
    const count = board.needsYou.length;
    await expect.poll(() => ledeOf(page)).toContain(`${count} ${count === 1 ? "thing needs" : "things need"} you`);
    // Every task that needs a person is on the page, by its title.
    for (const card of board.needsYou) {
      const title = "task" in card ? card.task.title : card.incident.containerName;
      await expect.poll(() => page.getByText(title, { exact: true }).count()).toBeGreaterThan(0);
    }
    await keepPicture(page, "attention-count");
    await browser.close();
  },
  120_000,
);

it.runIf(process.env.DASHBOARD_BROWSER_CHECK === "1")(
  "puts each place's things in its own card, what waits for a look below, and what was put off in one line",
  async () => {
    const plane = await startTestControlPlane({ webAssetsDirectory: BUILD });
    const { client: admin } = await fullySignedInAdmin(plane);
    const atlas = (await admin.post(API_ROUTES.hosts, { label: "atlas" })).json<EnrolledHostView>();
    const vega = (await admin.post(API_ROUTES.hosts, { label: "vega" })).json<EnrolledHostView>();
    const waiting = (name: string) =>
      containerSnapshot({
        name,
        composeProject: name,
        image: `example/${name}:latest`,
        update: { status: "available", checkedAt: plane.clock.now, remoteDigest: `sha256:${"a".repeat(64)}` },
      });
    await report(plane, atlas, {
      host: hostHealth({ hostname: "atlas", packages: KERNEL_WAITING }),
      containers: [waiting("quantum"), waiting("radicale")],
    });
    await report(plane, vega, {
      host: hostHealth({
        hostname: "vega",
        disks: [{ path: "/", totalBytes: 100 * GIBIBYTE, usedBytes: 97 * GIBIBYTE, availableBytes: 3 * GIBIBYTE }],
      }),
    });
    await admin.post(API_ROUTES.tasks, { title: "Look at the porch camera's recordings", priority: "medium" });
    const battery = (
      await admin.post(API_ROUTES.tasks, { title: "Replace the UPS battery", priority: "high" })
    ).json<TaskDetailView>();
    await admin.patch(apiPath(API_ROUTES.task, { taskId: battery.id }), { snoozed: TASK_SNOOZE.oneMonth });
    await plane.services.detectorService.run();

    const browser = await chromium.launch();
    const page = await attentionPage(browser, admin, "dark");
    await page.locator(".place-card").first().waitFor();
    await page.getByText("1 snoozed").waitFor();
    await keepPicture(page, "attention-places");
    const placeTitles = await page.locator(".attention-section > .place-card .place-head h3").allTextContents();
    expect(placeTitles).toEqual(expect.arrayContaining(["atlas", "vega"]));
    await page.getByText("atlas needs a reboot", { exact: true }).waitFor();
    expect(await page.getByRole("checkbox", { name: "Update quantum" }).count()).toBe(1);
    await page.getByText("Look at the porch camera's recordings").waitFor();
    await browser.close();
  },
  120_000,
);
