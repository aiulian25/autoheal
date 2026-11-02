import { afterEach, describe, expect, it } from "vitest";
import {
  startTestControlPlane,
  TRUSTED_PROXY,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { API_ROUTES, type SettingsView, type TrustedProxiesView } from "../../shared/api.js";

// inject() connects from 127.0.0.1; the client a proxy would pass on:
const CLIENT = "203.0.113.9";

describe("trusted proxies", () => {
  let controlPlane: TestControlPlane;

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  const throughProxy = async (client: TestClient) =>
    (
      await client.request({ method: "GET", url: API_ROUTES.settings, headers: { "x-forwarded-for": CLIENT } })
    ).json<SettingsView>().trustedProxies;
  const save = (client: TestClient, addresses: string[]) => client.put(API_ROUTES.trustedProxies, { addresses });

  it("takes a proxy's word from the next request on once Settings trusts it, and logs each change", async () => {
    controlPlane = await startTestControlPlane({ trustedProxyAddresses: [] });
    const { client: admin } = await fullySignedInAdmin(controlPlane);
    expect(await throughProxy(admin)).toEqual({
      source: null,
      addresses: [],
      peer: "127.0.0.1",
      forwardedFor: CLIENT,
      seenAs: "127.0.0.1",
    });

    const saved = await save(admin, ["127.0.0.1", "127.0.0.1", "fd00::/16"]);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<TrustedProxiesView>()).toMatchObject({
      source: "dashboard",
      addresses: ["127.0.0.1", "fd00::/16"],
    });
    expect(await throughProxy(admin)).toMatchObject({ seenAs: CLIENT });
    expect(controlPlane.stdout.join("")).toContain('"action":"settings.trusted_proxies_saved"');
    const { trustedProxies } = controlPlane.services;
    // IPv4 written as IPv6 is the same address; a range holds every address in it.
    expect(trustedProxies.isTrusted("::ffff:127.0.0.1")).toBe(true);
    expect(trustedProxies.isTrusted("fd00:1::1")).toBe(true);
    expect(trustedProxies.isTrusted("192.168.10.50")).toBe(false);
    // X-Forwarded-For is the sender's to write: what is no address is simply not trusted.
    expect(trustedProxies.isTrusted("unknown")).toBe(false);

    // Off the list, the proxy is taken as the client again.
    await save(admin, []);
    expect(await throughProxy(admin)).toMatchObject({ source: "dashboard", addresses: [], seenAs: "127.0.0.1" });
  });

  it("refuses what is not a proxy: a name, a range too wide, too many, and anyone but an admin", async () => {
    controlPlane = await startTestControlPlane({ trustedProxyAddresses: [] });
    const { client: admin } = await fullySignedInAdmin(controlPlane);
    const tooMany = Array.from({ length: 33 }, (_, index) => `10.0.0.${index}`);
    for (const addresses of [["proxy.lan"], ["0.0.0.0/0"], ["10.0.0.0/7"], ["::/0"], ["fd00::/15"], tooMany]) {
      const refused = await save(admin, addresses);
      expect(refused.statusCode, addresses[0]).toBe(400);
      expect(refused.json()).toEqual({ error: "trusted_proxy_invalid" });
    }
    expect((await save(admin, ["10.0.0.0/8", "fd00::/16"])).statusCode).toBe(200);

    const { client: viewer } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    expect((await save(viewer, [])).statusCode).toBe(403);
    expect(controlPlane.services.trustedProxies.addresses()).toEqual(["10.0.0.0/8", "fd00::/16"]);
  });

  it("leaves the proxies the .env names to the .env", async () => {
    controlPlane = await startTestControlPlane();
    const { client: admin } = await fullySignedInAdmin(controlPlane);
    expect(await throughProxy(admin)).toMatchObject({ source: "environment", addresses: [TRUSTED_PROXY] });

    const refused = await save(admin, ["127.0.0.1"]);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: "trusted_proxies_from_environment" });
    expect(controlPlane.services.trustedProxies.addresses()).toEqual([TRUSTED_PROXY]);
  });
});
