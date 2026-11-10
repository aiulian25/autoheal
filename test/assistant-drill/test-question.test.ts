import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect, it, vi } from "vitest";
import { API_ROUTES, apiPath } from "../../src/shared/api.js";
import { APP_VERSION, MILLISECONDS_PER_MINUTE } from "../../src/shared/constants.js";
import {
  ASSISTANT_FILES,
  JARVIS_LIMITS,
  assistantFileLink,
  type JarvisConnected,
  type JarvisView,
} from "../../src/shared/jarvis.js";
import { startTestControlPlane } from "../support/control-plane.js";
import { fullySignedInAdmin } from "../support/second-factor.js";

// TASK-007 on a throwaway Home Assistant that was never onboarded: this check sets it up as a person would, opens the
// card's two links in a browser signed in to it, and has a made-up phone answer the card's test question.
//   ASSISTANT_DRILL_HOME_ASSISTANT=http://127.0.0.1:18123 ASSISTANT_DRILL_SERVE_ON=<the Docker bridge's gateway> \
//   npm test -- test/assistant-drill/test-question.test.ts
// Passwords and tokens live only in memory. ASSISTANT_DRILL_SCREENSHOTS=<folder> keeps what the browser showed.
const HOME_ASSISTANT = process.env.ASSISTANT_DRILL_HOME_ASSISTANT ?? "";
const SERVE_ON = process.env.ASSISTANT_DRILL_SERVE_ON ?? "";
const SCREENSHOTS = process.env.ASSISTANT_DRILL_SCREENSHOTS ?? "";
const CLIENT_ID = `${HOME_ASSISTANT}/`;
const ANSWER_BOX = "input_text.autoheal_answers";
const AUTOMATION = "autoheal_assistant_drill";
const BLUEPRINT = "autoheal/autoheal-assistant.yaml";
const PHONE = "Drill phone";
const NO_SATELLITE_HERE = "assist_satellite.not_in_this_house";
const DRILL_MILLISECONDS = 5 * MILLISECONDS_PER_MINUTE;
const WAIT = { timeout: 30_000, interval: 250 };
const STARTING_MILLISECONDS = 2 * MILLISECONDS_PER_MINUTE;
const SECRET_BYTES = 18;
const TOKEN_DAYS = 1;
const DAY_MILLISECONDS = 24 * 60 * MILLISECONDS_PER_MINUTE;

interface HomeAssistantEvent {
  event_type?: string;
  data?: { entity_id?: string; new_state?: { state: string } };
}
type Push = { message: string; data?: { actions?: { action: string }[] } };

async function homeAssistant<Answer>(path: string, body?: unknown, token?: string): Promise<Answer> {
  const response = await fetch(`${HOME_ASSISTANT}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return (text === "" ? null : JSON.parse(text)) as Answer;
}

async function tokenFrom(code: string): Promise<string> {
  const response = await fetch(`${HOME_ASSISTANT}/auth/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: CLIENT_ID }),
  });
  if (!response.ok) throw new Error(`token: ${response.status}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

// Home Assistant's socket, as its own frontend and the companion app use it.
async function socketOf(token: string, onEvent: (event: unknown) => void = () => {}) {
  const socket = new WebSocket(`${HOME_ASSISTANT.replace("http", "ws")}/api/websocket`);
  const waiting = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        id?: number;
        success?: boolean;
        result?: unknown;
        error?: unknown;
        event?: unknown;
      };
      if (message.type === "auth_required") socket.send(JSON.stringify({ type: "auth", access_token: token }));
      if (message.type === "auth_ok") resolve();
      if (message.type === "auth_invalid") reject(new Error("auth invalid"));
      if (message.type === "event") onEvent(message.event);
      if (message.type !== "result") return;
      const entry = waiting.get(message.id!)!;
      waiting.delete(message.id!);
      if (message.success) entry.resolve(message.result);
      else entry.reject(new Error(JSON.stringify(message.error)));
    });
    socket.addEventListener("error", () => reject(new Error("socket error")));
  });
  const call = <Result>(type: string, fields: Record<string, unknown> = {}) =>
    new Promise<Result>((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      waiting.set(id, { resolve: (result) => resolve(result as Result), reject });
      socket.send(JSON.stringify({ ...fields, id, type }));
    });
  return { call, close: () => socket.close() };
}

const secret = () => randomBytes(SECRET_BYTES).toString("base64url");

// What a person does on an empty Home Assistant before the card's steps: its owner, then one user for Autoheal that
// is not an admin, as Autoheal's README asks.
async function onboarded() {
  const { auth_code } = await homeAssistant<{ auth_code: string }>("/api/onboarding/users", {
    client_id: CLIENT_ID,
    name: "Drill owner",
    username: "drill-owner",
    password: secret(),
    language: "en",
  });
  const ownerSession = await tokenFrom(auth_code);
  await homeAssistant("/api/onboarding/core_config", {}, ownerSession);
  await homeAssistant("/api/onboarding/analytics", {}, ownerSession);
  await homeAssistant(
    "/api/onboarding/integration",
    { client_id: CLIENT_ID, redirect_uri: `${CLIENT_ID}?auth_callback=1` },
    ownerSession,
  );
  const owner = await socketOf(ownerSession);
  const adminToken = await owner.call<string>("auth/long_lived_access_token", {
    client_name: "drill admin",
    lifespan: TOKEN_DAYS,
  });
  const readerPassword = secret();
  const { user } = await owner.call<{ user: { id: string } }>("config/auth/create", {
    name: "Autoheal reader",
    group_ids: ["system-users"],
    local_only: false,
  });
  await owner.call("config/auth_provider/homeassistant/create", {
    user_id: user.id,
    username: "autoheal-reader",
    password: readerPassword,
  });
  owner.close();
  const flow = await homeAssistant<{ flow_id: string }>("/auth/login_flow", {
    client_id: CLIENT_ID,
    handler: ["homeassistant", null],
    redirect_uri: `${CLIENT_ID}?auth_callback=1`,
  });
  const signedIn = await homeAssistant<{ type: string; result: string }>(`/auth/login_flow/${flow.flow_id}`, {
    client_id: CLIENT_ID,
    username: "autoheal-reader",
    password: readerPassword,
  });
  const reader = await socketOf(await tokenFrom(signedIn.result));
  const readerToken = await reader.call<string>("auth/long_lived_access_token", {
    client_name: "Autoheal",
    lifespan: TOKEN_DAYS,
  });
  reader.close();
  return { adminToken, readerToken };
}

it.runIf(HOME_ASSISTANT !== "" && SERVE_ON !== "")(
  "goes from the empty card to an answered test question, three buttons and one paste, and names what is missing",
  async () => {
    const { adminToken, readerToken } = await onboarded();
    // Its integrations load after its API answers: a helper can be made only once it runs.
    await vi.waitFor(
      async () => {
        const config = await homeAssistant<{ state: string }>("/api/config", undefined, adminToken);
        expect(config.state).toBe("RUNNING");
      },
      { timeout: STARTING_MILLISECONDS, interval: 1000 },
    );
    const pushes: Push[] = [];
    const lines: string[] = [];
    const admin = await socketOf(adminToken, (event) => {
      const change = event as HomeAssistantEvent;
      if (change.event_type === "state_changed" && change.data?.entity_id === ANSWER_BOX) {
        lines.push(change.data.new_state!.state);
      }
    });
    await admin.call("subscribe_events", { event_type: "state_changed" });
    // Step 1, as its button leads there: a Text helper of its own, any name.
    await admin.call("input_text/create", { name: "Autoheal answers", mode: "text", min: 0, max: 100 });

    // The blueprint as shipped, from a plain link: the file is not at the version's link until it is released.
    const files = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/yaml" });
      response.end(readFileSync(ASSISTANT_FILES.blueprint));
    });
    await new Promise<void>((resolve) => files.listen(0, SERVE_ON, resolve));
    const served = `http://${SERVE_ON}:${(files.address() as AddressInfo).port}/autoheal-assistant.yaml`;
    const imported = await admin.call<{ raw_data: string; validation_errors: unknown }>("blueprint/import", {
      url: served,
    });
    expect(imported.validation_errors ?? null).toBeNull();
    await admin.call("blueprint/save", {
      domain: "automation",
      path: "autoheal/autoheal-assistant",
      yaml: imported.raw_data,
    });
    files.close();

    // A made-up phone, listening as the companion app does.
    const registration = await homeAssistant<{ webhook_id: string }>(
      "/api/mobile_app/registrations",
      {
        device_id: "drill-phone-0001",
        app_id: "io.homeassistant.companion.android",
        app_name: "Home Assistant",
        app_version: "2026.11.0",
        device_name: PHONE,
        manufacturer: "Drill",
        model: "Drill",
        os_name: "Android",
        os_version: "16",
        supports_encryption: false,
        app_data: { push_websocket_channel: true },
      },
      adminToken,
    );
    const devices = await admin.call<{ id: string; name: string }[]>("config/device_registry/list");
    const phone = devices.find(({ name }) => name === PHONE)!.id;
    const channel = await socketOf(adminToken, (push) => pushes.push(push as Push));
    await channel.call("mobile_app/push_notification_channel", {
      webhook_id: registration.webhook_id,
      support_confirm: false,
    });
    const press = (action: string) =>
      homeAssistant(`/api/webhook/${registration.webhook_id}`, {
        type: "fire_event",
        data: { event_type: "mobile_app_notification_action", event_data: { action } },
      });

    // Autoheal, connected to Home Assistant as Settings does, on the reader's token.
    const controlPlane = await startTestControlPlane();
    const { client } = await fullySignedInAdmin(controlPlane);
    await client.put(apiPath(API_ROUTES.integration, { kind: "homeAssistant" }), {
      url: HOME_ASSISTANT,
      token: readerToken,
    });
    await vi.waitFor(() => expect(controlPlane.services.homeAssistant.connected()).toBe(true), WAIT);
    const view = async () => (await client.get(API_ROUTES.jarvis)).json<JarvisView>();
    const empty = await view();
    expect(empty).toMatchObject({ connected: false, homeAssistantConnected: true });

    // Steps 1 and 2 open Home Assistant's own pages, signed in as its owner would be.
    const browser = await chromium.launch();
    const context = await browser.newContext();
    await context.addInitScript((tokens) => localStorage.setItem("hassTokens", JSON.stringify(tokens)), {
      hassUrl: HOME_ASSISTANT,
      clientId: CLIENT_ID,
      access_token: adminToken,
      token_type: "Bearer",
      expires_in: DAY_MILLISECONDS / 1000,
      refresh_token: "",
      expires: Date.now() + DAY_MILLISECONDS,
    });
    const page = await context.newPage();
    const keep = async (name: string) => {
      if (SCREENSHOTS !== "") await page.screenshot({ path: join(SCREENSHOTS, `${name}.png`) });
    };
    await page.goto(empty.links!.helpers);
    await page.waitForURL(/\/config\/helpers/, WAIT);
    await expect.poll(() => page.getByText("Autoheal answers").count(), WAIT).toBeGreaterThan(0);
    await keep("1-helpers");
    await page.goto(empty.links!.blueprintImport);
    const typed = () =>
      page.locator("input").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
    await expect.poll(typed, WAIT).toContain(assistantFileLink(APP_VERSION, ASSISTANT_FILES.blueprint));
    await keep("2-blueprint-import");
    await browser.close();

    // Opening the blueprint made the webhook ID: the one paste, into the automation's form.
    const { view: connected } = (await client.post(API_ROUTES.jarvisConnect, {})).json<JarvisConnected>();
    const webhookId = connected.webhookId!;
    // One automation at a time, as a webhook ID can trigger only one: the last is gone before the next is made.
    let built = 0;
    const stateOf = (number: number) =>
      fetch(`${HOME_ASSISTANT}/api/states/automation.${AUTOMATION}_${number}`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
    const automation = async (input: Record<string, string>) => {
      const previous = built;
      built += 1;
      if (previous > 0) {
        await fetch(`${HOME_ASSISTANT}/api/config/automation/config/${AUTOMATION}_${previous}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${adminToken}` },
        });
        await vi.waitFor(async () => expect((await stateOf(previous)).status).toBe(404), WAIT);
      }
      await homeAssistant(
        `/api/config/automation/config/${AUTOMATION}_${built}`,
        {
          alias: `Autoheal assistant drill ${built}`,
          description: "",
          use_blueprint: { path: BLUEPRINT, input: { webhook_id: webhookId, answer_box: ANSWER_BOX, ...input } },
        },
        adminToken,
      );
      await vi.waitFor(async () => {
        const state = (await (await stateOf(built)).json()) as { state?: string };
        expect(state.state).toBe("on");
      }, WAIT);
    };
    const asked = async () =>
      expect((await client.post(API_ROUTES.jarvisTestQuestion, {})).json()).toEqual({ delivered: true });
    const outcome = async () => (await view()).testQuestion;

    // Step 3, with a phone: its Yes is the answer, and asking can be ticked from then on.
    await automation({ phone });
    expect((await client.put(API_ROUTES.jarvisAsking, { updates: true, versions: true })).statusCode).toBe(409);
    await asked();
    await vi.waitFor(() => expect(pushes.some(({ data }) => data?.actions !== undefined)).toBe(true), WAIT);
    const question = pushes.find(({ data }) => data?.actions !== undefined)!;
    expect(question.message).toBe("A test from Autoheal. Can you hear me?");
    const yes = question.data!.actions!.find(({ action }) => action.startsWith("AUTOHEAL_YES_"))!.action;
    await press(yes);
    await expect.poll(outcome, WAIT).toMatchObject({ outcome: "answered", answer: { said: "yes", how: "phone" } });
    expect(lines.at(-1)).toMatch(/^autoheal yes [\w-]{22} \d+ phone$/);
    expect((await client.put(API_ROUTES.jarvisAsking, { updates: true, versions: true })).statusCode).toBe(204);
    expect((await view()).asking).toEqual({ ready: true, updates: true, versions: true });

    // Nowhere to ask: shown in Home Assistant and heard, and nobody can answer it.
    await automation({});
    const heardBefore = lines.length;
    await asked();
    expect((await view()).asking.ready).toBe(false);
    await vi.waitFor(
      () => expect(lines.slice(heardBefore).some((line) => line.startsWith("autoheal heard "))).toBe(true),
      WAIT,
    );
    controlPlane.clock.now += JARVIS_LIMITS.testQuestionMilliseconds;
    await expect.poll(async () => (await outcome())?.outcome, WAIT).toBe("not_answered");

    // A satellite that is not there, and no phone: Home Assistant puts it off.
    await automation({ satellite: NO_SATELLITE_HERE });
    await asked();
    await expect.poll(async () => (await outcome())?.outcome, WAIT).toBe("put_off");

    channel.close();
    admin.close();
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  },
  DRILL_MILLISECONDS,
);
