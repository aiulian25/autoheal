import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { containerUsage, hostHealth, hostMetrics } from "../../../test/support/inventory.js";
import {
  API_ROUTES,
  apiPath,
  type ContainerView,
  type HomeAssistantSystemView,
  type HomeAssistantView,
  type HostControlView,
  type HostPackagesView,
  type HostView,
  type SessionView,
} from "../../../src/shared/api.js";
import { PATHS, SESSION_QUERY_KEY, TEXT } from "../constants.js";
import { HomeAssistantPage } from "./home-assistant-page.js";
import { ContainersPage } from "./inventory-pages.js";
import { HostPage } from "./host-page.js";

const session: SessionView = {
  user: { id: "u1", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};

const container = (overrides: Partial<ContainerView>): ContainerView => ({
  hostId: "h1",
  hostLabel: "Alder",
  hostState: "online",
  name: "paperless",
  containerId: "0123456789ab",
  image: "ghcr.io/paperless-ngx/paperless-ngx:2.13",
  state: "running",
  health: "healthy",
  startedAt: Date.now() - 3_600_000,
  finishedAt: null,
  exitCode: null,
  oomKilled: false,
  restartCount: 0,
  restartPolicy: "unless-stopped",
  composeProject: "paperless",
  composeService: "webserver",
  link: null,
  version: null,
  source: null,
  ports: null,
  hostNetwork: false,
  update: { status: null, checkedAt: null, policy: "ask", remote: null, reason: null },
  usage: null,
  protected: false,
  byItself: { restart: "restart", update: "ask", restartLock: null, updateLock: null },
  handsOff: null,
  problem: null,
  ...overrides,
});

// The real box on 24 October: System Monitor's figures, its network sensors off, Core with an update waiting.
const box: HomeAssistantSystemView = {
  monitored: true,
  cpuPercent: 3,
  temperatureCelsius: 46,
  loadAverage: [0.14, 0.22, 0.23],
  memoryPercent: 20.6,
  diskPercent: 5,
  memory: { usedBytes: 3311.3 * 1024 ** 2, totalBytes: 15.7 * 1024 ** 3 },
  disk: { usedBytes: 22.4 * 1024 ** 3, totalBytes: 448 * 1024 ** 3 },
  network: null,
  networkOff: true,
  bootedAt: Date.now() - 11 * 86_400_000,
  reportedAt: Date.now() - 5_000,
  operatingSystem: "18.3",
  supervisor: "2026.10.3",
  updates: [
    {
      title: "Home Assistant Core",
      installed: "2026.10.2",
      latest: "2026.10.3",
      releaseUrl: "https://www.home-assistant.io/blog/2026/10/01/release-202610/",
    },
  ],
};

const homeAssistant: HomeAssistantView = {
  status: { configured: true, connected: true, version: "2026.10.2", error: null, connectedSince: Date.now() },
  system: box,
  zigbee: [
    {
      id: "z1",
      name: "Kitchen Temp",
      area: "Kitchen",
      manufacturer: "SONOFF",
      model: "SNZB-02D",
      role: "end_device",
      available: true,
      batteryPercent: 20,
      linkQuality: 108,
      lastSeen: Date.now(),
      problems: [],
    },
    {
      id: "z2",
      name: "Server-Temp",
      area: "Server Room",
      manufacturer: "SONOFF",
      model: "SNZB-02D",
      role: "end_device",
      available: false,
      batteryPercent: 15,
      linkQuality: null,
      lastSeen: Date.now() - 86_400_000,
      problems: ["unavailable", "low_battery"],
    },
  ],
  safety: [
    {
      id: "s1",
      name: "Hallway Smoke",
      area: "Hallway",
      model: "XS01-M",
      available: true,
      alarm: false,
      online: false,
      batteryLow: true,
      fault: false,
      problems: ["offline", "battery_low"],
    },
  ],
  watched: [],
  entities: 1319,
  unavailableEntities: 88,
};

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

// A host whose .env allows updates, after a check: Autoheal's security fix, and what waits for a person.
const packagesView = (overrides: Partial<HostPackagesView> = {}): HostPackagesView => ({
  hostId: "h1",
  rebootRequired: false,
  lifecycle: null,
  facts: {
    setting: "apply",
    unsupported: null,
    unattendedUpgrades: false,
    rebootPackages: [],
    kernelWaiting: "6.8.0-90-generic",
    timeZone: "Europe/Lisbon",
    recentChanges: [],
  },
  checkedAt: Date.now(),
  refreshed: true,
  refreshProblem: null,
  needsRepair: false,
  packages: [
    {
      name: "openssl",
      installed: "3.0.13-1",
      candidate: "3.0.13-2",
      security: true,
      kind: "routine",
      held: false,
      summary: "Secure Sockets Layer toolkit - cryptographic utility",
      source: "noble-security",
    },
    {
      name: "docker-ce",
      installed: "5:28.5.0",
      candidate: "5:28.5.1",
      security: false,
      kind: "container_runtime",
      held: true,
      summary: "Docker: the open-source application container engine",
      source: "Docker CE",
    },
  ],
  keptBack: [],
  removable: [],
  automatic: ["openssl"],
  unattended: [],
  forPerson: ["docker-ce"],
  running: null,
  recent: [],
  window: { securityInWindow: true, windowStart: "03:00", windowEnd: "05:00" },
  ...overrides,
});

const hostControlView: HostControlView = {
  hostId: "h1",
  restartDefault: "ask",
  updateDefault: "ask",
  imageCleanup: "off",
  clearBuildCache: false,
  clearLeftNetworks: false,
  nextCleanupAt: null,
  timeZone: "Europe/Lisbon",
  lastCleanup: null,
};

function serve(routes: Record<string, unknown>) {
  const answers: Record<string, unknown> = { [API_ROUTES.session]: session, ...routes };
  const fetch = vi.fn(async (url: string) => {
    const path = url.split("?")[0]!;
    return json(path in answers ? answers[path] : []);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

// `route` is the router's pattern, for pages that read parameters from the path.
function renderAt(path: string, element: ReactNode, route = path.split("?")[0]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(SESSION_QUERY_KEY, session);
  const router = createMemoryRouter([{ path: route, element }], { initialEntries: [path] });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("hosts, containers and Home", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    // jsdom has none: a test that watches scrolling puts one in.
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  it("lists containers with their problem, and sends the filters to the API", async () => {
    const fetch = serve({
      [API_ROUTES.containers]: [
        container({ name: "tika", state: "exited", exitCode: 1, health: "none", problem: "crashed" }),
        container({ name: "npm", protected: true }),
      ],
    });
    renderAt(`${PATHS.containers}?search=tik&problems=true`, <ContainersPage />);
    const row = (await screen.findByText("tika")).closest("tr")!;
    expect(within(row).getByText("exited · crashed").className).toBe("text-danger");
    expect(within(row).getByText("exit 1")).toBeTruthy();
    expect(within((await screen.findByText("npm")).closest("tr")!).getByText("protected")).toBeTruthy();
    const containerCall = fetch.mock.calls.map(([url]) => url).find((url) => url.startsWith(API_ROUTES.containers))!;
    expect(new URLSearchParams(containerCall.split("?")[1])).toEqual(
      new URLSearchParams({ search: "tik", problemsOnly: "true" }),
    );
  });

  it("brings a container a link opened into view, once, and not one opened by a click", async () => {
    serve({ [API_ROUTES.containers]: [container({ name: "paperless" }), container({ name: "redis" })] });
    const scrolled = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrolled;
    renderAt(`${PATHS.containers}?container=${encodeURIComponent("Alder/paperless")}`, <ContainersPage />);
    const inspector = await screen.findByRole("region", { name: "paperless" });
    expect(within(inspector).getByRole("region", { name: "Timeline" })).toBeTruthy();
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled.mock.contexts[0]).toBe(inspector);

    fireEvent.click(screen.getByRole("button", { name: "redis" }));
    expect(await screen.findByRole("region", { name: "redis" })).toBeTruthy();
    expect(scrolled).toHaveBeenCalledTimes(1);
  });

  it("keeps what is typed in the filters, and starts over when a link leads back to the page", async () => {
    serve({ [API_ROUTES.containers]: [container({ name: "tika" })] });
    const router = renderAt(`${PATHS.containers}?problems=true`, <ContainersPage />);
    const problemsOnly = (await screen.findByLabelText(/Only what needs attention/)) as HTMLInputElement;
    const search = screen.getByLabelText(TEXT.containers.search) as HTMLInputElement;
    expect(problemsOnly.checked).toBe(true);
    fireEvent.change(search, { target: { value: "tik" } });
    await waitFor(() => expect(router.state.location.search).toBe("?problems=true&search=tik"));
    expect(search.value).toBe("tik");

    await act(() => router.navigate(PATHS.containers));
    expect(problemsOnly.checked).toBe(false);
    expect(search.value).toBe("");
  });

  it("shows a host's dials and charts, and a container's own stats right under it until clicked again", async () => {
    const { name: _name, ...paperlessUsage } = containerUsage({ cpuPercent: 3.5, cpuLimitCores: 1 });
    const usage = { ...paperlessUsage, at: Date.now() };
    const metrics = { ...hostMetrics(), at: Date.now() };
    const alder: HostView = {
      id: "h1",
      label: "Alder",
      state: "online",
      tokenHint: "abcd",
      enrolledAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      runnerVersion: "2.0.0",
      dryRun: true,
      eventStreamConnected: true,
      protectedContainers: [],
      restartBudget: {},
      containerAccess: null,
      health: hostHealth(),
      metrics,
      containerCount: 2,
      runningCount: 2,
      problemCount: 0,
    };
    const fetched = serve({
      [API_ROUTES.hosts]: [alder],
      [apiPath(API_ROUTES.hostMetrics, { hostId: "h1" })]: [metrics, { ...metrics, at: Date.now() + 5_000 }],
      [API_ROUTES.containers]: [container({ name: "paperless", usage }), container({ name: "redis" })],
      [apiPath(API_ROUTES.containerMetrics, { hostId: "h1", containerName: "paperless" })]: [usage],
      [apiPath(API_ROUTES.hostPackages, { hostId: "h1" })]: packagesView(),
      [apiPath(API_ROUTES.hostControl, { hostId: "h1" })]: hostControlView,
      [apiPath(API_ROUTES.hostImages, { hostId: "h1" })]: { images: [], lastRemoval: null },
      [apiPath(API_ROUTES.hostNetworks, { hostId: "h1" })]: { networks: [], lastJob: null },
      [apiPath(API_ROUTES.hostVolumes, { hostId: "h1" })]: { volumes: [], lastJob: null },
      [apiPath(API_ROUTES.containerUpdates, { hostId: "h1" })]: null,
    });
    const scrolled = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrolled;
    renderAt(apiPath(PATHS.host, { hostId: "h1" }), <HostPage />, PATHS.host);

    expect(await screen.findByRole("img", { name: "CPU: 14.2% busy" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Memory: 43.8% used" })).toBeTruthy();
    // The charts are folded away under the dials until opened.
    expect(screen.queryByRole("img", { name: "CPU: User 9.4%, System 3.8%, I/O wait 0.8%" })).toBeNull();
    const fold = screen.getByText(TEXT.metrics.statsHistory).closest("details")!;
    fold.open = true;
    fireEvent(fold, new Event("toggle"));
    expect(await screen.findByRole("img", { name: "CPU: User 9.4%, System 3.8%, I/O wait 0.8%" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "paperless" })).toBeNull();

    const paperless = (await screen.findByRole("button", { name: "paperless" })).closest("tr")!;
    const reads = fetched.mock.calls.map(([url]) => url).filter((url) => url.split("?")[0] === API_ROUTES.containers);
    expect(reads).toEqual([`${API_ROUTES.containers}?hostId=h1`]);
    expect(within(paperless).getByRole("combobox", { name: "If paperless fails" })).toBeTruthy();
    fireEvent.click(within(paperless).getByRole("button", { name: "paperless" }));
    const inspector = await screen.findByRole("region", { name: "paperless" });
    expect(within(inspector).getByText("3.5%")).toBeTruthy();
    expect(within(inspector).getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    expect(within(paperless).getByRole("button", { name: "paperless" }).getAttribute("aria-expanded")).toBe("true");
    // In place: the panel is the very next row, above redis, and its timeline in its Overview.
    expect(paperless.nextElementSibling?.contains(inspector)).toBe(true);
    expect(within(inspector).getByRole("region", { name: "Timeline" })).toBeTruthy();
    // Opened by a click on its own row: nothing to bring into view.
    expect(scrolled).not.toHaveBeenCalled();

    fireEvent.click(within(paperless).getByRole("button", { name: "paperless" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "paperless" })).toBeNull());
  });

  it("shows the Zigbee mesh with a summary, and narrows to devices with problems", async () => {
    serve({ [API_ROUTES.homeAssistant]: homeAssistant });
    renderAt(PATHS.homeAssistant, <HomeAssistantPage />);
    expect(await screen.findByText(/2 devices: 1 unavailable, 1 with a low battery, 0 with a weak link/)).toBeTruthy();
    expect(screen.getByText("Kitchen Temp")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Only what needs attention/));
    expect(screen.queryByText("Kitchen Temp")).toBeNull();
    expect(screen.getByText("Server-Temp")).toBeTruthy();
  });

  it("shows Home Assistant's own box first: its dials, versions, what waits for it, how long it has run", async () => {
    serve({ [API_ROUTES.homeAssistant]: homeAssistant });
    renderAt(PATHS.homeAssistant, <HomeAssistantPage />);

    const box = await screen.findByRole("region", { name: "The box it runs on" });
    expect(within(box).getByRole("img", { name: "CPU: 3% busy" })).toBeTruthy();
    expect(within(box).getByRole("img", { name: "Memory: 20.6% used" })).toBeTruthy();
    expect(within(box).getByText(TEXT.homeAssistant.box.networkOffHint)).toBeTruthy();
    const factOf = (label: string) =>
      within(box)
        .getAllByText(label)
        .find((element) => element.tagName === "DT")!.nextElementSibling!.textContent;
    expect(factOf("Core")).toBe("2026.10.2");
    expect(factOf("Operating system")).toBe("Home Assistant OS 18.3");
    expect(factOf("Supervisor")).toBe("2026.10.3");
    expect(factOf("Updates waiting")).toBe("Home Assistant Core 2026.10.2 → 2026.10.3 · release notes");
    expect(within(box).getByRole("link", { name: "release notes" }).getAttribute("href")).toBe(
      "https://www.home-assistant.io/blog/2026/10/01/release-202610/",
    );
    expect(factOf("Uptime")).toBe("11 days");
    expect(factOf("CPU temperature")).toBe("46°C");
    expect(factOf("Memory")).toBe("3.2 of 15.7 GB");
    expect(factOf("Disk")).toBe("22.4 of 448 GB");
    expect(factOf("Entities")).toBe("1,319 entities · 88 unavailable");
  });

  it("reads safety devices as offline and low on battery, never as just unavailable", async () => {
    serve({ [API_ROUTES.homeAssistant]: homeAssistant });
    renderAt(PATHS.homeAssistant, <HomeAssistantPage />);
    const row = (await screen.findByText("Hallway Smoke")).closest("tr")!;
    expect(within(row).getByText("offline").className).toBe("badge danger");
    expect(within(row).getByText("battery low").className).toBe("badge warning");
    expect(within(row).getAllByText("ok")).toHaveLength(2);
  });
});
