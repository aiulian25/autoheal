import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PUBLIC_HOST, startTestControlPlane, type TestControlPlane } from "../../../test/support/control-plane.js";

describe("serving the dashboard", () => {
  let controlPlane: TestControlPlane;

  beforeEach(async () => {
    const directory = mkdtempSync(join(tmpdir(), "autoheal-web-"));
    mkdirSync(join(directory, "assets"));
    writeFileSync(join(directory, "index.html"), "<!doctype html><title>Autoheal</title>");
    writeFileSync(join(directory, "assets", "index-abc123.js"), "console.log('app')");
    controlPlane = await startTestControlPlane({ webAssetsDirectory: directory });
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  const get = (url: string) => controlPlane.app.inject({ method: "GET", url, headers: { host: PUBLIC_HOST } });

  it("serves the app shell to anyone, never cached, with the strict CSP", async () => {
    const response = await get("/");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("<title>Autoheal</title>");
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
  });

  it("opens deep links, such as a notification's incident link, in the app", async () => {
    const response = await get("/incidents/6f1c9a1e-0000-4000-8000-000000000000");
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("<title>Autoheal</title>");
  });

  it("caches hashed assets forever", async () => {
    const response = await get("/assets/index-abc123.js");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("keeps the API's own 404s and its sign-in requirement", async () => {
    expect((await get("/api/nothing-here")).json()).toEqual({ error: "not_found" });
    expect((await get("/api/hosts")).statusCode).toBe(401);
  });
});
