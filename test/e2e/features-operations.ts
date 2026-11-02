import { expect, type Page } from "@playwright/test";
import {
  API_ERRORS,
  API_ROUTES,
  CSRF_HEADER,
  apiPath,
  type HostControlView,
  type HostView,
  type IntegrationView,
  type SessionView,
} from "../../src/shared/api.js";
import type { NotificationInbox, NotificationRoutingView } from "../../src/shared/notification-deliveries.js";
import type { ResourcePermissionsView } from "../../src/shared/resource-permissions.js";
import type { PolicyRehearsalResult } from "../../src/shared/recovery-policy-simulator.js";
import { E2E_IMAGE, E2E_LABEL, E2E_NETWORK, VICTIM } from "./global-setup.js";
import type { FeatureUIContext } from "./feature-context.js";

const LONG = 150_000;
const PROVIDER = "autoheal-e2e-notification-provider";
const ALLOWED = "autoheal-e2e-operator-allowed";
const DENIED = "autoheal-e2e-operator-denied";
const REHEARSAL = "autoheal-e2e-rehearsal";
const OPERATOR = "scoped-observer";
const OPERATOR_PASSWORD = "gentle-violet-observatory-73";
async function hostOf(page: Page) {
  const response = await page.request.get(API_ROUTES.hosts);
  expect(response.ok()).toBe(true);
  const host = ((await response.json()) as HostView[]).find((value) => value.label === "e2e-host");
  expect(host).toBeTruthy();
  return host!;
}
async function json<Value>(page: Page, path: string): Promise<Value> {
  const response = await page.request.get(path);
  expect(response.ok(), `${path}: ${response.status()}`).toBe(true);
  return response.json() as Promise<Value>;
}
/** Real authenticated cleanup, never interception: keep unrelated acceptance scenarios on their original policy. */
async function put(page: Page, path: string, body: unknown) {
  const session = await json<SessionView>(page, API_ROUTES.session);
  const response = await page.request.put(path, {
    data: body,
    headers: { [CSRF_HEADER]: session.csrfToken, origin: new URL(page.url()).origin },
  });
  expect(response.ok(), `${path}: ${response.status()}`).toBe(true);
}
async function openDetails(page: Page, title: string) {
  const details = page
    .locator("details")
    .filter({ has: page.locator("summary").getByText(title, { exact: true }) })
    .first();
  if ((await details.getAttribute("open")) === null) await details.locator("summary").first().click();
  await expect(details).toHaveAttribute("open", "");
  return details;
}

export async function verifyNotifications({ page, docker }: FeatureUIContext) {
  const providerScript = `const http=require('node:http'),fs=require('node:fs');http.createServer((req,res)=>{if(req.url==='/health'){res.end('ready');return;}if(req.url!=='/message'||req.headers['x-gotify-key']!=='synthetic-e2e-provider-token'){res.statusCode=403;res.end('{}');return;}let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{fs.appendFileSync('/tmp/messages',body+String.fromCharCode(10));res.setHeader('content-type','application/json');res.statusCode=fs.existsSync('/tmp/refuse')?403:200;res.end(JSON.stringify({id:1}));});}).listen(3388,'0.0.0.0');`;
  docker(
    "run",
    "-d",
    "--name",
    PROVIDER,
    "--label",
    E2E_LABEL,
    "--network",
    E2E_NETWORK,
    "--tmpfs",
    "/tmp:size=1m,mode=1777",
    "--entrypoint",
    "/nodejs/bin/node",
    E2E_IMAGE,
    "-e",
    providerScript,
  );
  await expect
    .poll(
      () =>
        docker(
          "exec",
          PROVIDER,
          "/nodejs/bin/node",
          "-e",
          "fetch('http://127.0.0.1:3388/health').then(r=>r.text()).then(console.log)",
        ),
      { timeout: 30_000 },
    )
    .toBe("ready");
  const original = await json<NotificationRoutingView>(page, API_ROUTES.notificationRouting);
  let configured = false;
  try {
    await page.goto("/settings#notifications");
    const channel = page.locator("li.channel").filter({ has: page.getByText("Gotify", { exact: true }) });
    await channel.getByRole("button", { name: "Set up Gotify" }).click();
    await channel.locator('input[name="url"]').fill(`http://${PROVIDER}:3388`);
    await channel.locator('input[name="token"]').fill("synthetic-e2e-provider-token");
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname === apiPath(API_ROUTES.integration, { kind: "gotify" }),
    );
    await channel.getByRole("button", { name: "Save", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    configured = true;
    await expect(channel.getByText("Configured; untested", { exact: true })).toBeVisible();
    expect(await page.locator("body").innerText()).not.toContain("synthetic-e2e-provider-token");
    docker("exec", PROVIDER, "/nodejs/bin/node", "-e", "require('node:fs').writeFileSync('/tmp/refuse','1')");
    await channel.getByRole("button", { name: "Send a test" }).click();
    await expect(channel.getByRole("status")).toContainText("Last attempt failed");
    const refused = await json<IntegrationView[]>(page, API_ROUTES.integrations);
    expect(refused.find((item) => item.kind === "gotify")?.delivery?.status).toBe("degraded");
    docker("exec", PROVIDER, "/nodejs/bin/node", "-e", "require('node:fs').rmSync('/tmp/refuse')");
    await channel.getByRole("button", { name: "Send a test" }).click();
    await expect(channel.getByRole("status")).toContainText("Last accepted by server");
    const routing = await openDetails(page, "Notification routing and quiet hours");
    await routing.getByRole("button", { name: "Add routing rule" }).click();
    const rule = routing.locator("section.section").last();
    const host = await hostOf(page);
    await rule.getByRole("combobox").selectOption(host.id);
    await rule
      .getByRole("group", { name: "Primary channels (none suppresses primary sends)" })
      .getByLabel("ntfy", { exact: true })
      .uncheck();
    await rule.getByLabel("Quiet hours (UTC)", { exact: true }).check();
    const future = (new Date().getUTCHours() + 6) % 24;
    await rule.getByLabel("Quiet from", { exact: true }).fill(`${String(future).padStart(2, "0")}:00`);
    await rule.getByLabel("Quiet until", { exact: true }).fill(`${String((future + 1) % 24).padStart(2, "0")}:00`);
    await routing.getByRole("button", { name: "Save routing" }).click();
    await expect(routing.getByRole("status").filter({ hasText: "Notification routing saved." })).toHaveText(
      "Notification routing saved.",
    );
    const persisted = await json<NotificationRoutingView>(page, API_ROUTES.notificationRouting);
    expect(persisted.rules.at(-1)).toMatchObject({
      hostId: host.id,
      channels: ["gotify"],
      quietStartMinute: future * 60,
    });
    await page.goto("/incidents");
    const inbox = await openDetails(page, "Notification deliveries");
    await expect(inbox.getByText(/does not confirm device receipt/)).toBeVisible();
    const queue = inbox.getByRole("button", { name: "Queue using current routing" }).first();
    await expect(queue).toBeVisible();
    const enqueued = page.waitForResponse(
      (response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/route"),
    );
    await queue.click();
    const response = await enqueued;
    expect(response.ok()).toBe(true);
    const eventId = new URL(response.url()).pathname.split("/").at(-2)!;
    await expect
      .poll(
        async () => {
          const current = await json<NotificationInbox>(page, API_ROUTES.notificationDeliveries);
          return current.events
            .find((event) => event.id === eventId)
            ?.deliveries.some((delivery) => delivery.status === "accepted");
        },
        { timeout: LONG },
      )
      .toBe(true);
    await expect(inbox.getByRole("cell", { name: "Server accepted", exact: true }).first()).toBeVisible({
      timeout: LONG,
    });
    const acknowledged = page.waitForResponse(
      (value) => value.request().method() === "POST" && new URL(value.url()).pathname.endsWith("/acknowledge"),
    );
    await inbox.getByRole("button", { name: "Acknowledge", exact: true }).first().click();
    const ack = await acknowledged;
    expect(ack.ok()).toBe(true);
    const acknowledgedId = new URL(ack.url()).pathname.split("/").at(-2)!;
    expect(
      (await json<NotificationInbox>(page, API_ROUTES.notificationDeliveries)).events.find(
        (event) => event.id === acknowledgedId,
      )?.acknowledgedAt,
    ).toBeGreaterThan(0);
    expect(
      Number(
        docker(
          "exec",
          PROVIDER,
          "/nodejs/bin/node",
          "-e",
          "console.log(require('node:fs').readFileSync('/tmp/messages','utf8').trim().split(String.fromCharCode(10)).length)",
        ),
      ),
    ).toBeGreaterThanOrEqual(3);
  } finally {
    await put(page, API_ROUTES.notificationRouting, { rules: original.rules });
    if (configured) {
      await page.goto("/settings#notifications");
      const channel = page.locator("li.channel").filter({ has: page.getByText("Gotify", { exact: true }) });
      page.once("dialog", (dialog) => void dialog.accept());
      await channel.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(channel.getByRole("button", { name: "Set up Gotify" })).toBeVisible();
    }
    docker("rm", "-f", PROVIDER);
  }
}

export async function verifySearch({ page, openHost }: FeatureUIContext) {
  await page.goto("/incidents");
  const search = page.getByRole("combobox", { name: "Search infrastructure" });
  await page.keyboard.press("Control+k");
  await expect(search).toBeFocused();
  await search.fill("e2e-host");
  const results = page.getByRole("listbox", { name: "Infrastructure search results" });
  await expect(results.getByRole("group", { name: "Hosts" }).getByRole("option")).toContainText("e2e-host");
  await search.press("Enter");
  await expect(page.getByRole("heading", { name: "e2e-host", exact: true, level: 1 })).toBeVisible();
  await search.fill(VICTIM);
  await page.getByLabel("Only this host", { exact: true }).check();
  await expect(results.getByRole("group", { name: "Containers" }).getByRole("option").first()).toContainText(VICTIM);
  await search.press("Escape");
  await expect(results).toHaveCount(0);
  await search.focus();
  await search.fill("no-such-e2e-prefix-7429");
  await expect(page.getByRole("status").filter({ hasText: "No matching items." })).toBeVisible();
  await search.press("Escape");
  await expect(results).toHaveCount(0);
  await openHost("e2e-host");
}

export async function verifyPermissions(context: FeatureUIContext) {
  const { page, browser, docker, completeFirstSignIn, freshCode } = context;
  const host = await hostOf(page);
  for (const name of [ALLOWED, DENIED])
    docker("run", "-d", "--name", name, "--label", E2E_LABEL, E2E_IMAGE, "application-copy", "wait");
  const operatorContext = await browser.newContext({ baseURL: new URL(page.url()).origin, ignoreHTTPSErrors: true });
  const operator = await operatorContext.newPage();
  try {
    await expect
      .poll(
        async () => {
          const rows = await json<{ name: string }[]>(page, apiPath(API_ROUTES.containers, {}) + `?hostId=${host.id}`);
          return [ALLOWED, DENIED].every((name) => rows.some((row) => row.name === name));
        },
        { timeout: LONG },
      )
      .toBe(true);
    await page.goto("/users");
    await page.getByLabel("Username", { exact: true }).fill(OPERATOR);
    await page.getByRole("button", { name: "Add user", exact: true }).click();
    const initial = (await page.locator(".notice span.secret").textContent())!.trim();
    const { secret } = await completeFirstSignIn(operator, OPERATOR, initial, OPERATOR_PASSWORD);
    await operator.goto(`/hosts/${host.id}`);
    await expect(operator.getByRole("button", { name: `Restart ${ALLOWED}`, exact: true })).toHaveCount(0);
    const account = page.getByRole("row").filter({ has: page.getByText(OPERATOR, { exact: true }) });
    const grants = account.locator("details.operator-grants");
    await grants.locator("summary").click();
    await grants.getByLabel("Host", { exact: true }).selectOption(host.id);
    await grants.getByLabel("Exact container name", { exact: true }).fill(ALLOWED);
    await grants.getByLabel("Start, stop, restart and recreate", { exact: true }).check();
    await grants.getByLabel("Read container logs", { exact: true }).check();
    await grants.getByRole("button", { name: "Add to review", exact: true }).click();
    await grants.getByRole("button", { name: "Save access changes", exact: true }).click();
    await expect(grants.getByRole("status")).toHaveText("Access saved. The person must sign in again.");
    const accounts = await json<{ id: string; username: string }[]>(page, API_ROUTES.users);
    const userId = accounts.find((value) => value.username === OPERATOR)!.id;
    expect((await json<ResourcePermissionsView>(page, apiPath(API_ROUTES.userGrants, { userId }))).grants).toEqual([
      { hostId: host.id, scope: "container", resource: ALLOWED, actions: ["lifecycle", "logs"] },
    ]);
    await operator.reload();
    await expect(operator).toHaveURL(/\/login$/);
    await operator.getByLabel("Username").fill(OPERATOR);
    await operator.getByLabel("Password", { exact: true }).fill(OPERATOR_PASSWORD);
    await operator.getByRole("button", { name: "Sign in", exact: true }).click();
    await operator.getByLabel("Code", { exact: true }).fill(await freshCode(secret));
    await operator.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(operator).toHaveURL(/\/$/);
    await operator.goto(`/hosts/${host.id}`);
    await expect(operator.getByRole("button", { name: `Restart ${ALLOWED}`, exact: true })).toBeVisible();
    await expect(operator.getByRole("button", { name: `Restart ${DENIED}`, exact: true })).toHaveCount(0);
    const before = docker("inspect", "-f", "{{.State.StartedAt}}", ALLOWED),
      otherBefore = docker("inspect", "-f", "{{.State.StartedAt}}", DENIED);
    const restart = operator.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          apiPath(API_ROUTES.containerActions, { hostId: host.id, containerName: ALLOWED }),
    );
    await operator.getByRole("button", { name: `Restart ${ALLOWED}`, exact: true }).click();
    expect((await restart).ok()).toBe(true);
    await expect
      .poll(() => docker("inspect", "-f", "{{.State.StartedAt}}", ALLOWED), { timeout: LONG })
      .not.toBe(before);
    const session = await json<SessionView>(operator, API_ROUTES.session);
    const denied = await operator.request.post(
      apiPath(API_ROUTES.containerActions, { hostId: host.id, containerName: DENIED }),
      {
        data: { action: "restart" },
        headers: { [CSRF_HEADER]: session.csrfToken, origin: new URL(operator.url()).origin },
      },
    );
    expect(denied.status()).toBe(403);
    expect((await denied.json()).error).toBe(API_ERRORS.resourceForbidden);
    expect(docker("inspect", "-f", "{{.State.StartedAt}}", DENIED)).toBe(otherBefore);
    await grants.getByRole("button", { name: "Remove grant", exact: true }).click();
    await grants.getByRole("button", { name: "Save access changes", exact: true }).click();
    await expect(grants.getByRole("status")).toHaveText("Access saved. The person must sign in again.");
    expect((await json<ResourcePermissionsView>(page, apiPath(API_ROUTES.userGrants, { userId }))).grants).toEqual([]);
    await operator.reload();
    await expect(operator).toHaveURL(/\/login$/);
  } finally {
    await operatorContext.close();
    for (const name of [ALLOWED, DENIED]) docker("rm", "-f", name);
  }
}

export async function verifyRehearsal({ page, docker }: FeatureUIContext) {
  const host = await hostOf(page);
  const control = apiPath(API_ROUTES.hostControl, { hostId: host.id });
  const before = await json<HostControlView>(page, control);
  const proposed = before.restartDefault === "tell" ? "ask" : "tell";
  docker("run", "-d", "--name", REHEARSAL, "--label", E2E_LABEL, E2E_IMAGE, "application-copy", "wait");
  const started = docker("inspect", "-f", "{{.State.StartedAt}}", REHEARSAL);
  try {
    await expect
      .poll(
        async () =>
          (await json<{ name: string }[]>(page, `${API_ROUTES.containers}?hostId=${host.id}`)).some(
            (container) => container.name === REHEARSAL,
          ),
        { timeout: LONG },
      )
      .toBe(true);
    await page.goto(`/replays?hostId=${host.id}#policy-rehearsal`);
    const rehearsal = await openDetails(page, "Rehearse recovery policy");
    await expect(rehearsal.getByLabel("Rehearsal host", { exact: true })).toHaveValue(host.id);
    await rehearsal.getByLabel("Proposed failure policy", { exact: true }).selectOption(proposed);
    for (let index = 1; index <= 5; index++)
      await rehearsal.getByLabel(`Event ${index} container`, { exact: true }).selectOption(REHEARSAL);
    const simulated = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === API_ROUTES.policyRehearsal,
    );
    await rehearsal.getByRole("button", { name: "Run policy rehearsal", exact: true }).click();
    const reply = await simulated;
    expect(reply.ok()).toBe(true);
    const result = (await reply.json()) as PolicyRehearsalResult;
    expect(result.change).toMatchObject({ before: before.restartDefault, after: proposed });
    expect(result.proposed.decisions).toHaveLength(5);
    await expect(rehearsal.getByRole("region", { name: "Policy rehearsal result" })).toBeVisible();
    expect((await json<HostControlView>(page, control)).restartDefault).toBe(before.restartDefault);
    expect(docker("inspect", "-f", "{{.State.StartedAt}}", REHEARSAL)).toBe(started);
    await expect(rehearsal.getByRole("button", { name: "Apply reviewed host default", exact: true })).toBeDisabled();
    await rehearsal.getByLabel("I reviewed the default change and the rehearsal assumptions.", { exact: true }).check();
    await rehearsal.getByRole("button", { name: "Apply reviewed host default", exact: true }).click();
    await expect(
      rehearsal.getByRole("status").filter({ hasText: "Host default saved through the normal control policy." }),
    ).toContainText("Host default saved through the normal control policy.");
    expect((await json<HostControlView>(page, control)).restartDefault).toBe(proposed);
  } finally {
    try {
      await put(page, control, { restartDefault: before.restartDefault });
    } finally {
      docker("rm", "-f", REHEARSAL);
    }
  }
}
