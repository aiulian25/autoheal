import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startTestControlPlane,
  runnerTokenOf,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { fillNotificationQueue } from "../../../test/support/notifications.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { API_ERRORS, API_ROUTES, apiPath, type EnrolledHostView } from "../../shared/api.js";
import { INCIDENT_STATUS } from "../../shared/constants.js";
import { type NotificationInbox, type NotificationRule } from "../../shared/notification-deliveries.js";
import { RUNNER_ROUTES } from "../../shared/protocol.js";
const PRIVATE = "unrecognizable-private-application-content";
describe("notification delivery API", () => {
  let plane: TestControlPlane, admin: TestClient, host: EnrolledHostView, requests: RequestInit[];
  const integration = () => apiPath(API_ROUTES.integration, { kind: "gotify" });
  const runnerNotice = (token = runnerTokenOf(host), notificationId = randomUUID(), incidentId: string | null = null) =>
    plane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.notifications,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        notificationId,
        incidentId,
        containerName: "app",
        verdict: "needs you",
        outcome: "password=synthetic-application-password",
        diagnosis: PRIVATE,
        stateSummary: "status=exited",
      },
    });
  beforeEach(async () => {
    requests = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        requests.push(init);
        return new Response(null, { status: 200 });
      }),
    );
    plane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(plane)).client;
    host = (await admin.post(API_ROUTES.hosts, { label: "Lab" })).json<EnrolledHostView>();
    expect(
      (await admin.put(integration(), { url: "https://provider.test", token: "private-provider-token" })).statusCode,
    ).toBe(204);
  });
  afterEach(async () => {
    await plane.app.close();
    await plane.runnerApp.close();
    vi.unstubAllGlobals();
  });
  it("persists runner notices before sending, deduplicates stable IDs and exposes only delivery metadata", async () => {
    const id = randomUUID();
    expect((await runnerNotice(undefined, id)).statusCode).toBe(204);
    expect((await runnerNotice(undefined, id)).statusCode).toBe(204);
    expect(requests).toHaveLength(0);
    const viewer = (await fullySignedInUser(plane, admin, "observer", "viewer")).client;
    const pending = await viewer.get(API_ROUTES.notificationDeliveries);
    expect(pending.statusCode).toBe(200);
    expect(pending.json<NotificationInbox>().events).toHaveLength(1);
    expect(pending.body).not.toContain(PRIVATE);
    expect(pending.body).not.toContain("private-provider-token");
    expect(pending.body).not.toContain("synthetic-application-password");
    await plane.services.notificationDeliveries.tick();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).not.toContain("synthetic-application-password");
    const accepted = (await admin.get(API_ROUTES.notificationDeliveries)).json<NotificationInbox>();
    expect(accepted.events[0]?.deliveries[0]).toMatchObject({
      status: "accepted",
      acceptedAt: plane.clock.now,
      attempts: 1,
    });
    const eventId = accepted.events[0]!.id;
    expect((await viewer.post(apiPath(API_ROUTES.notificationAcknowledge, { eventId }))).statusCode).toBe(403);
    expect((await admin.post(apiPath(API_ROUTES.notificationAcknowledge, { eventId }))).statusCode).toBe(204);
    expect((await admin.post(apiPath(API_ROUTES.notificationAcknowledge, { eventId }))).statusCode).toBe(204);
    expect(plane.stdout.filter((line) => line.includes("notification.acknowledged"))).toHaveLength(1);
  });
  it("requires admin acknowledgement/retry/routing and does not move queued messages to changed channels implicitly", async () => {
    await runnerNotice();
    await admin.put(integration(), { url: "https://changed-provider.test", token: "replacement-private-token" });
    await plane.services.notificationDeliveries.tick();
    expect(requests).toHaveLength(0);
    const event = (await admin.get(API_ROUTES.notificationDeliveries)).json<NotificationInbox>().events[0]!;
    const deliveryId = event.deliveries[0]!.id;
    expect(event.deliveries[0]?.failureCode).toBe("configuration_changed");
    const viewer = (await fullySignedInUser(plane, admin, "observer", "viewer")).client;
    expect((await viewer.post(apiPath(API_ROUTES.notificationRetry, { deliveryId }))).statusCode).toBe(403);
    expect((await admin.post(apiPath(API_ROUTES.notificationRetry, { deliveryId }))).statusCode).toBe(204);
    await plane.services.notificationDeliveries.tick();
    expect(requests).toHaveLength(1);
    const rule: NotificationRule = {
      id: randomUUID(),
      hostId: host.host.id,
      priorities: ["urgent", "high"],
      channels: ["gotify"],
      quietStartMinute: 22 * 60,
      quietEndMinute: 7 * 60,
      urgentOverride: true,
      escalateAfterMinutes: 15,
      escalationChannels: ["ntfy"],
    };
    expect((await viewer.put(API_ROUTES.notificationRouting, { rules: [rule] })).statusCode).toBe(403);
    expect((await admin.put(API_ROUTES.notificationRouting, { rules: [rule] })).statusCode).toBe(200);
    expect(
      (await admin.put(API_ROUTES.notificationRouting, { rules: [{ ...rule, quietEndMinute: rule.quietStartMinute }] }))
        .statusCode,
    ).toBe(400);
    // A rule may send through every channel there is.
    const everyChannel = { ...rule, channels: ["gotify", "ntfy", "webhook"] };
    expect((await admin.put(API_ROUTES.notificationRouting, { rules: [everyChannel] })).statusCode).toBe(200);
    expect(plane.stdout.join("\n")).toContain("notification.retried");
    expect(plane.stdout.join("\n")).toContain("notification.routes_saved");
    expect(plane.stdout.join("\n")).not.toContain(PRIVATE);
    expect(plane.stdout.join("\n")).not.toContain("replacement-private-token");
  });
  it("requires explicit administrator approval to queue an alert captured without any channels", async () => {
    await admin.delete(integration());
    await runnerNotice();
    const event = (await admin.get(API_ROUTES.notificationDeliveries)).json<NotificationInbox>().events[0]!;
    expect(event.deliveries).toHaveLength(0);
    const viewer = (await fullySignedInUser(plane, admin, "observer", "viewer")).client;
    const path = apiPath(API_ROUTES.notificationRouteUnsent, { eventId: event.id });
    expect((await viewer.post(path)).statusCode).toBe(403);
    await admin.put(integration(), { url: "https://provider.test", token: "configured-later" });
    expect((await admin.post(path)).statusCode).toBe(204);
    await plane.services.notificationDeliveries.tick();
    expect(requests).toHaveLength(1);
    expect((await admin.get(API_ROUTES.notificationDeliveries)).json<NotificationInbox>().events).toHaveLength(1);
  });
  it("refuses a runner's notice while the queue is full, so the runner tells people through its own Gotify", async () => {
    fillNotificationQueue(plane.services.databaseHandle, plane.clock.now);
    const refused = await runnerNotice();
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toEqual({ error: API_ERRORS.notificationQueueFull });
  });
  it("binds incident notifications to the enrolled host before deduplication", async () => {
    const source = plane.services.hostsService.authenticate(runnerTokenOf(host))!;
    const incidentId = plane.services.incidentsService.create(
      source,
      {
        detectedAt: plane.clock.now,
        report: {
          containerName: "app",
          image: "app:1",
          trigger: "die",
          stateSummary: "status=exited",
          logs: "",
          healthOutputs: [],
          knownContainers: ["app"],
          protectedContainers: [],
        },
      },
      INCIDENT_STATUS.resolved,
    ).id;
    const notificationId = randomUUID();
    expect((await runnerNotice(undefined, notificationId, incidentId)).statusCode).toBe(204);
    const other = (await admin.post(API_ROUTES.hosts, { label: "Other" })).json<EnrolledHostView>();
    expect((await runnerNotice(runnerTokenOf(other), notificationId, incidentId)).statusCode).toBe(422);
    expect(
      (await admin.get(`${API_ROUTES.notificationDeliveries}?incidentId=${incidentId}`)).json<NotificationInbox>()
        .events,
    ).toHaveLength(1);
  });
});
