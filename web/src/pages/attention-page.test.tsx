import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_ROUTES,
  apiPath,
  type BoardView,
  type ContainerView,
  type HostView,
  type IncidentSummaryView,
  type SessionView,
  type TaskSummaryView,
  type UpdateRunView,
} from "../../../src/shared/api.js";
import { AGENT_DRAG_TYPE, PATHS, SESSION_QUERY_KEY, TEXT } from "../constants.js";
import { AttentionPage } from "./attention-page.js";

const sessionFor = (role: "admin" | "viewer"): SessionView => ({
  user: { id: "u1", username: role, role, mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
});

const alder: HostView = {
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
  health: null,
  metrics: null,
  containerCount: 2,
  runningCount: 2,
  problemCount: 0,
};

const waitingImage = (name: string, overrides: Partial<ContainerView> = {}): ContainerView => ({
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
  update: { status: "available", checkedAt: Date.now(), policy: "ask", remote: null, reason: null },
  usage: null,
  byItself: { restart: "restart", update: "ask", restartLock: null, updateLock: null },
  protected: false,
  handsOff: null,
  problem: null,
  ...overrides,
});

// Its images name their versions and where its code lives.
const QUANTUM = waitingImage("quantum", {
  version: "v1.120.1",
  update: {
    status: "available",
    checkedAt: Date.now(),
    policy: "ask",
    remote: {
      version: "v1.120.2",
      revision: null,
      source: "https://github.com/example/quantum",
      createdAt: Date.now() - 3 * 24 * 3_600_000,
    },
    reason: null,
  },
});

const updateTask = (name: string, advice: TaskSummaryView["advice"]): TaskSummaryView => ({
  id: `task-${name}`,
  number: 1,
  title: `Update ${name} on Alder`,
  status: "todo",
  priority: "low",
  source: "detector",
  assignee: { kind: "user", id: "u1", name: "admin" },
  labels: ["update"],
  hostId: "h1",
  hostLabel: "Alder",
  resource: { kind: "container", id: name, label: name },
  parentId: null,
  occurrences: 1,
  checkedOut: false,
  advice,
  snoozedUntil: null,
  incidentId: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  lastSeenAt: Date.now(),
  closedAt: null,
});

const board: BoardView = {
  needsYou: [],
  autoheal: [],
  noticed: [
    { kind: "task", task: updateTask("quantum", "update") },
    { kind: "task", task: updateTask("radicale", "hold") },
  ],
  done: [],
};

const RUNS = apiPath(API_ROUTES.containerUpdates, { hostId: "h1" });

const handedOver = {
  id: "i1",
  hostId: "h1",
  hostLabel: "Alder",
  containerName: "tika",
  image: "apache/tika:3",
  trigger: "die",
  status: "awaiting_approval",
  decidedBy: "model",
  action: "escalate",
  target: null,
  verdict: "needs you",
  detectedAt: Date.now(),
  updatedAt: Date.now(),
} as const;

const diskNearlyFull: TaskSummaryView = {
  ...updateTask("disk", null),
  id: "task-disk",
  title: "Alder's disk is 97% full",
  labels: [],
  resource: null,
};

// What waits for a person besides the updates: one incident Ollama handed over, and one problem.
const needsYou: BoardView = {
  ...board,
  needsYou: [
    { kind: "incident", incident: handedOver },
    { kind: "task", task: diskNearlyFull },
  ],
};

const started: UpdateRunView = {
  id: "run-1",
  hostId: "h1",
  names: ["quantum"],
  status: "running",
  current: "quantum",
  done: [],
  failed: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

// Two of the host's own packages wait for a person: the rules hold netdata's repository's.
const heldPackages = {
  facts: { setting: "apply", unsupported: null },
  running: null,
  automatic: [],
  packages: ["netdata-dashboard", "netdata-user"].map((name) => ({ name, security: false })),
};
// Tika failed and waits for a person; its image is up to date.
const TIKA = waitingImage("tika", {
  state: "exited",
  update: { status: "current", checkedAt: Date.now(), policy: "ask", remote: null, reason: null },
});

function serve(
  role: "admin" | "viewer",
  shown: BoardView = board,
  overview: unknown = { homeAssistant: null },
  packages: unknown = { packages: [], automatic: [] },
  more: Record<string, unknown> = {},
) {
  const answers: Record<string, unknown> = {
    [API_ROUTES.overview]: overview,
    [API_ROUTES.session]: sessionFor(role),
    [API_ROUTES.board]: shown,
    [API_ROUTES.hosts]: [alder],
    [API_ROUTES.containers]: [QUANTUM, waitingImage("radicale"), TIKA],
    [API_ROUTES.hostUpdateSettings]: { securityInWindow: true, windowStart: "03:00", windowEnd: "05:00" },
    [apiPath(API_ROUTES.hostPackages, { hostId: "h1" })]: packages,
    [API_ROUTES.ollama]: { reachable: true, model: "qwen3:30b-a3b" },
    [API_ROUTES.ollamaServers]: { extras: [], reviewServerId: null },
    [RUNS]: null,
    ...more,
  };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split("?")[0]!;
    if (init?.method === "POST" && path.endsWith("/impact")) {
      const containerName = path.split("/").at(-2)!;
      return json({
        id: `review-${containerName}`,
        hostId: "h1",
        containerName,
        action: "update",
        expiresAt: Date.now() + 60_000,
        answer: {
          ok: true,
          fingerprint: "a".repeat(64),
          members: [{ name: containerName, protected: false }],
          resources: [],
          refusals: [],
        },
      });
    }
    if (init?.method === "POST" && path === RUNS) {
      return json(started);
    }
    if (init?.method === "POST" && path === API_ROUTES.agentDispatch) {
      const sent = JSON.parse(String(init.body)) as { updates: string[]; incidents: string[] };
      return json({ updates: sent.updates.length, packages: 0, incidents: sent.incidents.length });
    }
    return json(path in answers ? answers[path] : []);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function renderAttention(role: "admin" | "viewer") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(SESSION_QUERY_KEY, sessionFor(role));
  const router = createMemoryRouter([{ path: PATHS.home, element: <AttentionPage /> }], {
    initialEntries: [PATHS.home],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("updates on the attention page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows Ollama's word on each update, and applies the ticked ones one at a time", async () => {
    const fetch = serve("admin");
    renderAttention("admin");

    const quantum = await screen.findByRole("checkbox", { name: "Update quantum" });
    const group = quantum.closest("details")!;
    const radicale = within(group).getByRole("checkbox", { name: "Update radicale" });
    expect((quantum as HTMLInputElement).checked).toBe(false);
    expect(within(quantum.closest("li")!).getByText("Ollama: safe to apply")).toBeTruthy();
    expect(within(radicale.closest("li")!).getByText("Ollama: hold it for you")).toBeTruthy();
    expect(within(group).getByText("One at a time. If one fails to come back healthy, the rest wait.")).toBeTruthy();

    fireEvent.click(quantum);
    fireEvent.click(within(group).getByRole("button", { name: "Update 1 container now" }));
    expect(fetch.mock.calls.some(([url, options]) => url === RUNS && options?.method === "POST")).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm reviewed operation" }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        RUNS,
        expect.objectContaining({
          method: "POST",
          body: '{"names":["quantum"],"previews":{"quantum":"review-quantum"}}',
        }),
      ),
    );
    expect(await within(group).findByText("Updating quantum, 1 of 1…")).toBeTruthy();
    expect(within(quantum.closest("li")!).getByText("updating now…")).toBeTruthy();
    expect((radicale as HTMLInputElement).disabled).toBe(true);
  });

  it("lists only the updates their host still has waiting: one applied by hand meanwhile is no history to nag about", async () => {
    serve(
      "admin",
      board,
      { homeAssistant: null },
      { packages: [], automatic: [] },
      {
        [API_ROUTES.containers]: [
          QUANTUM,
          waitingImage("radicale", {
            update: { status: "current", checkedAt: Date.now(), policy: "ask", remote: null, reason: null },
          }),
        ],
      },
    );
    renderAttention("admin");

    expect(await screen.findByRole("checkbox", { name: "Update quantum" })).toBeTruthy();
    expect(screen.queryByText("radicale")).toBeNull();
    expect(screen.getByRole("button", { name: "Select all (1)" })).toBeTruthy();
  });

  it("says what each update brings where its images say, and what updating does where they do not", async () => {
    serve("admin");
    renderAttention("admin");

    const quantum = (await screen.findByRole("checkbox", { name: "Update quantum" })).closest("li")!;
    expect(await within(quantum).findByText("v1.120.1 → v1.120.2")).toBeTruthy();
    expect(within(quantum).getByText("3 days ago")).toBeTruthy();
    expect(within(quantum).getByRole("link", { name: "release notes" }).getAttribute("href")).toBe(
      "https://github.com/example/quantum/releases",
    );
    const radicale = screen.getByRole("checkbox", { name: "Update radicale" }).closest("li")!;
    expect(within(radicale).getByText("Container image · recreated with its settings and volumes")).toBeTruthy();
  });

  it("lists Home Assistant's own updates with the rest, to install there", async () => {
    serve("admin", board, {
      homeAssistant: {
        connected: true,
        system: {
          updates: [
            {
              title: "Home Assistant Core",
              installed: "2026.10.2",
              latest: "2026.10.3",
              releaseUrl: "https://www.home-assistant.io/changelogs/core-2026.10/#2026103",
            },
          ],
        },
      },
    });
    renderAttention("admin");
    const group = (await screen.findByText("Install it in Home Assistant: Settings → System → Updates.")).closest(
      "details",
    )!;
    expect(group.querySelector("summary")!.textContent).toContain("1 waiting");
    expect(within(group).getByText("Home Assistant Core")).toBeTruthy();
    expect(within(group).getByText(/2026\.10\.2 → 2026\.10\.3/)).toBeTruthy();
    expect(within(group).getByRole("link", { name: "release notes" }).getAttribute("href")).toBe(
      "https://www.home-assistant.io/changelogs/core-2026.10/#2026103",
    );
    expect(within(group).queryByRole("checkbox")).toBeNull();
  });

  it("restarts a container Ollama handed over, whatever it named, and approves the dependency it chose", async () => {
    // A model that hands an incident over may still name a target; "escalate" is no choice to send back.
    const named: IncidentSummaryView = { ...handedOver, target: "tika" };
    const dependency: IncidentSummaryView = {
      ...handedOver,
      id: "i2",
      containerName: "app",
      action: "restart_dependency",
      target: "db",
    };
    const fetch = serve("admin", {
      ...board,
      needsYou: [
        { kind: "incident", incident: named },
        { kind: "incident", incident: dependency },
      ],
    });
    renderAttention("admin");
    const sent = (incidentId: string) =>
      fetch.mock.calls
        .filter(
          ([url, init]) => url === apiPath(API_ROUTES.incidentApproval, { incidentId }) && init?.method === "POST",
        )
        .map(([, init]) => init?.body);

    fireEvent.click(await screen.findByRole("button", { name: "Restart it" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve restart" }));
    await waitFor(() => expect(sent("i1")).toEqual(['{"choice":"restart"}']));
    await waitFor(() => expect(sent("i2")).toEqual(['{"choice":"restart_dependency","target":"db"}']));
  });

  it("puts a problem off for a day, and stops watching a container Ollama handed over", async () => {
    const fetch = serve("admin", needsYou);
    renderAttention("admin");
    const sent = (method: string, path: string) =>
      fetch.mock.calls.filter(([url, init]) => url === path && init?.method === method).map(([, init]) => init?.body);

    fireEvent.click(await screen.findByRole("button", { name: "Snooze a day" }));
    await waitFor(() =>
      expect(sent("PATCH", apiPath(API_ROUTES.task, { taskId: "task-disk" }))).toEqual(['{"snoozed":"day"}']),
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop watching this container" }));
    await waitFor(() =>
      expect(sent("POST", apiPath(API_ROUTES.incidentApproval, { incidentId: "i1" }))).toEqual([
        '{"choice":"dismiss"}',
      ]),
    );
    expect(sent("PUT", apiPath(API_ROUTES.containerControls, { hostId: "h1" }))).toEqual([
      '{"names":["tika"],"restart":"ignore"}',
    ]);
  });

  it("shows a viewer what waits, with nothing to tick, apply or decide", async () => {
    serve("viewer", needsYou);
    renderAttention("viewer");

    expect(await screen.findByText("Ollama: safe to apply")).toBeTruthy();
    expect(screen.getByText("Alder's disk is 97% full")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "tika" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Update quantum" })).toBeNull();
    expect(screen.queryByRole("button", { name: /containers? now$/ })).toBeNull();
    for (const action of ["Restart it", "Leave it stopped", "Stop watching this container", "Snooze a day", "Done"]) {
      expect(screen.queryByRole("button", { name: action })).toBeNull();
    }
  });
});

// What a browser's drag carries, as far as the page reads it.
function dragged() {
  const data = new Map<string, string>();
  return {
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    get types() {
      return [...data.keys()];
    },
    effectAllowed: "",
  };
}

const sentHandOver = (fetch: ReturnType<typeof serve>, body: object) =>
  waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      API_ROUTES.agentDispatch,
      expect.objectContaining({ method: "POST", body: JSON.stringify(body) }),
    ),
  );

describe("handing work to the Ollama agent", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("ticks every update its runner would take, and dispatches the ticked ones to the agent", async () => {
    const fetch = serve("admin", board, { homeAssistant: null }, heldPackages);
    renderAttention("admin");

    const all = await screen.findByRole("button", { name: "Select all (4)" });
    expect(await screen.findByRole("checkbox", { name: "Update netdata-user" })).toBeTruthy();
    expect(screen.getByText("Drag & drop active")).toBeTruthy();
    expect(screen.getByText(/to run with LLM supervision/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Dispatch to Ollama Agent" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(all);
    expect(screen.getAllByRole("checkbox").every((box) => (box as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole("button", { name: "Clear selection" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dispatch to Ollama Agent" }));
    await sentHandOver(fetch, {
      updates: ["task-quantum", "task-radicale"],
      packages: [{ hostId: "h1", names: ["netdata-dashboard", "netdata-user"] }],
      incidents: [],
    });
    expect(await screen.findByText("Handed 2 items to Ollama.")).toBeTruthy();
    expect(screen.getAllByRole("checkbox").some((box) => (box as HTMLInputElement).checked)).toBe(false);
  });

  describe("with several Ollama servers", () => {
    const withDell = (reachable: boolean) => ({
      [API_ROUTES.ollamaServers]: {
        extras: [
          {
            id: "s1",
            name: "Delta3640",
            url: "http://delta",
            model: "big:30b",
            contextTokens: 1,
            plainHttp: true,
            status: { reachable },
            hostIds: ["h1"],
          },
        ],
        reviewServerId: null,
      },
    });
    const agentCard = async () => (await screen.findByText(TEXT.attention.agent.dropTarget)).closest("a")!;

    it("shows each server and who it watches, and says where a drag goes", async () => {
      serve("admin", board, { homeAssistant: null }, heldPackages, withDell(true));
      renderAttention("admin");
      const agent = await agentCard();
      expect(await within(agent).findByText("Delta3640")).toBeTruthy();
      expect(within(agent).getByText("big:30b")).toBeTruthy();
      expect(within(agent).getByText("1 host")).toBeTruthy();
      expect(within(agent).getByText("2 of 2 answering")).toBeTruthy();
      expect(screen.getByText(TEXT.attention.agent.ready)).toBeTruthy();
      const quantum = (await screen.findByRole("checkbox", { name: "Update quantum" })).closest("li")!;
      fireEvent.dragStart(quantum, { dataTransfer: dragged() });
      expect(await within(agent).findByText("Goes to Delta3640")).toBeTruthy();
      fireEvent.dragEnd(quantum);
      expect(await within(agent).findByText(TEXT.attention.agent.dropTarget)).toBeTruthy();
    });

    it("says a drag goes to the default while its server is off, and that it is partly offline", async () => {
      serve("admin", board, { homeAssistant: null }, heldPackages, withDell(false));
      renderAttention("admin");
      const agent = await agentCard();
      expect(await within(agent).findByText("1 of 2 answering")).toBeTruthy();
      expect(
        within(agent).getByText(TEXT.attention.ollama.onDefault(TEXT.attention.ollama.defaultServer)),
      ).toBeTruthy();
      expect(await screen.findByText(TEXT.attention.agent.partlyOffline)).toBeTruthy();
      const quantum = (await screen.findByRole("checkbox", { name: "Update quantum" })).closest("li")!;
      fireEvent.dragStart(quantum, { dataTransfer: dragged() });
      expect(await within(agent).findByText("Goes to the default server")).toBeTruthy();
    });
  });

  it("shows one server just as before", async () => {
    serve("admin");
    renderAttention("admin");
    const agent = (await screen.findByText(TEXT.attention.agent.dropTarget)).closest("a")!;
    expect(within(agent).getByText("qwen3:30b-a3b")).toBeTruthy();
    expect(within(agent).getByText(TEXT.attention.ollama.answering)).toBeTruthy();
    expect(within(agent).queryByText(TEXT.attention.ollama.defaultName)).toBeNull();
  });

  it("takes what is dropped on its card: the ticked rows with the one dragged, else that one alone", async () => {
    const fetch = serve("admin", board, { homeAssistant: null }, heldPackages);
    renderAttention("admin");
    const agent = (await screen.findByText("Drop Target")).closest("a")!;
    const quantum = (await screen.findByRole("checkbox", { name: "Update quantum" })).closest("li")!;
    const user = (await screen.findByRole("checkbox", { name: "Update netdata-user" })).closest("li")!;

    const alone = dragged();
    const page = agent.closest(".page")!;
    fireEvent.dragStart(quantum, { dataTransfer: alone });
    // The agent's strip stays in sight while it drags.
    expect(page.className).toContain("dragging");
    fireEvent.dragOver(agent, { dataTransfer: alone });
    expect(agent.className).toContain("dragged-over");
    fireEvent.drop(agent, { dataTransfer: alone });
    expect(page.className).not.toContain("dragging");
    await sentHandOver(fetch, { updates: ["task-quantum"], packages: [], incidents: [] });

    fireEvent.click(screen.getByRole("checkbox", { name: "Update radicale" }));
    const together = dragged();
    fireEvent.click(screen.getByRole("checkbox", { name: "Update netdata-user" }));
    fireEvent.dragStart(user, { dataTransfer: together });
    expect(JSON.parse(together.getData(AGENT_DRAG_TYPE))).toEqual(["update:task-radicale", "package:h1:netdata-user"]);
    fireEvent.drop(agent, { dataTransfer: together });
    await sentHandOver(fetch, {
      updates: ["task-radicale"],
      packages: [{ hostId: "h1", names: ["netdata-user"] }],
      incidents: [],
    });

    // Something else dropped there is not a hand-over.
    const stranger = dragged();
    stranger.setData("text/plain", "hello");
    fireEvent.drop(agent, { dataTransfer: stranger });
    expect(fetch.mock.calls.filter(([url]) => url === API_ROUTES.agentDispatch)).toHaveLength(2);
  });

  it("opens a host's updates once one of them is ticked, so nothing ticked is out of sight", async () => {
    const rowan = { ...alder, id: "h2", label: "Rowan" };
    serve(
      "admin",
      board,
      { homeAssistant: null },
      { packages: [], automatic: [] },
      {
        [API_ROUTES.hosts]: [alder, rowan],
        [apiPath(API_ROUTES.hostPackages, { hostId: "h2" })]: heldPackages,
      },
    );
    renderAttention("admin");
    const folded = (await screen.findByText("Review")).closest("details")!;
    expect(folded.open).toBe(false);

    fireEvent.click(await screen.findByRole("button", { name: "Select all (4)" }));
    await waitFor(() => expect(folded.open).toBe(true));
  });

  it("hands an escalated incident over from its card, and offers a viewer none of it", async () => {
    const fetch = serve("admin", needsYou);
    renderAttention("admin");
    const decision = (await screen.findByText("tika")).closest("article")!;
    expect(decision.getAttribute("draggable")).toBe("true");
    fireEvent.click(within(decision).getByRole("button", { name: "Hand to Ollama" }));
    await sentHandOver(fetch, { updates: [], packages: [], incidents: ["i1"] });
    cleanup();

    serve("viewer", needsYou, { homeAssistant: null }, heldPackages);
    renderAttention("viewer");
    expect(await screen.findByText("netdata-user")).toBeTruthy();
    expect(screen.queryByText("Drop Target")).toBeNull();
    expect(screen.queryByRole("button", { name: /Dispatch to Ollama Agent|Hand to Ollama|Select all/ })).toBeNull();
    expect(screen.queryAllByRole("checkbox")).toEqual([]);
    expect(screen.queryByText("Drag & drop active")).toBeNull();
    expect(screen.getByText("Agent ready")).toBeTruthy();
  });
});
