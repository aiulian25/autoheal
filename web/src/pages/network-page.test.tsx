import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_ERRORS, API_ROUTES } from "../../../src/shared/api.js";
import { CHECK_RESULT, type NetworkMapView, type NetworkOverviewView } from "../../../src/shared/network.js";
import { TEXT } from "../constants.js";
import { NetworkMap } from "./network-map.js";
import { NetworkPage } from "./network-page.js";
import { RouterCard } from "./router-card.js";

const text = TEXT.network;
const NAS = "00:00:5e:00:53:01";
const PHONE = "00:00:5e:00:53:02";
const OVERVIEW: NetworkOverviewView = {
  connected: true,
  problem: null,
  watchedSince: 1,
  internet: { upPercent: 99.5, outages: 2, downMinutes: 41 },
  contract: { contract: { downMbps: 900, upMbps: 50 }, fair: 10, downMet: 7, upMet: 9 },
  newDevices: 1,
  oftenDropping: ["Camera"],
  unusual: [],
  exposureWaiting: true,
  updates: ["Gateway"],
  top: [{ name: "NAS", bytes: 5_000_000, unusual: true }],
  toLookAt: 3,
  learning: false,
};
const DEVICE = {
  mac: NAS,
  name: "NAS",
  network: "LAN",
  ip: "192.0.2.10",
  wired: true,
  uplink: "Switch",
  uplinkPort: 4,
  signal: null,
  online: true,
  firstSeen: 1,
  lastSeen: 2,
  known: false,
  muted: false,
  privateAddress: false,
  periodBytes: 5_000_000,
  usualBytes: null,
  unusual: false,
  drops: 6,
  oftenDrops: true,
  linkMbps: 1_000,
  bestLinkMbps: 1_000,
};
const FIREWALL = {
  rules: [],
  forwards: [{ name: "ssh", detail: "22 to 192.0.2.9:22", isNew: true }],
  blocked7Days: null,
  crossing: [],
  checks: [
    { key: "rules", result: CHECK_RESULT.failed },
    { key: "logs", result: CHECK_RESULT.notTested },
    { key: "separation", result: CHECK_RESULT.notTested },
    { key: "outside", result: CHECK_RESULT.notTested },
  ],
  logLastAt: null,
  logRefusedSender: null,
  logIgnored: null,
  logNameUnresolved: false,
  exposureReadable: true,
};
const MAP: NetworkMapView = {
  infrastructure: [
    { id: "gw", name: "Gateway", kind: "router", uplink: null },
    { id: "sw", name: "Switch", kind: "switch", uplink: "Gateway" },
  ],
  devices: [
    {
      id: NAS,
      name: "NAS",
      network: "LAN",
      ip: "192.0.2.10",
      wired: true,
      uplink: "Switch",
      uplinkPort: 4,
      signal: null,
      band: null,
      online: true,
    },
    {
      id: PHONE,
      name: "A phone with a very long name",
      network: "Home",
      ip: null,
      wired: false,
      uplink: "Gateway",
      uplinkPort: null,
      signal: -80,
      band: "5",
      online: true,
    },
  ],
  talks: [{ from: NAS, to: "outside", lines: 4, blocked: true, firstTime: false }],
  flowsAvailable: false,
};

let sent: { method: string; url: string; body: unknown }[];
const FINGERPRINT = Array.from({ length: 32 }, () => "AB").join(":");
let routerConfigured: boolean;
let certificateChanges = false;
let internetRun: { status: string; error: string | null };

beforeEach(() => {
  sent = [];
  routerConfigured = false;
  internetRun = { status: "idle", error: null };
  const answers: Record<string, unknown> = {
    [API_ROUTES.network]: OVERVIEW,
    [`${API_ROUTES.networkDevices}?period=day`]: [DEVICE],
    [`${API_ROUTES.networkDevices}/${encodeURIComponent(NAS)}`]: {
      device: DEVICE,
      dropTimes: [1],
      talks: [],
      run: { status: "idle", text: null, error: null, server: null },
    },
    [API_ROUTES.networkFirewall]: FIREWALL,
    [API_ROUTES.networkMap]: MAP,
    [API_ROUTES.networkReports]: [],
    [API_ROUTES.networkInternet]: {
      outages: [],
      tests: [
        { at: 1, downMbps: 400, upMbps: 40, ping: 9, fair: false, source: "router" },
        { at: 2, downMbps: 880, upMbps: 48, ping: 9, fair: true, source: "router" },
        { at: 3, downMbps: 701, upMbps: 45, ping: null, fair: true, source: "this_machine" },
      ],
      contract: { downMbps: 900, upMbps: 50 },
      lines: [{ wan: "WAN", up: true, latency: 5 }],
      publicAddress: null,
      speedTestRefused: false,
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") sent.push({ method, url, body: JSON.parse(String(init?.body ?? "null")) });
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
      if (url === API_ROUTES.routerSettings && method === "GET") {
        return json({
          configured: routerConfigured,
          kind: routerConfigured ? "unifi" : null,
          url: routerConfigured ? "https://192.0.2.1" : null,
          username: routerConfigured ? "read" : null,
          certificate: null,
          contract: null,
          logPort: null,
          ollamaServerId: null,
        });
      }
      if (url === API_ROUTES.networkInternet) {
        return json({ ...(answers[url] as object), run: internetRun });
      }
      if (url === API_ROUTES.routerCertificate) {
        return json({ url: "https://192.0.2.1", fingerprint: FINGERPRINT });
      }
      if (url === API_ROUTES.routerProbe) {
        if (certificateChanges) {
          certificateChanges = false;
          return new Response(JSON.stringify({ error: API_ERRORS.routerCertificateChanged }), {
            status: 409,
            headers: { "content-type": "application/json" },
          });
        }
        return json({
          name: "Gateway",
          version: "1.2.3",
          capabilities: [
            { capability: "clients", works: true, detail: "12" },
            { capability: "exposure", works: false, detail: "refused" },
          ],
        });
      }
      return method === "GET" ? json(answers[url] ?? {}) : new Response(null, { status: 204 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const shown = (page: ReactNode) =>
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        {page}
      </QueryClientProvider>
    </MemoryRouter>,
  );
const openTab = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("the network page", () => {
  it("answers six questions at the top, each a click from its detail", async () => {
    shown(<NetworkPage />);
    expect(await screen.findByText("99.50%")).toBeTruthy();
    expect(screen.getByText("7 of 10")).toBeTruthy();
    expect(screen.getByText("Camera")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(text.stats.firewallLine) }));
    expect(await screen.findByText(text.firewall.evidence)).toBeTruthy();
  });

  it("says when it cannot read the router, and where to look", async () => {
    const fetched = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) =>
      url === API_ROUTES.network
        ? new Response(JSON.stringify({ ...OVERVIEW, problem: "the password was refused" }), {
            headers: { "content-type": "application/json" },
          })
        : fetched(url, init),
    );
    shown(<NetworkPage />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(text.checkConnection)).toBeTruthy();
  });

  it("opens a device in place, and says it cannot block one", async () => {
    shown(<NetworkPage />);
    openTab(text.tabs.devices);
    fireEvent.click(await screen.findByRole("button", { name: "NAS" }));
    expect(await screen.findByText(text.device.notMine)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: text.device.known }));
    await waitFor(() => expect(sent[0]?.body).toEqual({ known: true }));
  });

  it("does not count a test on a busy line, and draws the contract to measure against", async () => {
    const { container } = shown(<NetworkPage />);
    openTab(text.tabs.internet);
    await screen.findByText(text.internet.speedTitle);
    expect(container.querySelectorAll(".speed-bar")).toHaveLength(3);
    expect(container.querySelectorAll(".speed-bar.unfair")).toHaveLength(1);
    expect(container.querySelectorAll(".speed-bar.own")).toHaveLength(1);
    expect(screen.getByText(text.internet.contractLine(900))).toBeTruthy();
  });

  it("says who sent log lines that were not read, and when the router's name could not be looked up", async () => {
    const fetched = vi.mocked(fetch).getMockImplementation()!;
    const firewall = { ...FIREWALL, logRefusedSender: "192.0.2.77", logNameUnresolved: true, logLastAt: Date.now() };
    vi.mocked(fetch).mockImplementation(async (url, init) =>
      url === API_ROUTES.networkFirewall
        ? new Response(JSON.stringify(firewall), { status: 200, headers: { "content-type": "application/json" } })
        : fetched(url, init),
    );
    shown(<NetworkPage />);
    openTab(text.tabs.firewall);
    expect(await screen.findByText(text.firewall.logsRefused("192.0.2.77"))).toBeTruthy();
    expect(screen.getByText(text.firewall.logsNameUnresolved)).toBeTruthy();
    expect(screen.getByText(new RegExp(text.firewall.logsLast))).toBeTruthy();
  });

  it("counts lines other addresses sent while the router's arrive, and says how far its lines can be trusted", async () => {
    const fetched = vi.mocked(fetch).getMockImplementation()!;
    const ignored = { sender: "192.0.2.78", at: Date.now(), lines: 12 };
    const firewall = { ...FIREWALL, logLastAt: Date.now(), logIgnored: ignored };
    vi.mocked(fetch).mockImplementation(async (url, init) =>
      url === API_ROUTES.networkFirewall
        ? new Response(JSON.stringify(firewall), { status: 200, headers: { "content-type": "application/json" } })
        : fetched(url, init),
    );
    shown(<NetworkPage />);
    openTab(text.tabs.firewall);
    expect(await screen.findByText(text.firewall.logsTrust)).toBeTruthy();
    expect(screen.getByText(new RegExp(text.firewall.logsIgnored(12, "192.0.2.78")))).toBeTruthy();
  });

  it("claims nothing of the firewall beyond what was checked", async () => {
    shown(<NetworkPage />);
    openTab(text.tabs.firewall);
    expect(await screen.findByText(text.firewall.checks.separation.not_tested)).toBeTruthy();
    expect(screen.getByText(text.firewall.checks.outside.not_tested)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: text.firewall.iMadeThis }));
    await waitFor(() => expect(sent[0]?.url).toBe(API_ROUTES.networkFirewallConfirm));
  });
});

describe("the speed test", () => {
  it("runs when asked, and says who measured it", async () => {
    shown(<NetworkPage />);
    openTab(text.tabs.internet);
    expect(await screen.findByText(text.internet.latest(701, 45, null))).toBeTruthy();
    expect(screen.getByText(text.internet.byThisMachine)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: text.internet.run }));
    await waitFor(() => expect(sent[0]?.url).toBe(API_ROUTES.networkSpeedTest));
  });

  it("will not start a second while one runs, and says so", async () => {
    internetRun = { status: "running", error: null };
    shown(<NetworkPage />);
    openTab(text.tabs.internet);
    expect(await screen.findByText(text.internet.running)).toBeTruthy();
    expect((screen.getByRole("button", { name: text.internet.run }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says when it could not finish", async () => {
    internetRun = { status: "failed", error: "no answer" };
    shown(<NetworkPage />);
    openTab(text.tabs.internet);
    expect(await screen.findByText(text.internet.runFailed("no answer"))).toBeTruthy();
  });
});

describe("the map", () => {
  const showMap = () => shown(<NetworkMap view={MAP} />);

  it("draws cable and Wi-Fi apart, with signal under what is on Wi-Fi", () => {
    const { container } = showMap();
    expect(container.querySelectorAll(".net-link.wired")).toHaveLength(3);
    expect(container.querySelectorAll(".net-link.wifi")).toHaveLength(1);
    expect(screen.getByText(text.map.signal(-80, "5")).getAttribute("class")).toContain("weak");
    expect(screen.getByText(text.map.port(4))).toBeTruthy();
    expect(screen.getByText("A phone with a…")).toBeTruthy();
  });

  it("keeps traffic out of the way until a device is pointed at, and lights its way out", () => {
    const { container } = showMap();
    expect(container.querySelectorAll(".net-talk")).toHaveLength(0);
    fireEvent.pointerEnter(screen.getByRole("button", { name: /^NAS/ }));
    expect(container.querySelectorAll(".net-talk.blocked")).toHaveLength(1);
    expect(container.querySelectorAll(".net-link.lit")).toHaveLength(3);
  });

  it("says who a chosen device talks to, and what it cannot see", () => {
    showMap();
    fireEvent.click(screen.getByRole("button", { name: /^NAS/ }));
    expect(screen.getByRole("status").textContent).toContain(text.map.lines(4, true));
    expect(screen.getByText(text.map.limit)).toBeTruthy();
    expect(screen.getByText(text.map.noFlows)).toBeTruthy();
  });

  it("zooms and comes back", () => {
    const { container } = showMap();
    const frame = () => container.querySelector("svg")!.getAttribute("viewBox");
    const whole = frame();
    fireEvent.click(screen.getByRole("button", { name: text.map.zoomIn }));
    expect(frame()).not.toBe(whole);
    fireEvent.click(screen.getByRole("button", { name: text.map.fit }));
    expect(frame()).toBe(whole);
  });
});

describe("the router's card", () => {
  const fillAndTry = async () => {
    fireEvent.change(await screen.findByLabelText(text.connection.address), {
      target: { value: "https://192.0.2.1" },
    });
    fireEvent.change(screen.getByLabelText(new RegExp(text.connection.username)), { target: { value: "read" } });
    fireEvent.change(screen.getByLabelText(text.connection.password), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: text.connection.test }));
  };

  it("shows the certificate in full first, and sends the password only once it is trusted", async () => {
    shown(<RouterCard />);
    await fillAndTry();
    expect(await screen.findByText(FINGERPRINT)).toBeTruthy();
    expect(sent.map(({ url }) => url)).toEqual([API_ROUTES.routerCertificate]);
    expect(JSON.stringify(sent)).not.toContain("secret");

    fireEvent.click(screen.getByRole("button", { name: text.connection.trustConfirm }));
    expect(await screen.findByText(new RegExp(`${text.connection.capabilities.clients}: 12`))).toBeTruthy();
    expect(screen.getByText("Asked Gateway, version 1.2.3")).toBeTruthy();
    expect(sent[1]).toMatchObject({
      url: API_ROUTES.routerProbe,
      body: { username: "read", password: "secret", trustedCertificate: FINGERPRINT },
    });
  });

  it("sends nothing if it is not trusted", async () => {
    shown(<RouterCard />);
    await fillAndTry();
    fireEvent.click(await screen.findByRole("button", { name: text.connection.trustCancel }));
    expect(screen.queryByText(FINGERPRINT)).toBeNull();
    expect(sent.map(({ url }) => url)).toEqual([API_ROUTES.routerCertificate]);
  });

  it("warns when a known router's certificate has changed, and goes on only if told to", async () => {
    routerConfigured = true;
    certificateChanges = true;
    shown(<RouterCard />);
    fireEvent.click(await screen.findByRole("button", { name: text.connection.change }));
    fireEvent.click(await screen.findByRole("button", { name: text.connection.test }));

    expect(await screen.findByText(text.connection.trustChanged("https://192.0.2.1"))).toBeTruthy();
    expect(sent.map(({ url }) => url)).toEqual([API_ROUTES.routerProbe, API_ROUTES.routerCertificate]);
    fireEvent.click(screen.getByRole("button", { name: text.connection.trustConfirm }));
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2]).toMatchObject({ url: API_ROUTES.routerProbe, body: { trustedCertificate: FINGERPRINT } });
  });

  it("once connected shows no form, and leaves the password out", async () => {
    routerConfigured = true;
    shown(<RouterCard />);
    expect(await screen.findByText(text.connection.connected)).toBeTruthy();
    expect(screen.queryByLabelText(text.connection.password)).toBeNull();
  });
});
