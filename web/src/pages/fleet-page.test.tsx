import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostHealth, hostMetrics } from "../../../test/support/inventory.js";
import {
  API_ROUTES,
  apiPath,
  type BoardView,
  type ContainerView,
  type HomeAssistantSummaryView,
  type HostView,
  type OverviewView,
  type SessionView,
  type SettingsView,
  type TaskSummaryView,
} from "../../../src/shared/api.js";
import { HOST_SECTIONS } from "../../../src/shared/constants.js";
import { PATHS, SESSION_QUERY_KEY, TEXT } from "../constants.js";
import { timeOfDay } from "../format.js";
import { FleetPage } from "./fleet-page.js";

const session: SessionView = {
  user: { id: "u1", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};

const host = (overrides: Partial<HostView> = {}): HostView => ({
  id: "h1",
  label: "Alder",
  state: "online",
  tokenHint: "abcd",
  enrolledAt: Date.now(),
  lastHeartbeatAt: Date.now(),
  runnerVersion: "2.0.0",
  dryRun: false,
  eventStreamConnected: true,
  protectedContainers: [],
  restartBudget: {},
  containerAccess: null,
  health: hostHealth({ pendingUpdates: 1 }),
  metrics: { ...hostMetrics(), at: Date.now() },
  containerCount: 16,
  runningCount: 15,
  problemCount: 0,
  ...overrides,
});

const container = (name: string, overrides: Partial<ContainerView> = {}): ContainerView => ({
  hostId: "h1",
  hostLabel: "Alder",
  hostState: "online",
  name,
  containerId: "0123456789ab",
  image: `example/${name}:latest`,
  state: "running",
  health: "none",
  startedAt: Date.now(),
  finishedAt: null,
  exitCode: null,
  oomKilled: false,
  restartCount: 0,
  restartPolicy: "unless-stopped",
  composeProject: null,
  composeService: null,
  link: null,
  version: null,
  ports: null,
  hostNetwork: false,
  update: { status: "current", checkedAt: Date.now(), policy: "ask", remote: null, reason: null },
  usage: null,
  byItself: { restart: "restart", update: "ask", restartLock: null, updateLock: null },
  protected: false,
  handsOff: null,
  problem: null,
  ...overrides,
});

const task = (id: string, overrides: Partial<TaskSummaryView> = {}): TaskSummaryView => ({
  id,
  number: 1,
  title: `Task ${id}`,
  status: "todo",
  priority: "high",
  source: "detector",
  assignee: null,
  labels: [],
  hostId: "h1",
  hostLabel: "Alder",
  resource: null,
  parentId: null,
  occurrences: 1,
  checkedOut: false,
  advice: null,
  snoozedUntil: null,
  incidentId: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  lastSeenAt: Date.now(),
  closedAt: null,
  ...overrides,
});

// One decision waits on Alder, two problems to fix there, and an image update that is not a problem.
const board: BoardView = {
  needsYou: [
    {
      kind: "incident",
      incident: {
        id: "i1",
        hostId: "h1",
        hostLabel: "Alder",
        containerName: "paperless",
        image: "paperless:2",
        trigger: "die",
        status: "awaiting_approval",
        decidedBy: "model",
        action: "restart",
        target: "paperless",
        verdict: null,
        detectedAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
    { kind: "task", task: task("t1") },
    { kind: "task", task: task("t2") },
    { kind: "task", task: task("t3", { labels: ["update"] }) },
  ],
  autoheal: [],
  noticed: [],
  done: [],
};

const settings = { runnerAddress: "https://autoheal.example:9443" } as SettingsView;

// Home Assistant as the real one reported itself on 24 October: System Monitor's figures, its network sensors off.
const home: HomeAssistantSummaryView = {
  connected: true,
  version: "2026.10.2",
  system: {
    monitored: true,
    cpuPercent: 3,
    temperatureCelsius: 46,
    loadAverage: [0.14, 0.22, 0.23],
    memoryPercent: 20.6,
    diskPercent: 5,
    memory: { usedBytes: 3311.3 * 1024 ** 2, totalBytes: 15.7 * 1024 ** 3 },
    disk: null,
    network: null,
    networkOff: true,
    bootedAt: Date.now() - 11 * 86_400_000,
    reportedAt: Date.now(),
    operatingSystem: "18.3",
    supervisor: "2026.10.3",
    updates: [{ title: "Home Assistant Core", installed: "2026.10.2", latest: "2026.10.3", releaseUrl: null }],
  },
  entities: 1319,
  unavailableEntities: 88,
  zigbee: { total: 40, unavailable: 1, lowBattery: 0, weakLink: 0 },
  safety: { total: 3, problems: 1 },
  watched: { total: 30, problems: 1 },
};
const overviewWith = (homeAssistant: HomeAssistantSummaryView | null) => ({ homeAssistant }) as OverviewView;

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function serve(routes: Record<string, unknown>, posted: Record<string, unknown> = {}) {
  const answers: Record<string, unknown> = { [API_ROUTES.session]: session, ...routes };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split("?")[0]!;
    const answer = init?.method === "POST" ? posted[path] : answers[path];
    return json(answer ?? []);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function renderFleet() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(SESSION_QUERY_KEY, session);
  const router = createMemoryRouter([{ path: PATHS.hosts, element: <FleetPage /> }], {
    initialEntries: [PATHS.hosts],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("the fleet page", () => {
  afterEach(() => {
    cleanup();
  });

  it("says a host without Docker is watched for its system alone, with no containers to count", async () => {
    serve({ [API_ROUTES.hosts]: [host({ kind: "ssh", docker: false })], [API_ROUTES.containers]: [] });
    renderFleet();
    const card = await screen.findByRole("article", { name: "Alder" });
    expect(within(card).getByText(TEXT.hosts.systemOnly)).toBeTruthy();
    expect(within(card).queryByText(/of 0 running/)).toBeNull();
  });

  it("shows each enrolled host's dials and what waits there, and leaves a revoked host out", async () => {
    serve({
      [API_ROUTES.hosts]: [host(), host({ id: "h2", label: "new-host-13601d", state: "revoked" })],
      [API_ROUTES.containers]: [
        container("quantum", {
          update: { status: "available", checkedAt: Date.now(), policy: "ask", remote: null, reason: null },
        }),
        container("radicale", {
          update: { status: "available", checkedAt: Date.now(), policy: "ask", remote: null, reason: null },
        }),
        // Its label turns updates off, so nothing waits behind it.
        container("autoheal", {
          update: { status: "available", checkedAt: Date.now(), policy: "off", remote: null, reason: null },
        }),
      ],
      [API_ROUTES.board]: board,
    });
    renderFleet();

    const card = await screen.findByRole("article", { name: "Alder" });
    expect(within(card).getByRole("img", { name: "CPU: 14.2% busy" })).toBeTruthy();
    expect(within(card).getByRole("img", { name: "Memory: 43.8% used" })).toBeTruthy();
    expect(within(card).getByText("Ubuntu 24.04 · 8 CPUs · reported 0 s ago")).toBeTruthy();
    expect(within(card).getByText("7 of 16 GB")).toBeTruthy();
    expect(within(card).getByText("eth0 · 1 Gb/s")).toBeTruthy();
    expect(within(card).getByText(TEXT.hosts.running(15, 16))).toBeTruthy();
    // Two images and the host's own package.
    expect(await within(card).findByText(TEXT.hosts.updates(3))).toBeTruthy();
    expect(await within(card).findByText(TEXT.hosts.problems(2))).toBeTruthy();
    expect(within(card).getByText(TEXT.hosts.needYou(1))).toBeTruthy();
    expect(within(card).getByRole("link", { name: "Open Alder" }).getAttribute("href")).toBe(
      apiPath(PATHS.host, { hostId: "h1" }),
    );
    expect(screen.queryByText("new-host-13601d")).toBeNull();
    expect(screen.getByText(TEXT.hosts.lede(1, 15, 16))).toBeTruthy();
  });

  it("puts Home Assistant's box beside the hosts: its dials, what it counts, and its page a click away", async () => {
    serve({
      [API_ROUTES.hosts]: [host()],
      [API_ROUTES.overview]: overviewWith(home),
      [API_ROUTES.board]: board,
    });
    renderFleet();

    const card = await screen.findByRole("article", { name: "Home Assistant" });
    expect(within(card).getByText("online")).toBeTruthy();
    expect(within(card).getByText(/^Home Assistant OS 18\.3 · Core 2026\.10\.2 · reported /u)).toBeTruthy();
    expect(within(card).getByRole("img", { name: "CPU: 3% busy" })).toBeTruthy();
    expect(within(card).getByText("load 0.14 · 46°C")).toBeTruthy();
    expect(within(card).getByRole("img", { name: "Memory: 20.6% used" })).toBeTruthy();
    expect(within(card).getByText("3.2 of 15.7 GB")).toBeTruthy();
    expect(within(card).getByRole("img", { name: "Disk: 5% used" })).toBeTruthy();
    // System Monitor ships its network sensors off: the card says where to turn them on.
    expect(within(card).getByText("off in System Monitor")).toBeTruthy();
    expect(within(card).getByText("1,319 entities")).toBeTruthy();
    expect(within(card).getByText("88 unavailable")).toBeTruthy();
    expect(within(card).getByText(TEXT.hosts.updates(1))).toBeTruthy();
    // As Attention counts it: a Zigbee device off the mesh, a safety device, a watched system.
    expect(within(card).getByText(TEXT.hosts.problems(3))).toBeTruthy();
    expect(within(card).getByRole("link", { name: "Open Home Assistant" }).getAttribute("href")).toBe(
      PATHS.homeAssistant,
    );
  });

  it("shows Home Assistant without any host, and says how to see its box without System Monitor", async () => {
    const unmonitored = { ...home, connected: false, system: { ...home.system, monitored: false, cpuPercent: null } };
    serve({
      [API_ROUTES.hosts]: [],
      [API_ROUTES.overview]: overviewWith({
        ...unmonitored,
        system: { ...unmonitored.system, memoryPercent: null, diskPercent: null, networkOff: false },
      }),
    });
    renderFleet();

    const card = await screen.findByRole("article", { name: "Home Assistant" });
    expect(within(card).getByText("offline")).toBeTruthy();
    expect(within(card).getByText(TEXT.homeAssistant.box.noMonitor)).toBeTruthy();
    expect(screen.getByText(TEXT.hosts.empty)).toBeTruthy();
  });

  it("says healing is paused, not online, on a host whose runner has lost Docker's events", async () => {
    serve({
      [API_ROUTES.hosts]: [host({ eventStreamConnected: false }), host({ id: "h2", label: "Rowan" })],
      [API_ROUTES.board]: board,
    });
    renderFleet();

    const alder = await screen.findByRole("article", { name: "Alder" });
    expect(within(alder).getByText(TEXT.hosts.healingPaused).className).toBe("badge danger");
    expect(within(alder).queryByText("online")).toBeNull();
    const rowan = screen.getByRole("article", { name: "Rowan" });
    expect(within(rowan).getByText("online").className).toBe("badge good");
  });

  it("says when a host's runner holds its automatic recovery, and until when if that ends by itself", async () => {
    const until = Date.UTC(2026, 9, 28, 14, 5);
    serve({
      [API_ROUTES.hosts]: [
        host({ recoveryHold: { reason: "no_saved_state", until } }),
        host({ id: "h2", label: "Rowan", recoveryHold: { reason: "save_failed", until: null } }),
        host({ id: "h3", label: "Mini" }),
      ],
      [API_ROUTES.board]: board,
    });
    renderFleet();

    const alder = await screen.findByRole("article", { name: "Alder" });
    const waiting = within(alder).getByText(TEXT.hosts.recoveryHeldUntil(timeOfDay(until)));
    expect(waiting.className).toBe("badge warning");
    expect(waiting.title).toBe(TEXT.hosts.recoveryHeldWhy.no_saved_state);
    const rowan = screen.getByRole("article", { name: "Rowan" });
    expect(within(rowan).getByText(TEXT.hosts.recoveryHeld).className).toBe("badge danger");
    const mini = screen.getByRole("article", { name: "Mini" });
    expect(within(mini).queryByText(TEXT.hosts.recoveryHeld)).toBeNull();
  });

  it("counts the containers stopped without a problem, and leads to them", async () => {
    serve({
      [API_ROUTES.hosts]: [host()],
      [API_ROUTES.containers]: [
        container("backup-job", { state: "exited", exitCode: 0 }),
        container("old-wiki", { state: "exited", exitCode: 137 }),
        // A crash is a problem, which an incident takes up: not something stopped on purpose.
        container("paperless", { state: "exited", exitCode: 1, problem: "crashed" }),
        container("redis"),
      ],
      [API_ROUTES.board]: { needsYou: [], autoheal: [], noticed: [], done: [] },
    });
    renderFleet();

    expect(await screen.findByText(TEXT.hosts.stopped(2, "Alder"))).toBeTruthy();
    expect(screen.getByRole("link", { name: TEXT.hosts.reviewStopped }).getAttribute("href")).toBe(
      `${apiPath(PATHS.host, { hostId: "h1" })}#${HOST_SECTIONS.containers}`,
    );
  });

  it("offers to add this machine again once its runner was revoked, in one click", async () => {
    const fetch = serve(
      {
        [API_ROUTES.hosts]: [host()],
        [API_ROUTES.localHost]: { hostId: "h9", revoked: true },
        [API_ROUTES.board]: { needsYou: [], autoheal: [], noticed: [], done: [] },
      },
      { [API_ROUTES.localHostReenroll]: host({ id: "h9", label: "Rowan" }) },
    );
    renderFleet();
    const again = await screen.findByRole("button", { name: "Add this machine again" });
    expect(
      screen.getByText(
        "This machine's runner was revoked, so Autoheal no longer watches the machine the dashboard runs on.",
      ),
    ).toBeTruthy();
    fireEvent.click(again);
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(API_ROUTES.localHostReenroll, expect.objectContaining({ method: "POST" })),
    );
  });

  it("ends the host grid with the tile that connects a new host, for admins only, and no longer a form below", async () => {
    serve({ [API_ROUTES.hosts]: [host()], [API_ROUTES.settings]: settings });
    renderFleet();
    const tile = await screen.findByRole("button", { name: TEXT.connectHost.tile });
    expect(tile.closest(".host-grid")!.lastElementChild).toBe(tile);
    expect(screen.queryByRole("heading", { name: /Add a/ })).toBeNull();
    cleanup();

    session.user.role = "viewer";
    try {
      serve({ [API_ROUTES.hosts]: [host()] });
      renderFleet();
      await screen.findByRole("heading", { name: "Alder" });
      expect(screen.queryByRole("button", { name: TEXT.connectHost.tile })).toBeNull();
    } finally {
      session.user.role = "admin";
    }
  });
});
