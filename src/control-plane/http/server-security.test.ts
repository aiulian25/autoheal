import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PUBLIC_HOST,
  PUBLIC_ORIGIN,
  TRUSTED_PROXY,
  startTestControlPlane,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { API_ROUTES } from "../../shared/api.js";
import { GLOBAL_RATE_LIMIT_PER_MINUTE } from "../../shared/constants.js";
import { auditEvents } from "../database/schema.js";

describe("dashboard HTTP security", () => {
  let controlPlane: TestControlPlane;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane({
      extendApp: (app) => {
        app.get("/api/test/boom", { config: { access: "public" } }, async () => {
          throw new Error("secret internals at /app/dist/server/x.js:12");
        });
        app.get("/api/test/whoami", { config: { access: "public" } }, async (request) => ({ ip: request.ip }));
      },
    });
  });

  afterEach(() => controlPlane.app.close());

  it.each([
    ["an API route", "/api/session"],
    ["an unknown route", "/nowhere"],
  ])("sends the security headers on %s", async (_case, url) => {
    const response = await controlPlane.client().get(url);
    const policy = String(response.headers["content-security-policy"]);
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("style-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("unsafe-inline");
    expect(response.headers["strict-transport-security"]).toBe("max-age=31536000");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["permissions-policy"]).toContain("camera=()");
  });

  it("keeps API responses out of caches", async () => {
    const response = await controlPlane.client().get(API_ROUTES.session);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  // The router decodes the address before matching it: these reach /api/users and /api/audit.
  it.each(["/%61pi/users", "/api/%75sers", "/%61%70%69/audit"])(
    "guards an API route however its address is encoded: %s",
    async (url) => {
      const response = await controlPlane.client().get(url);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: "not_signed_in" });
      expect(response.headers["cache-control"]).toBe("no-store");
    },
  );

  it("answers 421 to a host it does not serve, still with headers", async () => {
    const response = await controlPlane.app.inject({
      method: "GET",
      url: "/api/session",
      headers: { host: "192.168.10.5:8443" },
    });
    expect(response.statusCode).toBe(421);
    expect(response.json()).toEqual({ error: "misdirected_request" });
    expect(response.headers["content-security-policy"]).toBeDefined();
  });

  it("refuses state changes without the dashboard's Origin", async () => {
    const login = { username: "admin", password: "whatever-password" };
    const missing = await controlPlane.app.inject({
      method: "POST",
      url: API_ROUTES.login,
      payload: login,
      headers: { host: PUBLIC_HOST },
    });
    const foreign = await controlPlane.app.inject({
      method: "POST",
      url: API_ROUTES.login,
      payload: login,
      headers: { host: PUBLIC_HOST, origin: "https://evil.example" },
    });
    expect([missing.statusCode, foreign.statusCode]).toEqual([403, 403]);
    expect(missing.json()).toEqual({ error: "csrf_failed" });
  });

  it("requires the session's CSRF token once signed in", async () => {
    const password = await controlPlane.firstAdminPassword();
    const client = controlPlane.client();
    await client.signIn("admin", password);
    const withoutToken = await client.request({
      method: "POST",
      url: API_ROUTES.logout,
      headers: { "x-csrf-token": "forged" },
    });
    expect(withoutToken.statusCode).toBe(403);
    const withToken = await client.post(API_ROUTES.logout);
    expect(withToken.statusCode).toBe(204);
  });

  it("trusts X-Forwarded-For only from the configured proxy", async () => {
    const forwarded = { host: PUBLIC_HOST, "x-forwarded-for": "203.0.113.9" };
    const direct = await controlPlane.app.inject({
      url: "/api/test/whoami",
      headers: forwarded,
      remoteAddress: "192.168.10.50",
    });
    expect(direct.json()).toEqual({ ip: "192.168.10.50" });
    const viaProxy = await controlPlane.app.inject({
      url: "/api/test/whoami",
      headers: forwarded,
      remoteAddress: TRUSTED_PROXY,
    });
    expect(viaProxy.json()).toEqual({ ip: "203.0.113.9" });
  });

  it("accepts the public host as X-Forwarded-Host from the trusted proxy only", async () => {
    const headers = { host: "172.18.0.5:8443", "x-forwarded-host": PUBLIC_HOST };
    const viaProxy = await controlPlane.app.inject({ url: "/api/test/whoami", headers, remoteAddress: TRUSTED_PROXY });
    expect(viaProxy.statusCode).toBe(200);
    const spoofed = await controlPlane.app.inject({ url: "/api/test/whoami", headers, remoteAddress: "192.168.10.50" });
    expect(spoofed.statusCode).toBe(421);
  });

  it("hides internal errors from the caller", async () => {
    const response = await controlPlane.client().get("/api/test/boom");
    expect(response.statusCode).toBe(500);
    expect(response.body).toBe(JSON.stringify({ error: "internal_error" }));
  });

  it("rate-limits a single address", async () => {
    const client = controlPlane.client();
    const statuses: number[] = [];
    for (let request = 0; request <= GLOBAL_RATE_LIMIT_PER_MINUTE; request += 1) {
      statuses.push((await client.get("/api/test/whoami")).statusCode);
    }
    expect(statuses.slice(0, GLOBAL_RATE_LIMIT_PER_MINUTE).every((status) => status === 200)).toBe(true);
    expect(statuses[GLOBAL_RATE_LIMIT_PER_MINUTE]).toBe(429);
    // An encoded address reaches the same route, and is refused the same.
    expect((await client.get("/%61pi/test/whoami")).statusCode).toBe(429);
    // The app's own pages are not the API: moving between them never runs into the limit.
    expect((await client.get("/hosts")).statusCode).not.toBe(429);
  });

  it("limits sign-in requests per address, even ones the login throttle never counts", async () => {
    // Malformed sign-in bodies are refused before any credential check, so they are not throttled;
    // the route's own rate limit is what stops a flood of them.
    const statuses: number[] = [];
    for (let request = 0; request < 31; request += 1) {
      const response = await controlPlane.client().post(API_ROUTES.login, { username: "admin" });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 30).every((status) => status === 400)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it("records the real client address in the audit log", async () => {
    await controlPlane.app.inject({
      method: "POST",
      url: API_ROUTES.login,
      payload: { username: "nobody", password: "whatever-password" },
      headers: { host: PUBLIC_HOST, origin: PUBLIC_ORIGIN, "x-forwarded-for": "203.0.113.9" },
      remoteAddress: TRUSTED_PROXY,
    });
    const event = controlPlane.services.databaseHandle.database.select().from(auditEvents).get();
    expect(event).toMatchObject({ action: "auth.login_failed", ip: "203.0.113.9" });
  });
});
