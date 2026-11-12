import { resolve } from "node:path";
import { chromium, type Page } from "playwright";
import { expect, it, onTestFinished } from "vitest";
import { API_ROUTES, CSRF_HEADER, type SessionView } from "../../src/shared/api.js";
import { HTTP_HEADERS } from "../../src/shared/constants.js";
import { PUBLIC_ORIGIN, startTestControlPlane } from "../support/control-plane.js";
import { NEW_ADMIN_PASSWORD, currentCode } from "../support/second-factor.js";

// The built dashboard in a real browser: a first admin's recovery codes and backup passphrase, shown only once, stay
// through a session re-read until "I saved them", and go the moment the person is signed out.
//   npm run build && DASHBOARD_BROWSER_CHECK=1 npm test -- test/browser/recovery-codes.test.ts
const CHECK = process.env.DASHBOARD_BROWSER_CHECK === "1";
const CHECK_MILLISECONDS = 120_000;
const WAIT = { timeout: 15_000 };
// Long enough for a page the re-read would send away to have gone.
const SETTLE_MILLISECONDS = 1_500;
const FIRST_ADMIN = "admin";
// Made up here: the passphrase Autoheal makes on first start, shown to the first admin once.
const MADE_PASSPHRASE = "lantern-meadow-quietly-0123456789";
const HOME = "/";
const LOGIN = "/login";
const TOTP_SETUP = "/totp-setup";
// The setup page's parts: its first button shows the key, and what is shown once sits in the two secret blocks.
const SETUP = {
  start: "form.panel button.primary",
  key: "span.secret",
  code: 'input[name="code"]',
  confirm: 'form.panel button[type="submit"]',
  shownOnce: "pre.secret",
  done: "section.panel button.primary",
};
const address = (path: string) => `${PUBLIC_ORIGIN}${path}`;

/**
 * A first admin past their new password, and a browser whose requests reach the control plane through that admin's
 * own session, as the README's screenshots do. It counts the browser's reads of the session.
 */
async function opened() {
  const plane = await startTestControlPlane({
    webAssetsDirectory: resolve("dist/web"),
    generatedBackupPassphrase: MADE_PASSPHRASE,
  });
  const firstPassword = await plane.firstAdminPassword();
  const client = plane.client();
  await client.signIn(FIRST_ADMIN, firstPassword);
  await client.post(API_ROUTES.changePassword, { currentPassword: firstPassword, newPassword: NEW_ADMIN_PASSWORD });
  let sessionReads = 0;
  const browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.route(`${PUBLIC_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const path = request.url().slice(PUBLIC_ORIGIN.length);
    if (path.startsWith(API_ROUTES.live)) return route.abort();
    if (request.method() === "GET" && path === API_ROUTES.session) sessionReads += 1;
    // Only what the dashboard itself sent: a body-less request carries no content type.
    const sent = request.headers();
    const forwarded = [HTTP_HEADERS.contentType, CSRF_HEADER].filter((name) => sent[name] !== undefined);
    const answer = await client.request({
      method: request.method() as "GET",
      url: path,
      ...(request.postData() === null ? {} : { payload: request.postData()! }),
      headers: Object.fromEntries(forwarded.map((name) => [name, sent[name]!])),
    });
    const { "set-cookie": _cookie, ...headers } = answer.headers;
    return route.fulfill({
      status: answer.statusCode,
      headers: headers as Record<string, string>,
      body: answer.rawPayload,
    });
  });
  onTestFinished(async () => {
    await browser.close();
    await plane.app.close();
    await plane.runnerApp.close();
  });
  return {
    page: await context.newPage(),
    client,
    sessionReads: () => sessionReads,
    code: (secret: string) => currentCode(secret, plane.clock.now),
  };
}

type Check = Awaited<ReturnType<typeof opened>>;

// Two-step sign-in set up on the dashboard's own page, to the screen that shows the codes and the passphrase once.
async function toShownOnce({ page, code }: Check): Promise<string[]> {
  await page.goto(address(HOME));
  await page.locator(SETUP.start).click();
  const secret = (await page.locator(SETUP.key).textContent())!.trim();
  await page.locator(SETUP.code).fill(code(secret));
  await page.locator(SETUP.confirm).click();
  await page.locator(SETUP.shownOnce).nth(1).waitFor(WAIT);
  return page.locator(SETUP.shownOnce).allTextContents();
}

// The tab left for the password manager and come back to: the dashboard reads the session again on return.
const leftAndCameBack = (page: Page) =>
  page.evaluate(() => {
    const visibility = (value: DocumentVisibilityState) => {
      Object.defineProperty(document, "visibilityState", { value, configurable: true });
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    };
    visibility("hidden");
    visibility("visible");
  });

// As a link inside the dashboard moves it: the same document, so what the dashboard holds in memory stays.
const moved = (page: Page, path: string) =>
  page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);

it.runIf(CHECK)(
  "keeps the codes and the passphrase through a session re-read until they are saved, and never shows them again",
  async () => {
    const check = await opened();
    const { page } = check;
    const shownOnce = await toShownOnce(check);
    expect(shownOnce[1]).toBe(MADE_PASSPHRASE);

    const readsBefore = check.sessionReads();
    await leftAndCameBack(page);
    await expect.poll(check.sessionReads, WAIT).toBeGreaterThan(readsBefore);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(SETTLE_MILLISECONDS);
    expect(page.url()).toBe(address(TOTP_SETUP));
    expect(await page.locator(SETUP.shownOnce).allTextContents()).toEqual(shownOnce);

    await page.locator(SETUP.done).click();
    await page.waitForURL(address(HOME), WAIT);
    await expect.poll(() => page.locator(SETUP.shownOnce).count(), WAIT).toBe(0);
    await moved(page, TOTP_SETUP);
    await page.waitForURL(address(HOME), WAIT);
    expect(await page.locator(SETUP.shownOnce).count()).toBe(0);
  },
  CHECK_MILLISECONDS,
);

it.runIf(CHECK)(
  "lets the codes and the passphrase go the moment the person is signed out",
  async () => {
    const check = await opened();
    const { page, client } = check;
    expect(await toShownOnce(check)).toHaveLength(2);

    // Their session ends on the server, as a sign-out elsewhere or a timeout ends it.
    client.csrfToken = (await client.get(API_ROUTES.session)).json<SessionView>().csrfToken;
    expect((await client.post(API_ROUTES.logout)).statusCode).toBeLessThan(300);
    await leftAndCameBack(page);
    await page.waitForURL(address(LOGIN), WAIT);
    expect(await page.locator(SETUP.shownOnce).count()).toBe(0);
  },
  CHECK_MILLISECONDS,
);
