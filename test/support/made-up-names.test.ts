import dns from "node:dns";
import { lookup as lookupByName } from "node:dns/promises";
import { describe, expect, it } from "vitest";
import { isMadeUp } from "./made-up-names.js";

describe("names tests make up", () => {
  it.each([
    "ha.test",
    "autoheal.example.org",
    "example.com",
    "app.example.net",
    "x.invalid",
    "nas.local",
    "wiki.example.internal",
    "my.test.",
  ])("takes %s for made up", (name) => expect(isMadeUp(name)).toBe(true));

  it.each([
    "localhost",
    "ghcr.io",
    "registry-1.docker.io",
    "contest",
    "latest.io",
    "notexample.com",
    "example.community",
  ])("leaves %s to the system", (name) => expect(isMadeUp(name)).toBe(false));

  it("answers one as not found here, whichever way it is looked up, and still finds localhost", async () => {
    const byCallback = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      dns.lookup("ha.test", (error) => resolve(error)),
    );
    expect(byCallback).toMatchObject({ code: dns.NOTFOUND, hostname: "ha.test" });
    await expect(dns.promises.lookup("ha.test", { all: true })).rejects.toMatchObject({ code: dns.NOTFOUND });
    await expect(lookupByName("ha.test")).rejects.toMatchObject({ code: dns.NOTFOUND });
    await expect(fetch("https://ha.test/api/")).rejects.toMatchObject({ cause: { code: dns.NOTFOUND } });
    expect((await dns.promises.lookup("localhost", { family: 4 })).address).toBe("127.0.0.1");
  });
});
