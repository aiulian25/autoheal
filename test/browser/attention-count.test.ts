import { resolve } from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { API_ROUTES, type BoardView, type EnrolledHostView } from "../../src/shared/api.js";
import { RUNNER_ROUTES } from "../../src/shared/protocol.js";
import { runnerTokenOf, startTestControlPlane } from "../support/control-plane.js";
import { heartbeatWith, hostHealth } from "../support/inventory.js";
import { fullySignedInAdmin } from "../support/second-factor.js";

// Attention in a real browser: what its count says needs a person is drawn, a host's reboot among its updates.
//   npm run build && DASHBOARD_BROWSER_CHECK=1 npm test -- test/browser/attention-count.test.ts
const ORIGIN = "https://autoheal.example.org";
const BUILD = resolve(process.env.DASHBOARD_BUILD ?? "dist/web");

it.runIf(process.env.DASHBOARD_BROWSER_CHECK === "1")(
  "draws everything its count says needs a person, a host's reboot among its updates",
  async () => {
    const plane = await startTestControlPlane({ webAssetsDirectory: BUILD });
    const { client: admin } = await fullySignedInAdmin(plane);
    const added = (await admin.post(API_ROUTES.hosts, { label: "atlas" })).json<EnrolledHostView>();
    const beat = await plane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      headers: { authorization: `Bearer ${runnerTokenOf(added)}` },
      payload: heartbeatWith({
        dryRun: false,
        host: hostHealth({
          hostname: "atlas",
          packages: {
            setting: "apply",
            unsupported: null,
            unattendedUpgrades: false,
            rebootPackages: ["linux-base"],
            kernelWaiting: "6.12.57+deb13-amd64",
            timeZone: "Europe/Lisbon",
            recentChanges: [],
          },
        }),
      }),
    });
    expect(beat.statusCode, beat.body).toBe(200);
    await plane.services.detectorService.run();
    const board = (await admin.get(API_ROUTES.board)).json<BoardView>();
    expect(board.needsYou.length).toBeGreaterThan(0);

    const browser = await chromium.launch();
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
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
    await page.getByText("atlas needs a reboot", { exact: true }).first().waitFor();
    const count = board.needsYou.length;
    await expect
      .poll(() => page.locator(".page-header .lede").first().textContent())
      .toContain(`${count} ${count === 1 ? "thing needs" : "things need"} you`);
    // Every task that needs a person is on the page, by its title.
    for (const card of board.needsYou) {
      const title = "task" in card ? card.task.title : card.incident.containerName;
      await expect.poll(() => page.getByText(title, { exact: true }).count()).toBeGreaterThan(0);
    }
    if (process.env.SCREENSHOT_DIRECTORY !== undefined) {
      await page.screenshot({ path: resolve(process.env.SCREENSHOT_DIRECTORY, "attention-count.png"), fullPage: true });
    }
    await browser.close();
  },
  120_000,
);
