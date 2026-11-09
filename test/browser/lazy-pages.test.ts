import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { expect, it } from "vitest";
import { API_ROUTES, type EnrolledHostView } from "../../src/shared/api.js";
import { HTTP_HEADERS, HTTP_STATUS } from "../../src/shared/constants.js";
import { RUNNER_ROUTES } from "../../src/shared/protocol.js";
import { runnerTokenOf, startTestControlPlane } from "../support/control-plane.js";
import { EVERY_RUNNER_CAPABILITY, containerSnapshot, heartbeatWith, hostHealth } from "../support/inventory.js";
import { fullySignedInAdmin } from "../support/second-factor.js";

// The built dashboard in a real browser: each page's code arrives when it is first opened, and a tab opened before an
// update loads the new build when a page's file has gone.
//   npm run build && DASHBOARD_BROWSER_CHECK=1 npm test -- test/browser/lazy-pages.test.ts
// DASHBOARD_BUILD names another build folder than dist/web.
const ORIGIN = "https://autoheal.example.org";
const BUILD = resolve(process.env.DASHBOARD_BUILD ?? "dist/web");
const ASSET = /\/assets\/[^/]+\.js$/;
const PAGE_HEADING = "main h1, main h2";
const PAGES = [
  "/",
  "/board",
  "/tasks",
  "/incidents",
  "/hosts",
  "/containers",
  "/home",
  "/network",
  "/runbooks",
  "/replays",
  "/users",
  "/backups",
  "/audit",
  "/account",
  "/settings",
];

it.runIf(process.env.DASHBOARD_BROWSER_CHECK === "1")(
  "loads each page's code when it is first opened, and a stale tab loads the new build",
  async () => {
    const plane = await startTestControlPlane({ webAssetsDirectory: BUILD });
    const { client: admin } = await fullySignedInAdmin(plane);
    const added = (await admin.post(API_ROUTES.hosts, { label: "atlas" })).json<EnrolledHostView>();
    const beat = await plane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      headers: {
        authorization: `Bearer ${runnerTokenOf(added)}`,
        [HTTP_HEADERS.runnerCapabilities]: EVERY_RUNNER_CAPABILITY,
      },
      payload: heartbeatWith({
        containers: [containerSnapshot({ name: "paperless", composeProject: "paperless" })],
        host: hostHealth({ hostname: "atlas" }),
      }),
    });
    expect(beat.statusCode, beat.body).toBe(200);

    const browser = await chromium.launch();
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    // One page file answers as a release that replaced it would, once: the tab must load the new build.
    const gone = { name: null as string | null, refused: 0 };
    await context.route(`${ORIGIN}/**`, async (route) => {
      const request = route.request();
      const path = request.url().slice(ORIGIN.length);
      if (path.startsWith(API_ROUTES.live)) return route.abort();
      if (gone.name !== null && path.endsWith(gone.name) && gone.refused === 0) {
        gone.refused += 1;
        return route.fulfill({ status: HTTP_STATUS.notFound, body: "" });
      }
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
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`${page.url()}: ${error.message}`));
    // The live stream is cut on purpose here, as the README's screenshots cut it.
    page.on("console", (message) => {
      const liveStream = message.location().url.includes(API_ROUTES.live);
      if (message.type() === "error" && !liveStream) problems.push(`${page.url()}: ${message.text()}`);
    });
    const scripts = new Set<string>();
    page.on("request", (request) => {
      if (ASSET.test(request.url())) scripts.add(new URL(request.url()).pathname);
    });
    const settled = async (target: Page) => {
      await target.waitForLoadState("networkidle");
      await target.locator(PAGE_HEADING).first().waitFor();
    };
    const open = async (target: Page, path: string) => {
      await target.goto(`${ORIGIN}${path}`);
      await settled(target);
    };
    // As a link inside the dashboard moves it: the same document, so a page's code is fetched only now.
    const move = async (target: Page, path: string) => {
      await target.evaluate((to) => {
        window.history.pushState({}, "", to);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, path);
      await settled(target);
    };

    await open(page, "/");
    const first = new Set(scripts);
    const opened: Record<string, string[]> = {};
    for (const path of [...PAGES.slice(1), `/hosts/${added.host.id}`]) {
      const before = new Set(scripts);
      await move(page, path);
      opened[path] = [...scripts].filter((script) => !before.has(script));
    }
    expect(problems).toEqual([]);
    // The first visit brings the dashboard and the Attention page, not every page.
    expect(first.size).toBeLessThan(scripts.size);
    const later = Object.values(opened).filter((files) => files.length > 0).length;
    expect(later).toBeGreaterThan(PAGES.length / 2);

    // A tab that has not opened the board yet asks for it after a release replaced its file.
    const stale = await context.newPage();
    const loads: string[] = [];
    stale.on("load", () => loads.push(stale.url()));
    await open(stale, "/");
    const boardFile = [...scripts].find((script) => script.includes("/board-page-"));
    expect(boardFile, "the board page's own file").toBeDefined();
    gone.name = boardFile!;
    await move(stale, "/board");
    await stale.waitForURL(`${ORIGIN}/board`);
    await settled(stale);
    expect(gone.refused).toBe(1);
    expect(loads.length).toBe(2);
    expect(new URL(stale.url()).pathname).toBe("/board");

    await browser.close();
    await plane.app.close();
    await plane.runnerApp.close();
    console.log(JSON.stringify({ first: [...first], opened }, null, 1));
  },
  180_000,
);
