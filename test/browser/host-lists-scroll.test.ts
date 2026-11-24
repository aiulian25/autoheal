import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { expect, it } from "vitest";
import { API_ROUTES, type EnrolledHostView } from "../../src/shared/api.js";
import { HTTP_HEADERS } from "../../src/shared/constants.js";
import { RUNNER_ROUTES } from "../../src/shared/protocol.js";
import { runnerTokenOf, startTestControlPlane } from "../support/control-plane.js";
import { EVERY_RUNNER_CAPABILITY, containerSnapshot, heartbeatWith, hostHealth } from "../support/inventory.js";
import { fullySignedInAdmin } from "../support/second-factor.js";

// A host's long container list in a real browser: the wheel scrolls the page over it, as nothing in it scrolls by
// itself, and its header stays under the tabs. Narrower than its table, as on a phone, it scrolls in its card.
//   npm run build && DASHBOARD_BROWSER_CHECK=1 npm test -- test/browser/host-lists-scroll.test.ts
const ORIGIN = "https://autoheal.example.org";
const BUILD = resolve(process.env.DASHBOARD_BUILD ?? "dist/web");
const CONTAINERS = 60;
const WHEEL_PIXELS = 400;
const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 1000, height: 800 };

it.runIf(process.env.DASHBOARD_BROWSER_CHECK === "1")(
  "scrolls a long container list with the page, its header under the tabs, and in its card when narrower",
  async () => {
    const plane = await startTestControlPlane({ webAssetsDirectory: BUILD });
    const { client: admin } = await fullySignedInAdmin(plane);
    const added = (await admin.post(API_ROUTES.hosts, { label: "atlas" })).json<EnrolledHostView>();
    const names = Array.from({ length: CONTAINERS }, (_, index) => `app${String(index + 1).padStart(2, "0")}`);
    const beat = await plane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      headers: {
        authorization: `Bearer ${runnerTokenOf(added)}`,
        [HTTP_HEADERS.runnerCapabilities]: EVERY_RUNNER_CAPABILITY,
      },
      // Acting for real: a host that only watches has nothing to tick.
      payload: heartbeatWith({
        dryRun: false,
        containers: names.map((name) => containerSnapshot({ name, composeProject: null })),
        host: hostHealth({ hostname: "atlas" }),
      }),
    });
    expect(beat.statusCode, beat.body).toBe(200);

    const browser = await chromium.launch();
    const open = async (viewport: { width: number; height: number }): Promise<Page> => {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport });
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
      await page.goto(`${ORIGIN}/hosts/${added.host.id}`);
      await page.getByRole("button", { name: names.at(-1)!, exact: true }).waitFor();
      return page;
    };
    // Where the list's header and the tabs are on the screen, and whether anything in the list scrolls by itself.
    const measure = (page: Page) =>
      page.evaluate(() => {
        const wrap = document.querySelector<HTMLElement>(".host-containers .container-table")!;
        const inner = wrap.querySelector<HTMLElement>(".table-scroll") ?? wrap;
        const scrollsBy = (element: HTMLElement) => ({
          down: element.scrollHeight - element.clientHeight > 1 && getComputedStyle(element).overflowY !== "clip",
          sideways: element.scrollWidth - element.clientWidth > 1 && getComputedStyle(element).overflowX !== "clip",
        });
        return {
          wrap: scrollsBy(wrap),
          inner: scrollsBy(inner),
          headerTop: wrap.querySelector("thead th")!.getBoundingClientRect().top,
          tabsBottom: document.querySelector(".host-tabs")!.getBoundingClientRect().bottom,
          listTop: wrap.getBoundingClientRect().top + window.scrollY,
          scrolled: window.scrollY,
        };
      });

    const wide = await open(WIDE);
    const before = await measure(wide);
    expect(before.wrap.down || before.inner.down, "a list box of its own takes the wheel").toBe(false);
    expect(before.inner.sideways).toBe(false);
    // Part way down the list, the wheel over it moves the page, and its header waits under the tabs.
    await wide.evaluate((top) => window.scrollTo(0, top + 300), before.listTop);
    const row = wide.getByRole("button", { name: "app20", exact: true });
    const box = (await row.boundingBox())!;
    await wide.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const resting = await measure(wide);
    await wide.mouse.wheel(0, WHEEL_PIXELS);
    await wide.waitForFunction((from) => window.scrollY > from, resting.scrolled);
    const moved = await measure(wide);
    expect(moved.scrolled - resting.scrolled).toBeGreaterThan(WHEEL_PIXELS / 2);
    expect(Math.abs(moved.headerTop - moved.tabsBottom)).toBeLessThanOrEqual(1);
    // With a container ticked, its bar sits under the tabs, and the header under the bar.
    await wide.getByRole("checkbox", { name: "Tick app30", exact: true }).click({ force: true });
    const bar = wide.getByRole("group", { name: "Act on the ticked containers" });
    await expect.poll(async () => (await bar.getAttribute("class")) ?? "").toContain("action-bar");
    await wide.evaluate((top) => window.scrollTo(0, top + 900), before.listTop);
    const ticked = await measure(wide);
    const barBottom = (await bar.boundingBox())!.y + (await bar.boundingBox())!.height;
    expect(Math.abs(ticked.headerTop - barBottom)).toBeLessThanOrEqual(1);

    // Narrower than its table: the list scrolls in its card, both ways, its header at the card's top.
    const narrow = await open(NARROW);
    const small = await measure(narrow);
    expect(small.inner.sideways).toBe(true);
    expect(small.inner.down).toBe(true);
    await browser.close();
  },
  120_000,
);
