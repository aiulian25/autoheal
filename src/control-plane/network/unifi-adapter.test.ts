import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAKE_UNIFI_CLIENTS_PATH, FAKE_UNIFI_LOGIN, FakeUnifi } from "../../../test/fakes/fake-unifi.js";
import { NETWORK_TEXT } from "../../shared/network.js";
import { RouterCertificateChanged, RouterLoginRefused } from "./router-adapter.js";
import { UNIFI_ANSWER_LIMITS, UnifiAdapter, routerCertificate } from "./unifi-adapter.js";

const WIRED_MAC = "00:00:5E:00:53:01";
const SWITCH_MAC = "00:00:5E:00:53:0A";
// Short enough to wait for here, long enough for a sign-in on this machine while every test file runs.
const SECOND_TO_ANSWER = { ...UNIFI_ANSWER_LIMITS, milliseconds: 1_000 };
const KIBIBYTE_ANSWER = { ...UNIFI_ANSWER_LIMITS, bytes: 1_024 };
const MANY_CLIENTS = 64;

describe("the UniFi adapter", () => {
  let router: FakeUnifi;
  let pin: string;
  const adapter = (overrides: { password?: string; pin?: string | null } = {}, limits = UNIFI_ANSWER_LIMITS) =>
    new UnifiAdapter({ url: router.url(), ...FAKE_UNIFI_LOGIN, pin, ...overrides }, limits);

  beforeEach(async () => {
    router = await FakeUnifi.start();
    pin = await routerCertificate(router.url());
  });

  afterEach(async () => {
    await router.close();
  });

  it("reads devices in plain facts, whichever counters a wired one reports", async () => {
    router.clients = [
      {
        mac: WIRED_MAC,
        hostname: "nas",
        network: "LAN",
        ip: "192.0.2.10",
        is_wired: true,
        sw_mac: SWITCH_MAC,
        sw_port: 4,
        rx_bytes: 1,
        tx_bytes: 2,
        "wired-rx_bytes": 300,
        "wired-tx_bytes": 400,
      },
      { nonsense: true },
    ];
    expect(await adapter().clients()).toEqual([
      {
        mac: WIRED_MAC.toLowerCase(),
        name: "nas",
        network: "LAN",
        ip: "192.0.2.10",
        wired: true,
        uplinkMac: SWITCH_MAC.toLowerCase(),
        uplinkPort: 4,
        signal: null,
        band: null,
        received: 300,
        sent: 400,
      },
    ]);
  });

  it("names a nameless client by its address, reads its band, and tells a switch from the router", async () => {
    router.clients = [{ mac: WIRED_MAC, name: "", hostname: "", radio: "na", signal: -50 }];
    router.devices = [
      { mac: SWITCH_MAC, type: "usw", model: "USW" },
      { mac: "00:00:5E:00:53:0B", type: "udr", model: "UDR7" },
    ];
    const reader = adapter();
    expect((await reader.clients())[0]).toMatchObject({ name: WIRED_MAC, band: "5" });
    expect((await reader.devices()).map(({ kind }) => kind)).toEqual(["switch", "router"]);
  });

  it("says what the router calls itself and the version it runs, when trying every read", async () => {
    router.devices = [
      { mac: SWITCH_MAC, type: "usw", name: "Switch", version: "7.1" },
      { mac: "00:00:5E:00:53:0B", type: "udr", name: "Gateway", version: "1.2.3" },
    ];
    expect(await adapter().capabilities()).toMatchObject({ name: "Gateway", version: "1.2.3" });
  });

  it("refuses every write but signing in and a speed test, before it reaches the router", async () => {
    const send = adapter() as unknown as { send(method: string, path: string, body?: object): Promise<unknown> };
    await expect(send.send("POST", "/proxy/network/api/s/default/rest/firewallrule", {})).rejects.toThrow(/only reads/);
    await expect(send.send("POST", "/proxy/network/api/s/default/cmd/devmgr", { cmd: "restart" })).rejects.toThrow(
      /only reads/,
    );
    expect(router.requests).toEqual([]);
  });

  it("reads a router's certificate without asking it anything or sending a login", async () => {
    expect(pin).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
    expect(await routerCertificate(router.url())).toBe(pin);
    expect(router.requests).toEqual([]);
  });

  it("says so when there is nothing to read a certificate from", async () => {
    const { url } = { url: router.url() };
    await router.close();
    await expect(routerCertificate(url)).rejects.toThrow();
    router = await FakeUnifi.start();
  });

  it("signs in to the certificate it was told to trust", async () => {
    await adapter().clients();
    expect(router.loginCount()).toBe(1);
  });

  it.each([
    ["with no certificate approved", null],
    ["showing another certificate", "AA:BB"],
  ])("sends no password to a router %s, nor anything else", async (_what, other) => {
    await expect(adapter({ pin: other }).clients()).rejects.toBeInstanceOf(RouterCertificateChanged);
    expect(router.requests).toEqual([]);
  });

  it("signs in once more when a session ends", async () => {
    const reader = adapter();
    await reader.clients();
    router.endSessions();
    await reader.clients();
    expect(router.loginCount()).toBe(2);
  });

  it("stops at a refused login, as failures may lock the account", async () => {
    await expect(adapter({ password: "wrong" }).clients()).rejects.toBeInstanceOf(RouterLoginRefused);
    expect(router.loginCount()).toBe(1);
  });

  it("says it cannot read the rules when this user may not", async () => {
    router.rules = null;
    router.forwards = null;
    expect(await adapter().exposure()).toBeNull();
  });

  it("reads the internet line, its speed test and what is waiting to update", async () => {
    router.health = [
      { subsystem: "wan", status: "ok", wan_ip: "198.51.100.7", "rx_bytes-r": 125_000, "tx_bytes-r": 0 },
      { subsystem: "wan2", status: "error" },
      { subsystem: "www", latency: 9, xput_down: 900, xput_up: 50, speedtest_lastrun: 1_000, speedtest_ping: 7 },
    ];
    router.devices = [{ mac: SWITCH_MAC, model: "USW", upgradable: true, upgrade_to_firmware: "7.1" }];
    const reader = adapter();
    expect(await reader.internet()).toEqual({
      lines: [
        { wan: "WAN", up: true, latency: 9 },
        { wan: "WAN2", up: false, latency: null },
      ],
      publicAddress: "198.51.100.7",
      busyMbps: 1,
      lastTest: { at: 1_000_000, downMbps: 900, upMbps: 50, ping: 7 },
    });
    expect((await reader.devices())[0]?.upgradeTo).toBe("7.1");
  });

  it("lets go of an answer still coming once its time is up", async () => {
    const reader = adapter({}, SECOND_TO_ANSWER);
    await reader.devices();
    router.trickled.add(FAKE_UNIFI_CLIENTS_PATH);
    await expect(reader.clients()).rejects.toThrow(NETWORK_TEXT.routerTooSlow);
    await vi.waitFor(() => expect(router.openAnswers()).toBe(0));
  });

  it("stops reading an answer larger than it keeps", async () => {
    router.clients = Array.from({ length: MANY_CLIENTS }, (_, index) => ({
      mac: `00:00:5E:00:53:${index.toString(16).padStart(2, "0")}`,
      hostname: "a-device",
    }));
    await expect(adapter({}, KIBIBYTE_ANSWER).clients()).rejects.toThrow(NETWORK_TEXT.routerAnswerTooLarge);
  });

  it("stops what it is still asking when told to, and asks afresh after", async () => {
    router.trickled.add(FAKE_UNIFI_CLIENTS_PATH);
    const reader = adapter();
    const reading = reader.clients();
    await vi.waitFor(() => expect(router.openAnswers()).toBe(1));
    reader.cancel();
    await expect(reading).rejects.toThrow(NETWORK_TEXT.routerReadStopped);
    await vi.waitFor(() => expect(router.openAnswers()).toBe(0));
    router.trickled.clear();
    expect(await reader.clients()).toEqual([]);
  });

  it("takes a refused speed test as a no", async () => {
    const reader = adapter();
    await reader.clients();
    expect(await reader.startSpeedTest()).toBe(true);
    router.speedTestStatus = 403;
    expect(await reader.startSpeedTest()).toBe(false);
    // The router's own trouble is no answer either way.
    router.speedTestStatus = 502;
    await expect(reader.startSpeedTest()).rejects.toThrow("The router answered 502");
  });
});
