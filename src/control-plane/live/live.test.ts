import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTestControlPlane, type TestClient, type TestControlPlane } from "../../../test/support/control-plane.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import { API_ROUTES } from "../../shared/api.js";
import { HTTP_HEADERS, LIVE_KEEPALIVE_MILLISECONDS } from "../../shared/constants.js";

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
    controlPlane.services.live.publish({ kind: "inventory", hostId: "h1" });
    controlPlane.services.live.publish({ kind: "job", hostId: "h1", jobId: "j1" });
    vi.advanceTimersByTime(LIVE_KEEPALIVE_MILLISECONDS);

    // Signed out: the next keepalive ends the stream instead.
    expect((await admin.post(API_ROUTES.logout)).statusCode).toBe(204);
    vi.advanceTimersByTime(LIVE_KEEPALIVE_MILLISECONDS);
    const response = await stream;
    expect(response.headers[HTTP_HEADERS.contentType]).toContain("text/event-stream");
    expect(response.body).toBe(
      ":\n\n" +
        'event: inventory\ndata: {"kind":"inventory","hostId":"h1"}\n\n' +
        'event: job\ndata: {"kind":"job","hostId":"h1","jobId":"j1"}\n\n' +
        ":\n\n",
    );
    // The stream that ended left nothing listening: its listener is gone already.
    expect(subscribe.mock.results[0]!.value()).toBe(false);
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

  it("is not for a browser that is not signed in", async () => {
    expect((await controlPlane.client().get(API_ROUTES.live)).statusCode).toBe(401);
  });
});
