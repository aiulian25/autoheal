import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_ROUTES,
  UNKNOWN_HOME_ASSISTANT_SYSTEM,
  apiPath,
  type BoardView,
  type HostView,
  type IncidentDetailView,
  type OllamaStatusView,
  type OverviewView,
  type SessionView,
  type TaskSummaryView,
} from "../../../src/shared/api.js";
import type { ViewPreferences } from "../../../src/shared/view-preferences.js";
import { PATHS, SEARCH_PARAMETERS, SESSION_QUERY_KEY, TEXT } from "../constants.js";
import { BoardPage } from "./board-page.js";

const session: SessionView = {
  user: { id: "u1", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};

const now = Date.now();

const escalated: IncidentDetailView = {
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
  detectedAt: now - 60_000,
  updatedAt: now - 30_000,
  diagnosis: "It keeps stopping; a person should look.",
  outcome: null,
  promptHash: null,
  modelName: "qwen3:4b-instruct",
  modelDigest: null,
  reasoning: null,
  report: null,
  trace: [
    { id: 1, kind: "reported", payload: {}, createdAt: now - 60_000 },
    { id: 2, kind: "decided", payload: {}, createdAt: now - 45_000 },
    { id: 3, kind: "outcome_reported", payload: {}, createdAt: now - 30_000 },
  ],
  approvals: [],
  earlier: [],
  evidence: [],
  usage: [],
};

const update: TaskSummaryView = {
  id: "t1",
  number: 7,
  title: "Update whoami on Alder",
  status: "in_progress",
  priority: "low",
  source: "detector",
  assignee: { kind: "agent", id: "autoheal", name: "Autoheal" },
  labels: ["update"],
  hostId: "h1",
  hostLabel: "Alder",
  resource: { kind: "container", id: "whoami", label: "whoami" },
  parentId: null,
  occurrences: 1,
  checkedOut: true,
  advice: null,
  snoozedUntil: null,
  incidentId: null,
  createdAt: now - 60_000,
  updatedAt: now - 60_000,
  lastSeenAt: now,
  closedAt: null,
};

const board: BoardView = {
  noticed: [],
  autoheal: [{ kind: "task", task: update }],
  needsYou: [{ kind: "incident", incident: escalated }],
  done: [],
};

const alder: HostView = {
  id: "h1",
  label: "Alder",
  state: "online",
  tokenHint: "abcd",
  enrolledAt: now,
  lastHeartbeatAt: now,
  runnerVersion: "2.0.0",
  dryRun: false,
  eventStreamConnected: true,
  protectedContainers: [],
  restartBudget: {},
  containerAccess: null,
  health: null,
  metrics: null,
  containerCount: 2,
  runningCount: 1,
  problemCount: 1,
};

const overview: OverviewView = {
  hosts: { total: 1, online: 1, silent: 0, neverSeen: 0 },
  containers: { total: 2, running: 1, stopped: 1, problems: 1, updates: 1 },
  tasks: { open: 1, byPriority: { urgent: 0, high: 0, medium: 0, low: 1 }, mine: 0 },
  homeAssistant: {
    connected: true,
    version: "2026.10.2",
    system: UNKNOWN_HOME_ASSISTANT_SYSTEM,
    entities: 0,
    unavailableEntities: 0,
    zigbee: { total: 2, unavailable: 1, lowBattery: 1, weakLink: 0 },
    safety: { total: 1, problems: 1 },
    watched: { total: 0, problems: 0 },
  },
};

const ollama: OllamaStatusView = {
  reachable: true,
  checkedAt: now,
  error: null,
  version: "0.12.6",
  model: "qwen3:4b-instruct",
  modelPresent: true,
  facts: null,
  models: [],
  loaded: [],
};

function serve() {
  const answers: Record<string, unknown> = {
    [API_ROUTES.session]: session,
    [API_ROUTES.board]: board,
    [API_ROUTES.hosts]: [alder],
    [API_ROUTES.overview]: overview,
    [API_ROUTES.ollama]: ollama,
    [API_ROUTES.integrations]: [
      {
        kind: "homeAssistant",
        source: "dashboard",
        url: "http://ha.local:8123",
        topic: null,
        tokenSet: true,
        plainHttp: false,
      },
    ],
    [apiPath(API_ROUTES.incident, { incidentId: escalated.id })]: escalated,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const headers = { "content-type": "application/json" };
      if (url === API_ROUTES.accountViewPreferences || url === API_ROUTES.accountBoardArrangement) {
        if (init?.method === "PUT") preferences = { views: [], board: JSON.parse(String(init.body)) };
        if (init?.method === "DELETE") preferences = { views: [], board: null };
        if (init?.method !== undefined && init.method !== "GET") boardWrites.push(init.method);
        return new Response(JSON.stringify(preferences), { headers });
      }
      return new Response(JSON.stringify(answers[url.split("?")[0]!] ?? []), { headers });
    }),
  );
}

let preferences: ViewPreferences = { views: [], board: null };
let boardWrites: string[] = [];

function renderBoard() {
  serve();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(SESSION_QUERY_KEY, session);
  const router = createMemoryRouter([{ path: PATHS.board, element: <BoardPage /> }], {
    initialEntries: [PATHS.board],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("the board", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("puts each problem in the column of who has it, and opens its steps beside the board until clicked again", async () => {
    const router = renderBoard();
    const needsYou = await screen.findByRole("region", { name: "Needs you" });
    const autoheal = screen.getByRole("region", { name: "Autoheal is on it" });
    expect(within(screen.getByRole("region", { name: "Noticed" })).getByText("Nothing new.")).toBeTruthy();
    expect(within(autoheal).getByText("Update whoami on Alder")).toBeTruthy();

    const card = within(needsYou).getByText("tika").closest("button")!;
    fireEvent.click(card);
    expect(card.getAttribute("aria-pressed")).toBe("true");
    expect(router.state.location.search).toBe(`?${SEARCH_PARAMETERS.open}=incident%3Ai1`);
    const drawer = (await screen.findByText("tika on Alder")).closest("aside")!;
    const steps = within(drawer).getByRole("list", { name: "What happened" });
    expect(within(steps).getByText("Your decision").closest("li")?.className).toBe("current");
    expect(within(drawer).getByText("It keeps stopping; a person should look.")).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "Send decision" })).toBeTruthy();

    fireEvent.click(card);
    await waitFor(() => expect(screen.queryByText("tika on Alder")).toBeNull());
    expect(router.state.location.search).toBe("");
  });

  it("shows the hosts, Home Assistant and Ollama in one strip above the columns", async () => {
    renderBoard();
    const strip = await screen.findByRole("navigation", { name: "Hosts and services" });
    await waitFor(() => expect(within(strip).getByText("3 to look at")).toBeTruthy());
    expect(within(strip).getByText("Alder").closest("a")?.getAttribute("href")).toBe("/hosts/h1");
    expect(within(strip).getByText("answering")).toBeTruthy();
  });

  describe("arranged by the person using it", () => {
    const text = TEXT.boardArrangement;
    const shownColumns = () => screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

    afterEach(() => {
      preferences = { views: [], board: null };
      boardWrites = [];
    });

    it("is the usual board, in the usual order, until someone arranges it", async () => {
      renderBoard();
      await screen.findByRole("region", { name: "Needs you" });
      expect(shownColumns().map((title) => title?.split(" ").slice(0, -1).join(" "))).toEqual([
        "Noticed",
        "Autoheal is on it",
        "Needs you",
        "Done",
      ]);
      expect(screen.queryByText(/^Hidden:/)).toBeNull();
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(boardWrites).toEqual([]);
    });

    it("shows a saved order, and says what is hidden and how much is in it", async () => {
      preferences = {
        views: [],
        board: { order: ["needsYou", "done", "noticed", "autoheal"], hidden: ["autoheal"] },
      };
      renderBoard();
      await screen.findByRole("region", { name: "Done" });
      await waitFor(() => expect(screen.queryByRole("region", { name: "Autoheal is on it" })).toBeNull());
      expect(screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual([
        "Needs you",
        "Done",
        "Noticed",
      ]);
      expect(screen.getByText("Hidden: Autoheal is on it (1)")).toBeTruthy();
    });

    it("moves and hides a column, saving each change, and resets to the usual board", async () => {
      renderBoard();
      fireEvent.click(await screen.findByRole("button", { name: text.open }));
      expect(button(text.reset).disabled).toBe(true);
      expect(button(text.up("Noticed")).disabled).toBe(true);
      expect(button(text.down("Done")).disabled).toBe(true);

      fireEvent.click(button(text.up("Needs you")));
      await waitFor(() =>
        expect(screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual([
          "Noticed",
          "Needs you",
          "Autoheal is on it",
          "Done",
        ]),
      );
      fireEvent.click(screen.getByRole("checkbox", { name: text.show("Done") }));
      await waitFor(() => expect(screen.queryByRole("region", { name: "Done" })).toBeNull());
      expect(preferences.board).toEqual({
        order: ["noticed", "needsYou", "autoheal", "done"],
        hidden: ["done"],
      });

      await waitFor(() => expect(button(text.reset).disabled).toBe(false));
      fireEvent.click(button(text.reset));
      await waitFor(() => expect(screen.getByRole("region", { name: "Done" })).toBeTruthy());
      expect(preferences.board).toBeNull();
      expect(boardWrites).toEqual(["PUT", "PUT", "DELETE"]);
    });

    it("will not hide the last column shown", async () => {
      preferences = {
        views: [],
        board: { order: ["noticed", "autoheal", "needsYou", "done"], hidden: ["noticed", "autoheal", "done"] },
      };
      renderBoard();
      fireEvent.click(await screen.findByRole("button", { name: text.open }));
      await waitFor(() =>
        expect((screen.getByRole("checkbox", { name: text.show("Needs you") }) as HTMLInputElement).disabled).toBe(
          true,
        ),
      );
    });
  });
});
