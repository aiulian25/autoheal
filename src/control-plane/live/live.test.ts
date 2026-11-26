import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import {
  EVERY_RUNNER_CAPABILITY,
  containerSnapshot,
  heartbeatWith,
  hostHealth,
} from "../../../test/support/inventory.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import { API_ERRORS, API_ROUTES, type EnrolledHostView } from "../../shared/api.js";
import { RUNNER_ROUTES, type Heartbeat } from "../../shared/protocol.js";
import type { LiveEvent } from "./live-events.js";
import {
  HTTP_HEADERS,
  HTTP_STATUS,
  LIVE_KEEPALIVE_MILLISECONDS,
  LIVE_STREAMS_PER_ACCOUNT,
} from "../../shared/constants.js";

describe("the live stream", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  it("tells a signed-in dashboard what changes as it changes, and ends with its sign-in", async () => {
    // Only the stream's own timer is the test's: the server's others run as they do.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const subscribe = vi.spyOn(controlPlane.services.live, "subscribe");
    const stream = admin.get(API_ROUTES.live);
    while (subscribe.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    controlPlane.services.live.publish({ kind: "inventory", hostId: "h1", changed: true });
    controlPlane.services.live.publish({ kind: "job", hostId: "h1", jobId: "j1" });
    vi.advanceTimersByTime(LIVE_KEEPALIVE_MILLISECONDS);

    // Signed out: the next keepalive ends the stream instead.
    expect((await admin.post(API_ROUTES.logout)).statusCode).toBe(204);
    vi.advanceTimersByTime(LIVE_KEEPALIVE_MILLISECONDS);
    const response = await stream;
    expect(response.headers[HTTP_HEADERS.contentType]).toContain("text/event-stream");
    expect(response.body).toBe(
      ":\n\n" +
        'event: inventory\ndata: {"kind":"inventory","hostId":"h1","changed":true}\n\n' +
        'event: job\ndata: {"kind":"job","hostId":"h1","jobId":"j1"}\n\n' +
        ":\n\n",
    );
    // The stream that ended left nothing listening: its listener is gone already.
    expect(subscribe.mock.results[0]!.value()).toBe(false);
  });

  it("says with each host's report whether it changed what tasks are opened from", async () => {
    const events: LiveEvent[] = [];
    controlPlane.services.live.subscribe((event) => events.push(event));
    const added = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    const beat = async (payload: Heartbeat) => {
      const answer = await controlPlane.runnerApp.inject({
        method: "POST",
        url: RUNNER_ROUTES.heartbeat,
        headers: {
          authorization: `Bearer ${runnerTokenOf(added)}`,
          [HTTP_HEADERS.runnerCapabilities]: EVERY_RUNNER_CAPABILITY,
        },
        payload,
      });
      expect(answer.statusCode, answer.body).toBe(200);
    };
    const running = containerSnapshot({ name: "paperless" });
    const stopped = { ...running, state: "exited" as const, exitCode: 1 };
    // Its first report; then one where only a figure moved; one where a container stopped; one where a reboot waits.
    await beat(heartbeatWith({ containers: [running], host: hostHealth() }));
    await beat(heartbeatWith({ containers: [running], host: hostHealth({ loadAverage: [2, 1, 1] }) }));
    await beat(heartbeatWith({ containers: [stopped], host: hostHealth({ loadAverage: [2, 1, 1] }) }));
    await beat(heartbeatWith({ containers: [stopped], host: hostHealth({ rebootRequired: true }) }));
    const reports = events.filter((event) => event.kind === "inventory");
    expect(reports.map((event) => event.kind === "inventory" && event.changed)).toEqual([true, false, true, true]);
  });

  it("closes existing streams during restore before generation invalidation", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const subscribe = vi.spyOn(controlPlane.services.live, "subscribe");
    const stream = admin.get(API_ROUTES.live).catch(() => null);
    while (subscribe.mock.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    await controlPlane.services.databaseHandle.restore.exclusive(async () => {
      controlPlane.services.databaseHandle.restore.replaced();
    });
    await stream;
    expect(() => vi.advanceTimersByTime(LIVE_KEEPALIVE_MILLISECONDS)).not.toThrow();
    expect(subscribe.mock.results[0]!.value()).toBe(false);
  });

  it("refuses an account one stream past its share, as too many at once", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const subscribe = vi.spyOn(controlPlane.services.live, "subscribe");
    const streams = Array.from({ length: LIVE_STREAMS_PER_ACCOUNT }, () => admin.get(API_ROUTES.live));
    while (subscribe.mock.calls.length < LIVE_STREAMS_PER_ACCOUNT)
      await new Promise((resolve) => setImmediate(resolve));
    const refused = await admin.get(API_ROUTES.live);
    expect(refused.statusCode).toBe(HTTP_STATUS.tooManyRequests);
    expect(refused.json<{ error: string }>().error).toBe(API_ERRORS.liveStreamsFull);
    expect((await admin.post(API_ROUTES.logout)).statusCode).toBe(204);
    vi.advanceTimersByTime(LIVE_KEEPALIVE_MILLISECONDS);
    await Promise.all(streams);
  });

  it("is not for a browser that is not signed in", async () => {
    expect((await controlPlane.client().get(API_ROUTES.live)).statusCode).toBe(401);
  });
});
