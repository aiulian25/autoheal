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

  // What a browser sends when it opens a page; a script, style or image it loads asks for anything instead.
  const PAGE_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
  const getAccepting = (url: string, accept: string) =>
    controlPlane.app.inject({ method: "GET", url, headers: { host: PUBLIC_HOST, accept } });

  it.each(["/assets/index-gone.js", "/assets/index-gone.js?v=2", "/assets/", "/brand/gone.png"])(
    "answers a file that is not there, such as an old build's script, with a 404 rather than the page: %s",
    async (url) => {
      const response = await getAccepting(url, "*/*");
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "not_found" });
    },
  );

  it.each(["/hosts/abc", "/assets/index-gone.js", "/assets/"])(
    "opens the app for an address a browser opens as a page: %s",
    async (url) => {
      const response = await getAccepting(url, PAGE_ACCEPT);
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("<title>Autoheal</title>");
    },
  );

  it.each(["/../package.json", "/..%2f..%2fetc%2fpasswd", "/assets/..%2F..%2Fpackage.json", "/%2e%2e/package.json"])(
    "serves nothing outside the built dashboard for %s",
    async (url) => {
      const response = await get(url);
      expect(response.body).not.toContain('"dependencies"');
      expect(response.body).not.toContain("root:");
    },
  );

  it("keeps the API's own 404s and its sign-in requirement", async () => {
    expect((await get("/api/nothing-here")).json()).toEqual({ error: "not_found" });
    expect((await get("/api/hosts")).statusCode).toBe(401);
  });
});
