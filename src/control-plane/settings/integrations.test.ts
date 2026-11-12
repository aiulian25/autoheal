import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeGotify } from "../../../test/fakes/fake-gotify.js";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import {
  API_ROUTES,
  apiPath,
  type AuditEventView,
  type EnrolledHostView,
  type IntegrationTestView,
  type IntegrationView,
} from "../../shared/api.js";
import { SETTING_KEYS } from "../../shared/constants.js";
import type { NotificationInbox } from "../../shared/notification-deliveries.js";
import { RUNNER_ROUTES } from "../../shared/protocol.js";
import { settings } from "../database/schema.js";
import { SecretBox } from "../database/secret-box.js";

const integration = (kind: string) => apiPath(API_ROUTES.integration, { kind });
const viewOf = async (client: TestClient, kind: string) =>
  (await client.get(API_ROUTES.integrations)).json<IntegrationView[]>().find((view) => view.kind === kind)!;

async function eventually(check: () => boolean) {
  for (let attempt = 0; attempt < 50 && !check(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface Received {
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

// A webhook's receiver on this machine: it keeps what arrives, and answers with the status it is given.
class Receiver {
  readonly requests: Received[] = [];
  status = 200;
  origin = "";
  private readonly server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      this.requests.push({ path: request.url ?? "", authorization: request.headers.authorization, body });
      response.writeHead(this.status).end();
    });
  });

  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  close() {
    return new Promise((resolve) => this.server.close(resolve));
  }
}

describe("notification channels and Home Assistant, set in the dashboard", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let gotify: FakeGotify;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane({ homeAssistant: { url: "https://192.168.10.142", token: "from-env" } });
    admin = (await fullySignedInAdmin(controlPlane)).client;
    gotify = await FakeGotify.start();
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
    await gotify.close();
  });

  it("keeps tokens to itself, and a new address needs its token again", async () => {
    expect((await admin.put(integration("gotify"), { url: gotify.settings.url })).json()).toEqual({
      error: "integration_token_required",
    });
    expect((await admin.put(integration("gotify"), { url: gotify.settings.url, token: "app-token" })).statusCode).toBe(
      204,
    );
    expect(await viewOf(admin, "gotify")).toEqual({
      kind: "gotify",
      source: "dashboard",
      url: gotify.settings.url,
      topic: null,
      format: null,
      tokenSet: true,
      plainHttp: false,
      delivery: { status: "unknown", lastAttemptAt: null, lastSuccessAt: null, failureCode: null },
    });
    // Unchanged address: the token stays. Another address: it must come again.
    expect((await admin.put(integration("gotify"), { url: gotify.settings.url })).statusCode).toBe(204);
    const moved = await admin.put(integration("gotify"), { url: "https://elsewhere.example.org" });
    expect(moved.json()).toEqual({ error: "integration_token_required" });

    const everything = JSON.stringify([
      (await admin.get(API_ROUTES.integrations)).json(),
      (await admin.get(API_ROUTES.audit)).json<AuditEventView[]>(),
    ]);
    expect(everything).not.toContain("app-token");
    expect(everything).toContain("integration.saved");
  });

  it("stores a token sealed, and still sends with the token as given", async () => {
    await admin.put(integration("gotify"), gotify.settings);
    const rows = JSON.stringify(controlPlane.services.databaseHandle.database.select().from(settings).all());
    expect(rows).not.toContain(gotify.settings.token);
    await admin.post(apiPath(API_ROUTES.integrationTest, { kind: "gotify" }));
    expect(gotify.messages.map((message) => message.key)).toEqual([gotify.settings.token]);
  });

  it("asks again for a token another backup passphrase sealed, instead of keeping it", async () => {
    await admin.put(integration("gotify"), gotify.settings);
    const foreign = SecretBox.fromPassphrase("another-backup-passphrase-0123456789abcdef").seal(gotify.settings.token);
    controlPlane.services.databaseHandle.database
      .update(settings)
      .set({ valueJson: JSON.stringify({ url: gotify.settings.url, topic: null, token: foreign }) })
      .where(eq(settings.key, SETTING_KEYS.gotify))
      .run();
    expect(await viewOf(admin, "gotify")).toMatchObject({
      source: "dashboard",
      url: gotify.settings.url,
      tokenSet: false,
    });
    expect(controlPlane.services.integrationsService.gotify()).toBeNull();
    expect((await admin.put(integration("gotify"), { url: gotify.settings.url })).json()).toEqual({
      error: "integration_token_required",
    });
    expect((await admin.put(integration("gotify"), gotify.settings)).statusCode).toBe(204);
    expect(controlPlane.services.integrationsService.gotify()).toEqual(gotify.settings);
  });

  it("lets viewers see where things point but not change them, and leaves .env settings fixed", async () => {
    const { client: viewer } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    expect(await viewOf(viewer, "homeAssistant")).toMatchObject({ source: "environment", tokenSet: true });
    expect((await viewer.put(integration("ntfy"), { url: "https://ntfy.sh", topic: "home" })).statusCode).toBe(403);
    expect((await admin.delete(integration("homeAssistant"))).json()).toEqual({
      error: "integration_from_environment",
    });
  });

  it("refuses a user or password in an address, and takes the token in its own field", async () => {
    const refused = await admin.put(integration("ntfy"), {
      url: "https://reader:address-marker@ntfy.example.test",
      topic: "home",
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toEqual({ error: "integration_address_credentials" });
    expect(controlPlane.services.integrationsService.ntfy()).toBeNull();
    const taken = await admin.put(integration("ntfy"), {
      url: "https://ntfy.example.test",
      topic: "home",
      token: "address-marker",
    });
    expect(taken.statusCode).toBe(204);

    const everything = JSON.stringify([
      (await admin.get(API_ROUTES.integrations)).json(),
      (await admin.get(API_ROUTES.audit)).json<AuditEventView[]>(),
      controlPlane.stdout,
    ]);
    expect(everything).toContain("integration.saved");
    expect(everything).not.toContain("address-marker");
  });

  it("shows viewers an address saved before with its user part left out", async () => {
    await admin.put(integration("ntfy"), { url: "https://ntfy.example.test/base", topic: "home" });
    controlPlane.services.databaseHandle.database
      .update(settings)
      .set({
        valueJson: JSON.stringify({
          url: "https://reader:address-marker@ntfy.example.test/base",
          topic: "home",
          token: null,
        }),
      })
      .where(eq(settings.key, SETTING_KEYS.ntfy))
      .run();
    const { client: viewer } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");

    const shown = await viewOf(viewer, "ntfy");
    expect(shown).toMatchObject({ source: "dashboard", url: "https://ntfy.example.test/base", topic: "home" });
    expect(JSON.stringify((await viewer.get(API_ROUTES.integrations)).json())).not.toContain("address-marker");
  });

  it("takes an open ntfy topic over plain http, and says it is plain http", async () => {
    expect((await admin.put(integration("ntfy"), { url: "http://ntfy.home.lan" })).statusCode).toBe(400);
    expect((await admin.put(integration("ntfy"), { url: "http://ntfy.home.lan", topic: "home" })).statusCode).toBe(204);
    expect(await viewOf(admin, "ntfy")).toMatchObject({ topic: "home", tokenSet: false, plainHttp: true });
    expect((await admin.delete(integration("ntfy"))).statusCode).toBe(204);
    expect((await viewOf(admin, "ntfy")).source).toBeNull();
  });

  it("observes server refusal and recovery without testing on reads, and resets after configuration edits", async () => {
    await admin.put(integration("gotify"), { url: gotify.settings.url, token: "app-token" });
    expect((await viewOf(admin, "gotify")).delivery?.status).toBe("unknown");
    expect(gotify.messages).toHaveLength(0);
    gotify.status = 401;
    const failed = await admin.post(apiPath(API_ROUTES.integrationTest, { kind: "gotify" }));
    expect(failed.json()).toMatchObject({
      problem: "it answered HTTP 401",
      delivery: { status: "degraded", failureCode: "refused", lastSuccessAt: null },
    });
    expect((await viewOf(admin, "gotify")).delivery?.status).toBe("degraded");
    gotify.status = 200;
    controlPlane.clock.now += 1000;
    await admin.post(apiPath(API_ROUTES.integrationTest, { kind: "gotify" }));
    expect((await viewOf(admin, "gotify")).delivery).toEqual({
      status: "healthy",
      lastAttemptAt: controlPlane.clock.now,
      lastSuccessAt: controlPlane.clock.now,
      failureCode: null,
    });
    const before = gotify.messages.length;
    await admin.put(integration("gotify"), { url: gotify.settings.url, token: "new-token" });
    expect((await viewOf(admin, "gotify")).delivery?.status).toBe("unknown");
    expect(gotify.messages).toHaveLength(before);
  });

  it("sends a test, and tells about every incident a runner handled on the channels set here", async () => {
    expect((await admin.post(apiPath(API_ROUTES.integrationTest, { kind: "gotify" }))).json()).toEqual({
      error: "integration_not_set",
    });
    await admin.put(integration("gotify"), { url: gotify.settings.url, token: "app-token" });
    expect((await admin.post(apiPath(API_ROUTES.integrationTest, { kind: "gotify" }))).json()).toEqual({
      problem: null,
      delivery: {
        status: "healthy",
        lastAttemptAt: controlPlane.clock.now,
        lastSuccessAt: controlPlane.clock.now,
        failureCode: null,
      },
    });

    const token = runnerTokenOf((await admin.post(API_ROUTES.hosts, { label: "HP" })).json<EnrolledHostView>());
    const relayed = await controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.notifications,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        containerName: "tika",
        verdict: "needs you",
        outcome: "Needs you, nothing was changed.",
        diagnosis: "It keeps failing on a missing setting.",
        stateSummary: "status=exited",
        incidentId: null,
      },
    });
    expect(relayed.statusCode).toBe(204);
    expect(gotify.messages).toHaveLength(1);
    expect(controlPlane.services.notificationDeliveries.list().pendingCount).toBe(1);
    await controlPlane.services.notificationDeliveries.tick();
    await eventually(() => gotify.messages.length === 2);
    expect(gotify.messages.map((message) => [message.title, message.priority, message.key])).toEqual([
      ["Autoheal test", 5, "app-token"],
      ["Autoheal HP: tika needs you", 8, "app-token"],
    ]);
  });
});

describe("a webhook", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let receiver: Receiver;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
    receiver = new Receiver();
    await receiver.start();
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
    await receiver.close();
  });

  it("keeps its address sealed and shows it up to its host, and a test reaches the receiver as Discord takes it", async () => {
    const address = `${receiver.origin}/api/webhooks/1/secret-key`;
    expect((await admin.put(integration("webhook"), { url: address })).statusCode).toBe(400);
    expect((await admin.put(integration("webhook"), { url: address, format: "discord" })).statusCode).toBe(204);
    const { client: viewer } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    expect(await viewOf(viewer, "webhook")).toMatchObject({
      source: "dashboard",
      url: `${receiver.origin}/…`,
      format: "discord",
      tokenSet: false,
      plainHttp: true,
    });
    const kept = JSON.stringify([
      controlPlane.services.databaseHandle.database.select().from(settings).all(),
      (await admin.get(API_ROUTES.audit)).json<AuditEventView[]>(),
      (await admin.get(API_ROUTES.integrations)).json(),
    ]);
    expect(kept).not.toContain("secret-key");
    expect(kept).toContain("integration.saved");

    const tested = await admin.post(apiPath(API_ROUTES.integrationTest, { kind: "webhook" }));
    expect(tested.json<IntegrationTestView>()).toMatchObject({ problem: null, delivery: { status: "healthy" } });
    expect(receiver.requests).toEqual([
      {
        path: "/api/webhooks/1/secret-key",
        authorization: undefined,
        body: {
          allowed_mentions: { parse: [] },
          embeds: [{ title: "Autoheal test", description: expect.any(String), url: expect.any(String) }],
        },
      },
    ]);
  });

  it("reads as not set up when another backup passphrase sealed its address", async () => {
    await admin.put(integration("webhook"), { url: `${receiver.origin}/hook`, format: "json" });
    const foreign = SecretBox.fromPassphrase("another-backup-passphrase-0123456789abcdef");
    controlPlane.services.databaseHandle.database
      .update(settings)
      .set({
        valueJson: JSON.stringify({
          url: foreign.seal(`${receiver.origin}/hook`),
          topic: null,
          token: null,
          format: "json",
        }),
      })
      .where(eq(settings.key, SETTING_KEYS.webhook))
      .run();
    expect((await viewOf(admin, "webhook")).source).toBeNull();
    expect(controlPlane.services.integrationsService.webhook()).toBeNull();
  });

  it("sends its token, which stays only while the address does, and an alert refused waits in the inbox to go again", async () => {
    const address = `${receiver.origin}/alerts`;
    await admin.put(integration("webhook"), { url: address, format: "json", token: "receiver-token" });
    await admin.put(integration("webhook"), { url: address, format: "json" });
    expect((await viewOf(admin, "webhook")).tokenSet).toBe(true);
    await admin.put(integration("webhook"), { url: `${address}/elsewhere`, format: "json" });
    expect((await viewOf(admin, "webhook")).tokenSet).toBe(false);
    await admin.put(integration("webhook"), { url: address, format: "json", token: "receiver-token" });

    receiver.status = 500;
    const token = runnerTokenOf((await admin.post(API_ROUTES.hosts, { label: "HP" })).json<EnrolledHostView>());
    const relayed = await controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.notifications,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        containerName: "tika",
        verdict: "needs you",
        outcome: "Needs you, nothing was changed.",
        diagnosis: "It keeps failing on a missing setting.",
        stateSummary: "status=exited",
        incidentId: null,
      },
    });
    expect(relayed.statusCode).toBe(204);
    const deliveries = controlPlane.services.notificationDeliveries;
    const firstDelivery = () => deliveries.list().events[0]?.deliveries[0];
    const inbox = async () =>
      (await admin.get(API_ROUTES.notificationDeliveries)).json<NotificationInbox>().events[0]!.deliveries[0]!;
    await deliveries.tick();
    await eventually(() => firstDelivery()?.failureCode === "refused");
    const refused = await inbox();
    expect(refused).toMatchObject({ channel: "webhook", status: "queued", attempts: 1, failureCode: "refused" });
    expect(refused.nextAttemptAt).toBeGreaterThan(controlPlane.clock.now);
    expect(receiver.requests).toEqual([
      {
        path: "/alerts",
        authorization: "Bearer receiver-token",
        body: {
          title: "Autoheal HP: tika needs you",
          message: expect.stringContaining("It keeps failing on a missing setting."),
          priority: "high",
          link: expect.any(String),
        },
      },
    ]);

    // When its wait is over, it goes again, and the receiver takes it.
    receiver.status = 200;
    controlPlane.clock.now = refused.nextAttemptAt!;
    await deliveries.tick();
    await eventually(() => firstDelivery()?.status === "accepted");
    expect(await inbox()).toMatchObject({ status: "accepted", attempts: 2, failureCode: null });
    expect(receiver.requests).toHaveLength(2);
  });
});

it("forgets delivery observations when the database restore lifecycle resumes", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const cp = await startTestControlPlane();
  try {
    const { client: admin } = await fullySignedInAdmin(cp);
    await admin.put(integration("gotify"), { url: "https://mock.test", token: "private-token" });
    await admin.post(apiPath(API_ROUTES.integrationTest, { kind: "gotify" }));
    expect((await viewOf(admin, "gotify")).delivery?.status).toBe("healthy");
    await cp.services.databaseHandle.restore.exclusive(async () => cp.services.databaseHandle.restore.replaced());
    expect((await viewOf(admin, "gotify")).delivery?.status).toBe("unknown");
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    await cp.app.close();
    await cp.runnerApp.close();
    cp.services.databaseHandle.close();
    vi.unstubAllGlobals();
  }
});
