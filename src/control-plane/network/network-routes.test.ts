import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAKE_UNIFI_LOGIN, FakeUnifi } from "../../../test/fakes/fake-unifi.js";
import { FakeOllama } from "../../../test/fakes/fake-ollama.js";
import { startTestControlPlane, type TestClient, type TestControlPlane } from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { API_ERRORS, API_ROUTES } from "../../shared/api.js";
import { ROUTER_KIND, type RouterCertificateView, type RouterSettingsView } from "../../shared/network.js";
import { settings } from "../database/schema.js";

describe("the router's settings and the network's pages", () => {
  let ollama: FakeOllama;
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let router: FakeUnifi;
  const body = (overrides: object = {}) => ({
    kind: ROUTER_KIND.unifi,
    url: router.url(),
    ...FAKE_UNIFI_LOGIN,
    ...overrides,
  });
  const certificateOf = async (url: string) =>
    (await admin.post(API_ROUTES.routerCertificate, { url })).json<RouterCertificateView>();
  // As a person does: looks at the certificate, then approves that one.
  const approved = async (overrides: object = {}) =>
    body({ trustedCertificate: (await certificateOf(router.url())).fingerprint, ...overrides });
  const storedText = () => JSON.stringify(controlPlane.services.databaseHandle.database.select().from(settings).all());

  beforeEach(async () => {
    ollama = await FakeOllama.start();
    router = await FakeUnifi.start();
    controlPlane = await startTestControlPlane({ ollamaUrl: ollama.url() });
    admin = (await fullySignedInAdmin(controlPlane)).client;
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
    await router.close();
    await ollama.close();
  });

  it("keeps it all from viewers", async () => {
    const { client: viewer } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    for (const route of [
      API_ROUTES.routerSettings,
      API_ROUTES.network,
      API_ROUTES.networkDevices,
      API_ROUTES.networkInternet,
      API_ROUTES.networkInternetReport,
      API_ROUTES.networkFirewall,
      API_ROUTES.networkMap,
      API_ROUTES.networkReports,
    ]) {
      expect((await viewer.get(route)).statusCode, route).toBe(403);
    }
    expect((await viewer.put(API_ROUTES.routerSettings, body())).statusCode).toBe(403);
    expect((await viewer.post(API_ROUTES.routerCertificate, { url: router.url() })).statusCode).toBe(403);
  });

  it("stores a router only once it signs in, with its password sealed and never given back", async () => {
    const refused = await admin.put(API_ROUTES.routerSettings, await approved({ password: "wrong" }));
    expect(refused.json<{ error: string }>().error).toBe(API_ERRORS.routerLoginRefused);
    expect((await admin.get(API_ROUTES.routerSettings)).json<RouterSettingsView>().configured).toBe(false);

    expect((await admin.put(API_ROUTES.routerSettings, await approved())).statusCode).toBe(204);
    const answer = await admin.get(API_ROUTES.routerSettings);
    expect(answer.json<RouterSettingsView>()).toMatchObject({ configured: true, url: router.url() });
    expect(answer.body).not.toContain(FAKE_UNIFI_LOGIN.password);
    expect(storedText()).not.toContain(FAKE_UNIFI_LOGIN.password);
  });

  it("keeps the password through a change, but never sends it to another address", async () => {
    await admin.put(API_ROUTES.routerSettings, await approved());
    const { password: _kept, ...withoutPassword } = body();
    expect((await admin.put(API_ROUTES.routerSettings, withoutPassword)).statusCode).toBe(204);
    const other = await FakeUnifi.start();
    const moved = await admin.put(API_ROUTES.routerSettings, {
      ...withoutPassword,
      url: other.url(),
      trustedCertificate: (await certificateOf(other.url())).fingerprint,
    });
    expect(moved.json<{ error: string }>().error).toBe(API_ERRORS.routerLoginRefused);
    expect(other.requests).toEqual([]);
    await other.close();
  });

  describe("trusting a certificate before any login is sent", () => {
    const logins = () => router.requests.filter(({ path }) => path.includes("login"));

    it("shows a certificate in full, asking the router nothing", async () => {
      const shown = await certificateOf(router.url());
      expect(shown).toMatchObject({ url: router.url() });
      expect(shown.fingerprint).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
      expect(router.requests).toEqual([]);
    });

    it.each([
      ["save", () => admin.put(API_ROUTES.routerSettings, body())],
      ["try", () => admin.post(API_ROUTES.routerProbe, body())],
    ])("will not %s a new router until its certificate is approved, and sends it nothing", async (_what, go) => {
      const answer = await go();
      expect(answer.json<{ error: string }>().error).toBe(API_ERRORS.routerCertificateUnconfirmed);
      expect(router.requests).toEqual([]);
      expect((await admin.get(API_ROUTES.routerSettings)).json<RouterSettingsView>().configured).toBe(false);
    });

    it("sends nothing to a router showing other than what was approved", async () => {
      const wrong = "AB:".repeat(31) + "AB";
      for (const answer of [
        await admin.put(API_ROUTES.routerSettings, body({ trustedCertificate: wrong })),
        await admin.post(API_ROUTES.routerProbe, body({ trustedCertificate: wrong })),
      ]) {
        expect(answer.json<{ error: string }>().error).toBe(API_ERRORS.routerCertificateChanged);
      }
      expect(router.requests).toEqual([]);
    });

    it("refuses a malformed approval", async () => {
      const answer = await admin.put(API_ROUTES.routerSettings, body({ trustedCertificate: "yes" }));
      expect(answer.statusCode).toBe(400);
      expect(router.requests).toEqual([]);
    });

    it("signs in to the approved one, holds it from then on, and remembers it", async () => {
      const { fingerprint } = await certificateOf(router.url());
      expect((await admin.put(API_ROUTES.routerSettings, await approved())).statusCode).toBe(204);
      expect(logins().length).toBeGreaterThan(0);
      const view = (await admin.get(API_ROUTES.routerSettings)).json<RouterSettingsView>();
      expect(view.certificate).toBe(fingerprint.slice(0, 11));
      // A plain change at the same address needs no new approval.
      expect((await admin.put(API_ROUTES.routerSettings, body())).statusCode).toBe(204);
    });

    it("does not carry an approval to another address", async () => {
      const other = await FakeUnifi.start("untrusted-");
      const { fingerprint } = await certificateOf(router.url());
      const answer = await admin.put(
        API_ROUTES.routerSettings,
        body({ url: other.url(), trustedCertificate: fingerprint }),
      );
      expect(answer.json<{ error: string }>().error).toBe(API_ERRORS.routerCertificateChanged);
      expect(other.requests).toEqual([]);
      await other.close();
    });

    it("refuses a saved router's changed certificate until the new one is approved", async () => {
      await admin.put(API_ROUTES.routerSettings, await approved());
      const before = (await certificateOf(router.url())).fingerprint;
      const { url } = body();
      const port = router.port();
      await router.close();
      router = await FakeUnifi.start("untrusted-", port);

      const changed = await admin.put(API_ROUTES.routerSettings, { ...body(), url });
      expect(changed.json<{ error: string }>().error).toBe(API_ERRORS.routerCertificateChanged);
      expect(router.requests).toEqual([]);

      const shown = await certificateOf(url);
      expect(shown.fingerprint).not.toBe(before);
      expect(router.requests).toEqual([]);
      const accepted = await admin.put(API_ROUTES.routerSettings, {
        ...body(),
        url,
        trustedCertificate: shown.fingerprint,
      });
      expect(accepted.statusCode).toBe(204);
    });

    it("says when there is no router to read a certificate from", async () => {
      const answer = await admin.post(API_ROUTES.routerCertificate, { url: "https://127.0.0.1:1" });
      expect(answer.json<{ error: string }>().error).toBe(API_ERRORS.routerUnreachable);
    });
  });

  it("removes it, and the page says nothing is there", async () => {
    await admin.put(API_ROUTES.routerSettings, await approved());
    expect((await admin.delete(API_ROUTES.routerSettings)).statusCode).toBe(204);
    expect((await admin.get(API_ROUTES.routerSettings)).json<RouterSettingsView>().configured).toBe(false);
  });
});
