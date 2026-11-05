import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_ROUTES,
  apiPath,
  type ContainerView,
  type HostControlView,
  type HostView,
  type JobView,
  type SessionView,
  type StackRestartView,
  type TaskSummaryView,
} from "../../../src/shared/api.js";
import { containerUsage, hostHealth } from "../../../test/support/inventory.js";
import { stackRestartQuery } from "../components/stack-head.js";
import { timeOfDay } from "../format.js";
import { ASK_FIRST_ON, ASK_FIRST_STORAGE_KEY, PATHS, SESSION_QUERY_KEY, TEXT } from "../constants.js";
import { HostContainers, HostControl } from "./host-control.js";
import { HostUpdates } from "./host-updates.js";

// The terminal draws on a canvas jsdom lacks: in its place, what the row shows of it and its close button.
vi.mock("../components/shell-terminal.js", () => ({
  ContainerTerminal: ({ containerName, onClose }: { containerName: string; onClose: () => void }) => (
    <button type="button" onClick={onClose}>
      {`Close the shell in ${containerName}`}
    </button>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const session: SessionView = {
  user: { id: "u1", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};
const CONTROL = apiPath(API_ROUTES.hostControl, { hostId: "h1" });
const TICKS = apiPath(API_ROUTES.containerControls, { hostId: "h1" });
const RUN = apiPath(API_ROUTES.containerUpdates, { hostId: "h1" });
const STACK_RESTARTS = apiPath(API_ROUTES.stackRestarts, { hostId: "h1" });
const NO_LOCKS = { restartLock: null, updateLock: null };

const alder = (dryRun: boolean | null): HostView => ({
  id: "h1",
  label: "Alder",
  state: "online",
  tokenHint: "abcd",
  enrolledAt: Date.now(),
  lastHeartbeatAt: Date.now(),
  runnerVersion: "2.0.0",
  dryRun,
  eventStreamConnected: true,
  protectedContainers: ["autoheal"],
  restartBudget: {},
  containerAccess: null,
  health: null,
  metrics: null,
  containerCount: 4,
  runningCount: 4,
  problemCount: 0,
});

const controlView = (overrides: Partial<HostControlView> = {}): HostControlView => ({
  hostId: "h1",
  restartDefault: "ask",
  updateDefault: "ask",
  imageCleanup: "off",
  clearBuildCache: false,
  clearLeftNetworks: false,
  nextCleanupAt: null,
  timeZone: "Europe/Lisbon",
  lastCleanup: null,
  ...overrides,
});

const container = (overrides: Partial<ContainerView>): ContainerView => ({
  hostId: "h1",
  hostLabel: "Alder",
  hostState: "online",
  name: "attic",
  containerId: "0123456789ab",
  image: "ghcr.io/lmmendes/attic:2.7.0",
  state: "running",
  health: "healthy",
  startedAt: Date.now() - 3_600_000,
  finishedAt: null,
  exitCode: null,
  oomKilled: false,
  restartCount: 0,
  restartPolicy: "unless-stopped",
  composeProject: "attic",
  composeService: "attic",
  link: null,
  version: null,
  ports: null,
  hostNetwork: false,
  update: { status: "current", checkedAt: 1, policy: "ask", remote: null, reason: null },
  usage: null,
  byItself: { restart: "restart", update: "ask", ...NO_LOCKS },
  protected: false,
  handsOff: null,
  problem: null,
  ...overrides,
});

// The Alder: the attic stack, a container on its own with an update, and Autoheal's own runner.
const CONTAINERS = [
  container({}),
  container({
    name: "attic-postgres",
    image: "postgres:16-alpine",
    byItself: { restart: "restart", update: "ask", restartLock: null, updateLock: "database" },
  }),
  container({
    name: "BentoPDF",
    composeProject: "bentopdf",
    update: { status: "available", checkedAt: 1, policy: "ask", remote: null, reason: null },
    byItself: { restart: "ask", update: "ask", ...NO_LOCKS },
  }),
  container({
    name: "autoheal",
    composeProject: "autoheal-runner",
    protected: true,
    handsOff: "protected",
    byItself: { restart: "ask", update: "ask", restartLock: "protected", updateLock: "protected" },
  }),
];

const noPanels = (hostId: string) => ({
  [apiPath(API_ROUTES.hostNetworks, { hostId })]: { networks: [], lastJob: null },
  [apiPath(API_ROUTES.hostVolumes, { hostId })]: { volumes: [], lastJob: null },
});

// GET answers by path; other methods by "METHOD path". A tick is kept, as the control plane keeps it. No update run
// goes on unless a test says so.
function serve(routes: Record<string, unknown>) {
  routes[RUN] ??= null;
  routes[STACK_RESTARTS] ??= null;
  Object.assign(routes, { ...noPanels("h1"), ...routes });
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split("?")[0]!;
    const method = init?.method ?? "GET";
    if (method === "PUT" && path === TICKS) {
      const { names, ...ticks } = JSON.parse(String(init?.body)) as { names: string[] };
      routes[API_ROUTES.containers] = (routes[API_ROUTES.containers] as ContainerView[]).map((container) =>
        names.includes(container.name) ? { ...container, byItself: { ...container.byItself, ...ticks } } : container,
      );
      return new Response(null, { status: 204 });
    }
    const key = method === "GET" ? path : `${method} ${path}`;
    return new Response(JSON.stringify(key in routes ? routes[key] : []), {
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function show(element: ReactNode, currentSession: SessionView = session) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(SESSION_QUERY_KEY, currentSession);
  const router = createMemoryRouter([{ path: "/", element }]);
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return queryClient;
}

const sent = (fetch: ReturnType<typeof serve>, path: string, method: string, body: object) =>
  waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(path, expect.objectContaining({ method, body: JSON.stringify(body) })),
  );

describe("where a container's row sits", () => {
  const available = { status: "available" as const, checkedAt: 1, policy: "ask" as const, remote: null, reason: null };
  const rowNames = () =>
    screen
      .getAllByRole("row")
      .map((row) => row.querySelector("button.container-name")?.textContent ?? row.textContent?.split(" ")[0] ?? "")
      .filter((name) => name !== "");

  it("keeps each row in its place while it updates, a problem shows or its update goes, by name alone", async () => {
    const routes = {
      [API_ROUTES.containers]: [
        container({ name: "calendar", composeProject: null }),
        container({ name: "agent", composeProject: "agent", update: available }),
        container({ name: "tunnel", composeProject: null, problem: "restarting" }),
      ],
    };
    serve(routes);
    const client = show(<HostContainers host={alder(false)} admin />);
    await screen.findByRole("button", { name: "agent" });
    const before = rowNames().filter((name) => ["agent", "tunnel", "calendar"].includes(name));
    expect(before).toEqual(["agent", "calendar", "tunnel"]);

    // Mid-update: the old container is kept aside under the same Compose project. No stack appears for it.
    routes[API_ROUTES.containers] = [
      container({ name: "calendar", composeProject: null }),
      container({ name: "agent", composeProject: "agent" }),
      container({ name: "agent-autoheal-old", composeProject: "agent", state: "exited" }),
      container({ name: "tunnel", composeProject: null }),
    ];
    await client.invalidateQueries({ queryKey: ["containers"] });
    await screen.findByRole("button", { name: "agent-autoheal-old" });
    expect(document.querySelectorAll('th[scope="rowgroup"]')).toHaveLength(0);
    expect(rowNames().filter((name) => name.startsWith("agent") || name === "tunnel" || name === "calendar")).toEqual([
      "agent",
      "agent-autoheal-old",
      "calendar",
      "tunnel",
    ]);
  });
});

describe("container CPU and RAM in the host table", () => {
  it.each([true, false])("shows and refreshes each container's usage (admin: %s)", async (admin) => {
    const routes = {
      [API_ROUTES.containers]: [
        container({
          name: "beszel",
          usage: { ...containerUsage({ cpuPercent: 0.4, memoryBytes: 60 * 1024 ** 2 }), at: Date.now() },
        }),
        container({
          name: "dozzle",
          usage: {
            ...containerUsage({
              cpuPercent: 0.8,
              cpuLimitCores: 2,
              memoryBytes: 72 * 1024 ** 2,
              memoryLimitBytes: 256 * 1024 ** 2,
            }),
            at: Date.now(),
          },
        }),
      ],
    };
    serve(routes);
    const client = show(<HostContainers host={alder(false)} admin={admin} />, {
      ...session,
      user: { ...session.user, role: admin ? "admin" : "viewer" },
    });
    const first = (await screen.findByRole("button", { name: "beszel" })).closest("tr")!;
    const second = screen.getByRole("button", { name: "dozzle" }).closest("tr")!;
    const headers = screen.getAllByRole("columnheader");
    const names = headers.map((header) => header.textContent);
    const ports = names.indexOf("Ports");
    expect(names.slice(ports, ports + 4)).toEqual(["Ports", "CPU", "RAM", "If it fails"]);
    expect(within(first).getByRole("cell", { name: "0.4%" }).title).toBe("of host");
    expect(within(first).getByRole("cell", { name: "60 MB" }).title).toBe("no limit");
    expect(within(second).getByRole("cell", { name: "0.8%" }).title).toBe("2 CPU limit");
    expect(within(second).getByRole("cell", { name: "72 MB" }).title).toBe("256 MB limit");
    expect(within(first).getAllByRole("cell")).toHaveLength(headers.length);
    fireEvent.click(within(first).getByRole("button", { name: "beszel" }));
    expect(first.nextElementSibling?.querySelector("td")?.colSpan).toBe(headers.length);

    routes[API_ROUTES.containers][0] = container({
      name: "beszel",
      usage: { ...containerUsage({ cpuPercent: 1.2, memoryBytes: 80 * 1024 ** 2 }), at: Date.now() },
    });
    await client.invalidateQueries({ queryKey: ["containers"] });
    expect(await within(first).findByRole("cell", { name: "1.2%" })).toBeTruthy();
    expect(within(first).getByRole("cell", { name: "80 MB" })).toBeTruthy();
    expect(within(second).getByRole("cell", { name: "0.8%" })).toBeTruthy();
  });

  it("distinguishes zero usage from missing samples and stopped containers", async () => {
    const usage = { ...containerUsage({ cpuPercent: 0, memoryBytes: 0 }), at: Date.now() };
    serve({
      [API_ROUTES.containers]: [
        container({ name: "idle", usage }),
        container({ name: "waiting", usage: null }),
        container({ name: "stopped", state: "exited", usage }),
      ],
    });
    show(<HostContainers host={alder(false)} admin />);
    const row = (name: string) => screen.getByRole("button", { name }).closest("tr")!;
    await screen.findByRole("button", { name: "idle" });
    expect(within(row("idle")).getByRole("cell", { name: "0%" })).toBeTruthy();
    expect(within(row("idle")).getByRole("cell", { name: "0 B" })).toBeTruthy();
    for (const [name, explanation] of [
      ["waiting", TEXT.metrics.waitingForContainer],
      ["stopped", TEXT.metrics.notRunning],
    ] as const) {
      const cells = within(row(name)).getAllByTitle(explanation);
      expect(cells).toHaveLength(2);
      expect(cells.every((cell) => cell.textContent === TEXT.none)).toBe(true);
    }
  });
});

describe("what Autoheal may do on a host", () => {
  it("says when the host only watches, and saves each answer at once", async () => {
    const fetch = serve({
      [CONTROL]: controlView(),
      [`PUT ${CONTROL}`]: controlView({ restartDefault: "restart" }),
    });
    show(<HostControl host={alder(true)} admin />);

    expect(await screen.findByText(/This host's .env keeps DRY_RUN on/)).toBeTruthy();
    const dies = screen.getByRole("radiogroup", { name: "When a container dies" });
    expect((within(dies).getByRole("radio", { name: /Ask me every time/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dies).getByRole("radio", { name: /Restart it, within the guard/ }));
    await sent(fetch, CONTROL, "PUT", { restartDefault: "restart" });
    expect(await screen.findByText("Saved")).toBeTruthy();

    // The two questions are apart: a safe new image can go in while a dying container waits for a person.
    const image = screen.getByRole("radiogroup", { name: "When a new image is out" });
    fireEvent.click(within(image).getByRole("radio", { name: /Apply it if Ollama calls it safe/ }));
    await sent(fetch, CONTROL, "PUT", { updateDefault: "apply" });

    // Or neither: only being told when one dies, and never updating.
    fireEvent.click(within(dies).getByRole("radio", { name: "Only tell me" }));
    await sent(fetch, CONTROL, "PUT", { restartDefault: "tell" });
    fireEvent.click(within(image).getByRole("radio", { name: "Never update" }));
    await sent(fetch, CONTROL, "PUT", { updateDefault: "never" });
  });

  it("says when unused images go next, and what went last", async () => {
    const last = { status: "succeeded", outcome: "Removed 3 images (24 MB).", createdAt: Date.now() } as JobView;
    const inTwoDays = Date.now() + 2 * 24 * 60 * 60 * 1000;
    serve({ [CONTROL]: controlView({ imageCleanup: "weekly", nextCleanupAt: inTwoDays, lastCleanup: last }) });
    show(<HostControl host={alder(false)} admin />);

    expect(await screen.findByText(/^Next run \w+day\. Images still in use are always kept\.$/)).toBeTruthy();
    expect(screen.getByLabelText(/Also clear Docker's build cache/)).toBeTruthy();
    expect(screen.getByText(/Removed 3 images \(24 MB\)\./)).toBeTruthy();
  });

  it("lets a viewer read it and change nothing", async () => {
    serve({ [CONTROL]: controlView() });
    show(<HostControl host={alder(false)} admin={false} />);

    expect(((await screen.findByLabelText(/How often/)) as HTMLSelectElement).disabled).toBe(true);
    for (const radio of screen.getAllByRole("radio")) {
      expect((radio as HTMLInputElement).disabled).toBe(true);
    }
  });
});

describe("a host's containers and what each does", () => {
  it("lists stacks first, then the ones on their own, and says why a choice is fixed", async () => {
    serve({ [API_ROUTES.containers]: CONTAINERS });
    show(<HostContainers host={alder(false)} admin />);

    const stack = (await screen.findByRole("rowheader", { name: /^attic/ })).closest("tr")!;
    const single = screen.getByRole("rowheader", { name: "On their own" }).closest("tr")!;
    expect(stack.compareDocumentPosition(single) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("heading", { name: /^Containers/ }).textContent).toBe("Containers · 4 of 4 running");
    const database = screen.getByRole("button", { name: "attic-postgres" }).closest("tr")!;
    expect(within(database).getByText("Databases ask first")).toBeTruthy();
    const runner = screen.getByRole("button", { name: "autoheal" }).closest("tr")!;
    expect(within(runner).getByText("Protected in this host's .env")).toBeTruthy();
    expect(within(runner).queryByRole("combobox")).toBeNull();
  });

  it("says how long a running container has been up, and nothing for one that is stopped", async () => {
    const hour = 3_600_000;
    const hours = 5;
    const startedAt = Date.now() - hours * hour;
    const base = CONTAINERS[0]!;
    serve({
      [API_ROUTES.containers]: [
        { ...base, name: "up-one", state: "running", hostState: "online", startedAt },
        { ...base, name: "down-one", state: "exited", hostState: "online", startedAt },
      ],
    });
    show(<HostContainers host={alder(false)} admin />);

    const running = (await screen.findByRole("button", { name: "up-one" })).closest("tr")!;
    expect(within(running).getByRole("cell", { name: "5 hours" })).toBeTruthy();
    const stopped = screen.getByRole("button", { name: "down-one" }).closest("tr")!;
    expect(within(stopped).queryByRole("cell", { name: "5 hours" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Up for" })).toBeTruthy();
  });

  it("keeps only the container being worked on pinned in view", async () => {
    serve({ [API_ROUTES.containers]: CONTAINERS });
    show(<HostContainers host={alder(false)} admin />);
    const name = await screen.findByRole("button", { name: "attic-postgres" });
    expect(name.closest("tr")!.classList.contains("pinned")).toBe(false);

    fireEvent.click(name);

    await waitFor(() => expect(name.closest("tr")!.classList.contains("pinned")).toBe(true));
    expect(document.querySelectorAll("tr.pinned")).toHaveLength(1);
  });

  it("gives each stack how many of its containers are up, and restarts it from its header", async () => {
    const restartPath = apiPath(API_ROUTES.stackRestart, { hostId: "h1", stack: "attic" });
    const running: StackRestartView = {
      hostId: "h1",
      stack: "attic",
      names: ["attic-postgres", "attic-redis", "attic"],
      status: "running",
      current: "attic-postgres",
      done: [],
      failed: null,
      outcome: null,
      refusal: null,
    };
    const fetch = serve({
      [API_ROUTES.containers]: [
        container({}),
        container({ name: "attic-postgres", state: "exited", health: "none" }),
        container({ name: "attic-redis", health: "unhealthy" }),
      ],
      [`POST ${restartPath}`]: running,
    });
    show(<HostContainers host={alder(false)} admin />);
    const header = await screen.findByRole("rowheader", { name: /^attic/ });
    // One stopped and one running but unhealthy: only one of the three is up.
    expect(within(header).getByText("1 of 3 up")).toBeTruthy();
    fireEvent.click(within(header).getByRole("button", { name: "Restart stack attic" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(restartPath, expect.objectContaining({ method: "POST" })));
    expect(await within(header).findByText("Restarting attic-postgres, 1 of 3")).toBeTruthy();
    expect((within(header).getByRole("button", { name: "Restart stack attic" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("says where a stack's restart stopped, until that container is up again", async () => {
    const stopped: StackRestartView = {
      hostId: "h1",
      stack: "attic",
      names: ["attic-postgres", "attic"],
      status: "stopped",
      current: null,
      done: [],
      failed: "attic-postgres",
      outcome: "Could not restart attic-postgres: the container is gone.",
      refusal: null,
    };
    const down = container({ name: "attic-postgres", state: "exited", health: "none" });
    serve({ [API_ROUTES.containers]: [container({}), down], [STACK_RESTARTS]: stopped });
    show(<HostContainers host={alder(false)} admin />);
    const header = await screen.findByRole("rowheader", { name: /^attic/ });
    expect(
      await within(header).findByText(
        "Stopped at attic-postgres: Could not restart attic-postgres: the container is gone.",
      ),
    ).toBeTruthy();

    cleanup();
    serve({
      [API_ROUTES.containers]: [container({}), container({ name: "attic-postgres" })],
      [STACK_RESTARTS]: stopped,
    });
    const client = show(<HostContainers host={alder(false)} admin />);
    expect(within(await screen.findByRole("rowheader", { name: /^attic/ })).getByText("2 of 2 up")).toBeTruthy();
    await waitFor(() => expect(client.getQueryData(stackRestartQuery("h1").queryKey)).toEqual(stopped));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.queryByText(/Stopped at/)).toBeNull();
  });

  it("offers a viewer Restart stack only with a grant on every container it would restart", async () => {
    // Grants name hosts by id, which the dashboard checks is a UUID.
    const hostId = "66cc4c4e-efb1-4a02-9e0b-f9ba7c2e7b92";
    const host = { ...alder(false), id: hostId };
    const viewer: SessionView = { ...session, user: { ...session.user, role: "viewer" } };
    const routes = (scope: "container" | "stack") => ({
      [API_ROUTES.containers]: [container({ hostId }), container({ name: "attic-postgres", hostId })],
      [apiPath(API_ROUTES.containerUpdates, { hostId })]: null,
      [apiPath(API_ROUTES.stackRestarts, { hostId })]: null,
      ...noPanels(hostId),
      [API_ROUTES.accountPermissions]: {
        revision: 1,
        grants: [{ hostId, scope, resource: "attic", actions: ["lifecycle"] }],
      },
    });
    serve(routes("container"));
    show(<HostContainers host={host} admin={false} />, viewer);
    // attic is granted, so its own row offers its restart; attic-postgres is not, so the stack is not the viewer's.
    expect(await screen.findByRole("button", { name: "Restart attic" })).toBeTruthy();
    const header = screen.getByRole("rowheader", { name: /^attic/ });
    expect(within(header).queryByRole("button", { name: "Restart stack attic" })).toBeNull();

    cleanup();
    serve(routes("stack"));
    show(<HostContainers host={host} admin={false} />, viewer);
    const granted = await screen.findByRole("rowheader", { name: /^attic/ });
    expect(await within(granted).findByRole("button", { name: "Restart stack attic" })).toBeTruthy();
  });

  it("sets what one container does when it fails, or when a new image is out, as the control plane keeps it", async () => {
    const fetch = serve({ [API_ROUTES.containers]: CONTAINERS });
    show(<HostContainers host={alder(false)} admin />);

    const bento = (await screen.findByRole("combobox", { name: "If BentoPDF fails" })) as HTMLSelectElement;
    expect(bento.value).toBe("ask");
    fireEvent.change(bento, { target: { value: "restart" } });
    await sent(fetch, TICKS, "PUT", { names: ["BentoPDF"], restart: "restart" });
    await waitFor(() => expect(bento.value).toBe("restart"));

    fireEvent.change(screen.getByRole("combobox", { name: "When a new image of attic is out" }), {
      target: { value: "apply" },
    });
    await sent(fetch, TICKS, "PUT", { names: ["attic"], update: "apply" });

    fireEvent.change(bento, { target: { value: "tell" } });
    await sent(fetch, TICKS, "PUT", { names: ["BentoPDF"], restart: "tell" });
    fireEvent.change(screen.getByRole("combobox", { name: "When a new image of attic is out" }), {
      target: { value: "never" },
    });
    await sent(fetch, TICKS, "PUT", { names: ["attic"], update: "never" });
  });

  it("shows the old container an update keeps aside with nothing to choose", async () => {
    const available = { status: "available" as const, checkedAt: 1, remote: null, reason: null };
    serve({
      [API_ROUTES.containers]: [
        container({ name: "BentoPDF", composeProject: "bentopdf", update: { ...available, policy: "ask" } }),
        container({
          name: "BentoPDF-autoheal-old",
          composeProject: "bentopdf",
          state: "exited",
          update: { ...available, policy: "off" },
          byItself: { restart: "ask", update: "ask", restartLock: "parked", updateLock: "parked" },
          handsOff: "parked",
        }),
      ],
    });
    show(<HostContainers host={alder(false)} admin />);

    const parked = (await screen.findByRole("button", { name: "BentoPDF-autoheal-old" })).closest("tr")!;
    expect(within(parked).getByText("Kept aside by an update, for rolling back")).toBeTruthy();
    expect(within(parked).getByText("updates off")).toBeTruthy();
    expect(within(parked).queryByRole("combobox")).toBeNull();
  });

  it("says how many of its hourly restarts Autoheal used on a container, and warns when none are left", async () => {
    serve({ [API_ROUTES.containers]: CONTAINERS });
    show(<HostContainers host={{ ...alder(false), restartBudget: { attic: 1, BentoPDF: 2 } }} admin />);

    const attic = (await screen.findByRole("button", { name: "attic" })).closest("tr")!;
    expect(within(attic).getByText("Restarted by Autoheal 1 of 2 times this hour").className).toBe(
      "restarts-used muted",
    );
    const bento = screen.getByRole("button", { name: "BentoPDF" }).closest("tr")!;
    expect(within(bento).getByText("Restarted by Autoheal 2 of 2 times this hour").className).toBe(
      "restarts-used text-warning",
    );
    const postgres = screen.getByRole("button", { name: "attic-postgres" }).closest("tr")!;
    expect(within(postgres).queryByText(/Restarted by Autoheal/)).toBeNull();
  });

  it("says when Autoheal may act on a container again, and lets an admin reset its used-up restarts", async () => {
    const now = Date.now();
    const againAt = now + 30 * 60_000;
    const looksAgainAt = now + 4 * 60_000;
    const host: HostView = {
      ...alder(false),
      restartBudget: { attic: 1, BentoPDF: 2 },
      restartWait: {
        attic: { againAt: null, looksAgainAt },
        BentoPDF: { againAt, looksAgainAt },
        "attic-postgres": { againAt: null, looksAgainAt },
        // A wait that ended a minute ago says nothing now.
        autoheal: { againAt: null, looksAgainAt: now - 60_000 },
      },
      restartResets: {},
    };
    const resetPath = apiPath(API_ROUTES.restartsReset, { hostId: "h1", containerName: "BentoPDF" });
    const fetch = serve({ [API_ROUTES.containers]: CONTAINERS, [`POST ${resetPath}`]: null });
    show(<HostContainers host={host} admin />);
    const text = TEXT.hostContainers;
    const line = (...parts: string[]) => parts.join(TEXT.separator);

    const bento = (await screen.findByRole("button", { name: "BentoPDF" })).closest("tr")!;
    expect(within(bento).getByText(line(text.restartsUsed(2), text.againFrom(timeOfDay(againAt))))).toBeTruthy();
    const attic = screen.getByRole("button", { name: "attic" }).closest("tr")!;
    expect(within(attic).getByText(line(text.restartsUsed(1), text.looksAgain(timeOfDay(looksAgainAt))))).toBeTruthy();
    // A restart left: nothing to reset.
    expect(within(attic).queryByRole("button", { name: text.resetLabel("attic") })).toBeNull();
    const postgres = screen.getByRole("button", { name: "attic-postgres" }).closest("tr")!;
    expect(within(postgres).getByText(text.looksAgainAlone(timeOfDay(looksAgainAt)))).toBeTruthy();
    const runner = screen.getByRole("button", { name: "autoheal" }).closest("tr")!;
    expect(within(runner).queryByText(/looks at it again/)).toBeNull();

    fireEvent.click(within(bento).getByRole("button", { name: text.resetLabel("BentoPDF") }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(resetPath, expect.objectContaining({ method: "POST" })));
    expect(await within(bento).findByText(/reset: clears with its next report/)).toBeTruthy();
    expect(within(bento).queryByRole("button", { name: text.resetLabel("BentoPDF") })).toBeNull();
  });

  it("offers no Reset to a viewer, nor on a host whose runner takes none", async () => {
    const spent = { ...alder(false), restartBudget: { BentoPDF: 2 } };
    const reset = { name: TEXT.hostContainers.resetLabel("BentoPDF") };
    serve({ [API_ROUTES.containers]: CONTAINERS });
    const waits = { BentoPDF: { againAt: Date.now() + 60_000, looksAgainAt: null } };
    show(<HostContainers host={{ ...spent, restartWait: waits }} admin={false} />);
    const bento = (await screen.findByRole("button", { name: "BentoPDF" })).closest("tr")!;
    expect(within(bento).getByText(/Restarted by Autoheal 2 of 2 times this hour/)).toBeTruthy();
    expect(within(bento).queryByRole("button", reset)).toBeNull();

    cleanup();
    serve({ [API_ROUTES.containers]: CONTAINERS });
    show(<HostContainers host={{ ...spent, restartWait: null }} admin />);
    const older = (await screen.findByRole("button", { name: "BentoPDF" })).closest("tr")!;
    expect(within(older).getByText("Restarted by Autoheal 2 of 2 times this hour")).toBeTruthy();
    expect(within(older).queryByRole("button", reset)).toBeNull();
  });

  it("leads to the Updates for a container whose new image waits", async () => {
    serve({ [API_ROUTES.containers]: CONTAINERS });
    show(<HostContainers host={alder(false)} admin />);

    const bento = (await screen.findByRole("button", { name: "BentoPDF" })).closest("tr")!;
    expect(within(bento).getByRole("link", { name: "update ready" }).getAttribute("href")).toBe("#updates");
  });

  it("says why a new image cannot be applied on a host that only watches, and offers no way that fails", async () => {
    const waiting = container({
      name: "BentoPDF",
      handsOff: "dry_run",
      update: { status: "available", checkedAt: 1, policy: "ask", remote: null, reason: null },
    });
    serve({ [API_ROUTES.containers]: [waiting] });
    show(<HostContainers host={alder(true)} admin />);

    const bento = (await screen.findByRole("button", { name: "BentoPDF" })).closest("tr")!;
    expect(within(bento).getByText("update ready")).toBeTruthy();
    expect(within(bento).getByText("host only watches")).toBeTruthy();
    expect(within(bento).queryByRole("link", { name: "update ready" })).toBeNull();
    expect(within(bento).queryByRole("button", { name: "Update BentoPDF" })).toBeNull();
  });

  it("does not call images up to date in Updates when a host that only watches has a new one", async () => {
    const waiting = container({
      name: "BentoPDF",
      handsOff: "dry_run",
      update: { status: "available", checkedAt: 1, policy: "ask", remote: null, reason: null },
    });
    serve({ [API_ROUTES.containers]: [waiting] });
    // No packages reported: this is about the images card alone.
    show(<HostUpdates host={{ ...alder(true), health: {} as HostView["health"] }} admin />);

    expect(await screen.findByRole("heading", { name: "Container images" })).toBeTruthy();
    expect(
      await screen.findByText(
        "1 new image is out, but this host only watches. Set DRY_RUN=0 on it to update from here.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Every image here is up to date.")).toBeNull();
  });

  it("says a new image Autoheal applies comes shortly, unless it waits for a person: then it leads to that task", async () => {
    const available = {
      status: "available" as const,
      checkedAt: 1,
      policy: "auto" as const,
      remote: null,
      reason: null,
    };
    const held: TaskSummaryView = {
      id: "t59",
      number: 59,
      title: "Update radicale on Alder",
      status: "todo",
      priority: "low",
      source: "detector",
      assignee: { kind: "user", id: "u1", name: "admin" },
      labels: ["update"],
      hostId: "h1",
      hostLabel: "Alder",
      resource: { kind: "container", id: "radicale", label: "radicale" },
      parentId: null,
      occurrences: 1,
      checkedOut: false,
      advice: "hold",
      snoozedUntil: null,
      incidentId: null,
      createdAt: 1,
      updatedAt: 1,
      lastSeenAt: 1,
      closedAt: null,
    };
    serve({
      [API_ROUTES.containers]: [
        container({
          name: "radicale",
          update: available,
          byItself: { restart: "restart", update: "apply", ...NO_LOCKS },
        }),
        container({
          name: "whoami",
          update: { ...available, policy: "always" },
          byItself: { restart: "repair", update: "always", ...NO_LOCKS },
        }),
      ],
      [API_ROUTES.tasks]: [held],
    });
    show(<HostContainers host={alder(false)} admin />);

    const radicale = (await screen.findByRole("button", { name: "radicale" })).closest("tr")!;
    const link = await within(radicale).findByRole("link", { name: "held for you" });
    expect(link.getAttribute("href")).toBe(apiPath(PATHS.task, { taskId: "t59" }));
    const whoami = screen.getByRole("button", { name: "whoami" }).closest("tr")!;
    expect(within(whoami).getByText("updating shortly")).toBeTruthy();
  });

  it("says why a container's image could not be checked", async () => {
    serve({
      [API_ROUTES.containers]: [
        container({
          update: {
            status: "unknown",
            checkedAt: 1,
            policy: "ask",
            remote: null,
            reason: "not public on Docker Hub: private, or built on this host",
          },
        }),
      ],
    });
    show(<HostContainers host={alder(false)} admin />);

    const attic = (await screen.findByRole("button", { name: "attic" })).closest("tr")!;
    expect(within(attic).getByText("could not check")).toBeTruthy();
    expect(within(attic).getByText("not public on Docker Hub: private, or built on this host")).toBeTruthy();
  });

  it("lists every container, and finds one by its name or image", async () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      container({
        name: `app-${String(index + 1).padStart(2, "0")}`,
        composeProject: null,
        image: `example/app:${index}`,
      }),
    );
    serve({ [API_ROUTES.containers]: many });
    show(<HostContainers host={alder(false)} admin />);

    expect(await screen.findByRole("button", { name: "app-12" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^app-\d+$/ })).toHaveLength(12);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "app:11" } });
    expect(screen.getByRole("button", { name: "app-12" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "app-01" })).toBeNull();
  });

  it("acts on the ticked containers at once, each action on the ones it fits, and says how it went", async () => {
    const nightly = container({ name: "nightly", composeProject: null, state: "exited", health: "none" });
    const actionPath = (containerName: string) => apiPath(API_ROUTES.containerActions, { hostId: "h1", containerName });
    const jobOf = (id: string, containerName: string, action: JobView["action"]): JobView => ({
      id,
      hostId: "h1",
      hostLabel: "Alder",
      containerName,
      action,
      status: "succeeded",
      requestedBy: "admin",
      taskId: null,
      createdAt: 1,
      completedAt: 2,
      outcome: `${action} ${containerName}`,
      output: null,
      recoveryBackupId: null,
      packages: [],
      progress: null,
    });
    const fetch = serve({
      [API_ROUTES.containers]: [...CONTAINERS, nightly],
      [`POST ${actionPath("attic")}`]: jobOf("j1", "attic", "restart"),
      [`POST ${actionPath("nightly")}`]: jobOf("j2", "nightly", "remove"),
      [API_ROUTES.jobs]: [jobOf("j1", "attic", "restart"), jobOf("j2", "nightly", "remove")],
    });
    // Nothing asks again: a confirm would fail the test.
    vi.stubGlobal("confirm", () => {
      throw new Error("asked again");
    });
    show(<HostContainers host={alder(false)} admin />);

    const bar = await screen.findByRole("group", { name: "Act on the ticked containers" });
    expect(screen.queryByText(/Choosing Update allows/)).toBeNull();
    const hint = "Tick containers to restart, stop, update or remove several at once.";
    expect(within(bar).getByText(hint)).toBeTruthy();
    // What its host keeps to itself has no tick.
    const runner = (await screen.findByRole("button", { name: "autoheal" })).closest("tr")!;
    expect(within(runner).queryByRole("checkbox")).toBeNull();

    // The hint scrolls away with the page; the buttons stay in view.
    expect(bar.classList.contains("action-bar")).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick attic" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick nightly" }));
    expect(within(bar).getByText("2 ticked")).toBeTruthy();
    expect(bar.classList.contains("action-bar")).toBe(true);
    expect(
      within(bar)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Clear", "Restart 1", "Start 1", "Stop 1", "Pause 1", "Check for updates", "Remove 2"]);

    fireEvent.click(within(bar).getByRole("button", { name: "Restart 1" }));
    await sent(fetch, actionPath("attic"), "POST", { action: "restart" });
    expect(await within(bar).findByText("Restart: 1 of 1 done.")).toBeTruthy();
    // The running one too: its runner stops it first.
    fireEvent.click(within(bar).getByRole("button", { name: "Remove 2" }));
    await sent(fetch, actionPath("attic"), "POST", { action: "remove" });
    await sent(fetch, actionPath("nightly"), "POST", { action: "remove" });

    // Ticking all ticks every container shown that its host lets Autoheal change; again, none.
    const all = screen.getByRole("checkbox", { name: "Tick every container shown" });
    fireEvent.click(all);
    expect(within(bar).getByText("4 ticked")).toBeTruthy();
    fireEvent.click(all);
    expect(within(bar).getByText(hint)).toBeTruthy();
  });
  it("shows what each container publishes, linked on its host, and acts on one container from its own row", async () => {
    const actionPath = (containerName: string) => apiPath(API_ROUTES.containerActions, { hostId: "h1", containerName });
    const fetch = serve({
      [API_ROUTES.containers]: CONTAINERS.map((each) => {
        if (each.name === "attic") {
          return { ...each, ports: [{ published: 8080, target: 80, protocol: "tcp" as const }] };
        }
        return each.name === "BentoPDF" ? { ...each, hostNetwork: true } : each;
      }),
    });
    show(<HostContainers host={{ ...alder(false), health: hostHealth({ address: "192.168.10.178" }) }} admin />);

    const attic = (await screen.findByRole("button", { name: "attic" })).closest("tr")!;
    const port = within(attic).getByRole("link", { name: "8080" });
    expect(port.getAttribute("href")).toBe("http://192.168.10.178:8080");
    expect(port.closest("[title]")!.getAttribute("title")).toBe("8080 → 80/tcp");
    const bento = screen.getByRole("button", { name: "BentoPDF" }).closest("tr")!;
    expect(within(bento).getByText("host network")).toBeTruthy();

    // Its own buttons: a restart is one click; the ones that do not fit it, or its host keeps to itself, are off.
    fireEvent.click(within(attic).getByRole("button", { name: "Restart attic" }));
    await sent(fetch, actionPath("attic"), "POST", { action: "restart" });
    expect((within(attic).getByRole("button", { name: "Remove attic" }) as HTMLButtonElement).disabled).toBe(false);
    const runner = screen.getByRole("button", { name: "autoheal" }).closest("tr")!;
    expect((within(runner).getByRole("button", { name: "Restart autoheal" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(runner).getByRole("button", { name: "Logs autoheal" }) as HTMLButtonElement).disabled).toBe(false);

    // Its logs are read under the row, with its stats.
    fireEvent.click(within(attic).getByRole("button", { name: "Logs attic" }));
    await sent(fetch, actionPath("attic"), "POST", { action: "logs" });
    expect(within(attic).getByRole("button", { name: "Stats of attic" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("asks once before a stop or a removal where this browser is set to, from a row or for the ticked ones", async () => {
    const nightly = container({ name: "nightly", composeProject: null, state: "exited", health: "none" });
    const actionPath = (containerName: string) => apiPath(API_ROUTES.containerActions, { hostId: "h1", containerName });
    const fetch = serve({ [API_ROUTES.containers]: [...CONTAINERS, nightly] });
    const answers = [false, true, true];
    const confirm = vi.fn<(question: string) => boolean>(() => answers.shift() ?? false);
    vi.stubGlobal("confirm", confirm);
    window.localStorage.setItem(ASK_FIRST_STORAGE_KEY, ASK_FIRST_ON);
    try {
      show(<HostContainers host={alder(false)} admin />);
      const attic = (await screen.findByRole("button", { name: "attic" })).closest("tr")!;
      const stopped = expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "stop" }) });

      // A no sends nothing; a yes stops it. A restart still goes on one click.
      fireEvent.click(within(attic).getByRole("button", { name: "Stop attic" }));
      expect(confirm).toHaveBeenLastCalledWith("Stop attic?");
      expect(fetch).not.toHaveBeenCalledWith(actionPath("attic"), stopped);
      fireEvent.click(within(attic).getByRole("button", { name: "Stop attic" }));
      await sent(fetch, actionPath("attic"), "POST", { action: "stop" });
      const restart = within(attic).getByRole("button", { name: "Restart attic" }) as HTMLButtonElement;
      await waitFor(() => expect(restart.disabled).toBe(false));
      fireEvent.click(restart);
      await sent(fetch, actionPath("attic"), "POST", { action: "restart" });
      expect(confirm).toHaveBeenCalledTimes(2);

      // The ticked ones are asked about once, each by name.
      fireEvent.click(screen.getByRole("checkbox", { name: "Tick attic" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Tick nightly" }));
      const bar = screen.getByRole("group", { name: "Act on the ticked containers" });
      const remove = within(bar).getByRole("button", { name: "Remove 2" }) as HTMLButtonElement;
      await waitFor(() => expect(remove.disabled).toBe(false));
      fireEvent.click(remove);
      expect(confirm).toHaveBeenCalledTimes(3);
      expect(confirm).toHaveBeenLastCalledWith("Remove attic and nightly? Volumes are kept.");
      await sent(fetch, actionPath("attic"), "POST", { action: "remove" });
      await sent(fetch, actionPath("nightly"), "POST", { action: "remove" });
      // The no sent nothing, then or later: one stop in all.
      expect(
        fetch.mock.calls.filter(
          ([path, init]) => path === actionPath("attic") && init?.body === JSON.stringify({ action: "stop" }),
        ),
      ).toHaveLength(1);
    } finally {
      window.localStorage.removeItem(ASK_FIRST_STORAGE_KEY);
    }
  });
  it("opens a shell under a row at once, where the host allows one", async () => {
    serve({ [API_ROUTES.containers]: CONTAINERS });
    show(<HostContainers host={alder(false)} admin />);
    const attic = (await screen.findByRole("button", { name: "attic" })).closest("tr")!;
    const shellOf = (row: HTMLElement, name: string) =>
      within(row).getByRole("button", { name: `Shell in ${name}` }) as HTMLButtonElement;
    // The host's .env has not let anyone in.
    expect(shellOf(attic, "attic").disabled).toBe(true);
    expect(shellOf(attic, "attic").title).toMatch(/its \.env says CONTAINER_ACCESS=off, or its runner needs updating/);
    cleanup();

    show(<HostContainers host={{ ...alder(false), containerAccess: true }} admin />);
    const row = (name: string) => screen.getByRole("button", { name }).closest("tr")!;
    await screen.findByRole("button", { name: "attic" });
    expect(shellOf(row("autoheal"), "autoheal").disabled).toBe(true);
    fireEvent.click(shellOf(row("attic"), "attic"));

    // No code asked: the shell, until it is closed.
    fireEvent.click(await screen.findByRole("button", { name: "Close the shell in attic" }));
    expect(screen.queryByRole("button", { name: "Close the shell in attic" })).toBeNull();
    expect(shellOf(row("attic"), "attic").getAttribute("aria-pressed")).toBe("false");
  });

  it("shows what each row's job is doing, an update's pull under its row, and each kind of container apart", async () => {
    const job = (overrides: Partial<JobView>): JobView => ({
      id: "j1",
      hostId: "h1",
      hostLabel: "Alder",
      containerName: "attic",
      action: "restart",
      status: "pending",
      requestedBy: "admin",
      taskId: null,
      createdAt: Date.now(),
      completedAt: null,
      outcome: null,
      output: null,
      recoveryBackupId: null,
      packages: [],
      progress: null,
      ...overrides,
    });
    const pulling = job({
      id: "j2",
      containerName: "BentoPDF",
      action: "update",
      status: "delivered",
      progress: {
        phase: "pulling",
        layers: [
          { id: "4f4fb700ef54", state: "downloading", current: 50_000_000, total: 100_000_000 },
          { id: "1a2b3c4d5e6f", state: "present", current: 0, total: null },
        ],
        downloaded: 50_000_000,
        total: 100_000_000,
        bytesPerSecond: 10_000_000,
        log: ["4f4fb700ef54: Downloading [====>] 50MB/100MB"],
      },
    });
    serve({ [API_ROUTES.containers]: CONTAINERS, [API_ROUTES.jobs]: [pulling, job({})] });
    show(<HostContainers host={alder(false)} admin />);

    const attic = (await screen.findByRole("button", { name: "attic" })).closest("tr")!;
    expect(await within(attic).findByText("restarting…")).toBeTruthy();
    expect(attic.getAttribute("aria-busy")).toBe("true");
    const bento = screen.getByRole("button", { name: "BentoPDF" }).closest("tr")!;
    expect(within(bento).getByText("pulling 50%")).toBeTruthy();

    const stream = screen.getByRole("region", { name: "How the update of BentoPDF goes" });
    expect(within(stream).getByText("pulling the new image")).toBeTruthy();
    for (const fact of ["10 MB/s", "50 MB of 100 MB", "5 seconds left", "1 of 2 layers"]) {
      expect(within(stream).getByText(fact)).toBeTruthy();
    }
    fireEvent.click(within(stream).getByRole("button", { name: "Show details" }));
    const layers = within(stream).getAllByRole("listitem");
    expect(layers.slice(0, 2).map((layer) => layer.textContent)).toEqual([
      "4f4fb700ef54100 MBdownloading 50%",
      "1a2b3c4d5e6falready here",
    ]);
    expect(within(stream).getByText("4f4fb700ef54: Downloading [====>] 50MB/100MB")).toBeTruthy();

    // Each kind with how many it holds; one with none is not offered.
    const kinds = screen.getByRole("group", { name: "Show containers" });
    expect(
      within(kinds)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["All 4", "Running 4", "Update ready 1", "In progress 2", "Networks 0", "Volumes 0"]);
    fireEvent.click(within(kinds).getByRole("button", { name: "In progress 2" }));
    expect(screen.queryByRole("button", { name: "attic-postgres" })).toBeNull();
    expect(screen.getByRole("button", { name: "attic" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "BentoPDF" })).toBeTruthy();
  });
});

it("offers confirmed rollback recovery without a parked row and hides unsafe starts", async () => {
  const recovering = container({ name: "attic", state: "exited", recovery: { owner: "attic" } });
  const path = apiPath(API_ROUTES.containerActions, { hostId: "h1", containerName: "attic" });
  const fetch = serve({
    [API_ROUTES.containers]: [recovering],
    [`POST ${path}`]: { id: "recovery-job", status: "pending" },
    [`POST ${apiPath(API_ROUTES.operationPreview, { hostId: "h1", containerName: "attic" })}`]: {
      id: "review-rollback",
      hostId: "h1",
      containerName: "attic",
      action: "roll_back",
      expiresAt: Date.now() + 60_000,
      answer: {
        ok: true,
        fingerprint: "a".repeat(64),
        members: [{ name: "attic", protected: false }],
        resources: [],
        refusals: [],
      },
    },
  });
  vi.stubGlobal("confirm", () => true);
  show(<HostContainers host={alder(false)} admin />);
  const resume = await screen.findByRole("button", {
    name: TEXT.hostContainers.rowAction(TEXT.actions.names.roll_back, "attic"),
  });
  expect(
    screen.queryByRole("button", { name: TEXT.hostContainers.rowAction(TEXT.actions.names.start, "attic") }),
  ).toBeNull();
  expect(screen.getByText(TEXT.actions.recovery("attic"))).toBeTruthy();
  fireEvent.click(resume);
  fireEvent.click(await screen.findByRole("button", { name: "Confirm reviewed operation" }));
  await sent(fetch, path, "POST", { action: "roll_back", previewId: "review-rollback" });
});

it("opens networks and volumes in place of the list, keeps its ticks, and comes back", async () => {
  serve({
    [API_ROUTES.containers]: CONTAINERS,
    [apiPath(API_ROUTES.hostNetworks, { hostId: "h1" })]: {
      networks: [
        {
          name: "wyrmrss_default",
          driver: "bridge",
          subnet: "192.168.96.0/20",
          gateway: "192.168.96.1",
          internal: false,
          project: "wyrmrss",
          projectHere: false,
          own: false,
          members: [],
        },
      ],
      lastJob: null,
    },
  });
  show(<HostContainers host={alder(false)} admin />);
  const button = (name: string | RegExp) => screen.findByRole("button", { name });
  fireEvent.click(await screen.findByRole("checkbox", { name: "Tick attic" }));
  const find = screen.getByRole("searchbox");
  fireEvent.change(find, { target: { value: "attic" } });

  fireEvent.click(await button("Networks 1 left behind"));
  expect((await button(/^Not used/)).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("heading", { name: /^Networks/ })).toBeTruthy();
  expect((find as HTMLInputElement).value).toBe("");
  expect(find.getAttribute("placeholder")).toBe(TEXT.hostContainers.findNamePlaceholder);
  expect(screen.queryByRole("button", { name: "attic" })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: "Tick attic" })).toBeNull();
  const shows = screen.getByRole("group", { name: TEXT.hostContainers.showLabel });
  expect(within(shows).getByRole("button", { name: /^All/ }).getAttribute("aria-pressed")).toBe("false");

  fireEvent.click(await button("Volumes 0"));
  expect(screen.getByRole("heading", { name: /^Volumes/ })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: /^Networks/ })).toBeNull();

  fireEvent.click(within(shows).getByRole("button", { name: /^All/ }));
  expect(screen.getByRole("heading", { name: new RegExp(`^${TEXT.hostContainers.title}`) })).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: "Tick attic" }) as HTMLInputElement).checked).toBe(true);
});

it("shows only a delegated container terminal and closes its panel when the grant is revoked", async () => {
  const hostId = "66cc4c4e-efb1-4a02-9e0b-f9ba7c2e7b92";
  const host = { ...alder(false), id: hostId, containerAccess: true };
  const routes: Record<string, unknown> = {
    [API_ROUTES.containers]: CONTAINERS.map((item) => ({ ...item, hostId })),
    [API_ROUTES.jobs]: [],
    [apiPath(API_ROUTES.containerUpdates, { hostId })]: null,
    ...noPanels(hostId),
    [API_ROUTES.accountPermissions]: {
      revision: 1,
      grants: [{ hostId, scope: "container", resource: "attic", actions: ["terminal"] }],
    },
  };
  serve(routes);
  const client = show(<HostContainers host={host} admin={false} />, {
    ...session,
    user: { ...session.user, role: "viewer" },
  });
  fireEvent.click(await screen.findByRole("button", { name: TEXT.hostContainers.shell("attic") }));
  expect(await screen.findByRole("button", { name: "Close the shell in attic" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: TEXT.hostContainers.files("attic") })).toBeNull();
  expect(screen.queryByRole("button", { name: TEXT.hostContainers.shell("BentoPDF") })).toBeNull();
  expect(screen.queryByRole("group", { name: TEXT.hostContainers.bulk.label })).toBeNull();
  routes[API_ROUTES.accountPermissions] = { revision: 2, grants: [] };
  await client.invalidateQueries({ queryKey: ["resource-permissions"] });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Close the shell in attic" })).toBeNull());
  client.clear();
});

describe("a row's update icon", () => {
  const BOX = TEXT.hostContainers.updateBox;
  const ICON = BOX.icon("BentoPDF");
  const reviewPath = apiPath(API_ROUTES.operationPreview, { hostId: "h1", containerName: "BentoPDF" });
  const review = (answer: object) => ({
    id: "review-update",
    hostId: "h1",
    containerName: "BentoPDF",
    action: "update",
    expiresAt: Date.now() + 60_000,
    answer: { ok: true, fingerprint: "a".repeat(64), members: [], resources: [], refusals: [], ...answer },
  });
  const members = (...names: string[]) => names.map((name) => ({ name, protected: false }));

  it("shows beside the name only where there is an update, and nothing goes out before the box's Update", async () => {
    const fetch = serve({
      [API_ROUTES.containers]: CONTAINERS,
      [`POST ${reviewPath}`]: review({ members: members("BentoPDF", "attic") }),
      [`POST ${apiPath(API_ROUTES.containerUpdates, { hostId: "h1" })}`]: null,
    });
    show(<HostContainers host={alder(false)} admin />);
    const icon = await screen.findByRole("button", { name: ICON });
    expect(icon.closest(".name-cell")).toBeTruthy();
    for (const other of ["attic", "attic-postgres", "autoheal"]) {
      expect(screen.queryByRole("button", { name: BOX.icon(other) })).toBeNull();
    }

    fireEvent.click(icon);
    const box = await screen.findByRole("dialog", { name: BOX.title("BentoPDF") });
    expect(await within(box).findByText(BOX.alsoHeld("attic"))).toBeTruthy();
    const updates = apiPath(API_ROUTES.containerUpdates, { hostId: "h1" });
    expect(fetch).not.toHaveBeenCalledWith(updates, expect.objectContaining({ method: "POST" }));

    fireEvent.click(within(box).getByRole("button", { name: BOX.confirm }));
    await sent(fetch, updates, "POST", {
      names: ["BentoPDF"],
      previews: { BentoPDF: "review-update" },
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps Update off while the host checks, and says why it refuses", async () => {
    serve({
      [API_ROUTES.containers]: CONTAINERS,
      [`POST ${reviewPath}`]: review({ refusals: ["BentoPDF is kept hands-off."] }),
    });
    show(<HostContainers host={alder(false)} admin />);
    fireEvent.click(await screen.findByRole("button", { name: ICON }));
    const box = await screen.findByRole("dialog");
    const update = within(box).getByRole("button", { name: BOX.confirm }) as HTMLButtonElement;
    expect(update.disabled).toBe(true);
    expect(await within(box).findByText("BentoPDF is kept hands-off.")).toBeTruthy();
    expect(update.disabled).toBe(true);
  });

  it.each([
    ["Cancel", () => fireEvent.click(screen.getByRole("button", { name: BOX.cancel }))],
    ["Escape", () => fireEvent.keyDown(document, { key: "Escape" })],
    ["a click elsewhere", () => fireEvent.mouseDown(document.body)],
  ])("closes on %s, sending nothing", async (_how, close) => {
    const fetch = serve({
      [API_ROUTES.containers]: CONTAINERS,
      [`POST ${reviewPath}`]: review({ members: members("BentoPDF") }),
    });
    show(<HostContainers host={alder(false)} admin />);
    fireEvent.click(await screen.findByRole("button", { name: ICON }));
    await screen.findByRole("dialog");
    close();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetch).not.toHaveBeenCalledWith(
      apiPath(API_ROUTES.containerUpdates, { hostId: "h1" }),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("is not there for a container Autoheal may not touch", async () => {
    serve({
      [API_ROUTES.containers]: [
        container({
          name: "kept",
          handsOff: "protected",
          update: { status: "available", checkedAt: 1, policy: "ask", remote: null, reason: null },
        }),
      ],
    });
    show(<HostContainers host={alder(false)} admin />);
    await screen.findByRole("button", { name: "kept" });
    expect(screen.queryByRole("button", { name: BOX.icon("kept") })).toBeNull();
  });

  it("names the versions in the status column when the images say them", async () => {
    serve({
      [API_ROUTES.containers]: [
        container({
          name: "BentoPDF",
          version: "1.7.0",
          update: {
            status: "available",
            checkedAt: 1,
            policy: "ask",
            remote: { version: "1.8.0" } as never,
            reason: null,
          },
        }),
      ],
    });
    show(<HostContainers host={alder(false)} admin />);
    expect(await screen.findByRole("link", { name: "1.7.0 → 1.8.0" })).toBeTruthy();
  });
});
