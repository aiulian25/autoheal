import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { expect, vi } from "vitest";
import {
  API_ROUTES,
  apiPath,
  type AgentDispatchRequest,
  type BoardView,
  type ContainerView,
  type HostView,
  type SessionView,
  type TaskSummaryView,
  type UpdateRunView,
} from "../../../src/shared/api.js";
import { PATHS, SESSION_QUERY_KEY } from "../constants.js";
import { AttentionPage } from "../pages/attention-page.js";

// The Attention page in tests: a host with updates waiting, what the dashboard answers, and dragging work to Ollama.
export const sessionFor = (role: "admin" | "viewer"): SessionView => ({
  user: { id: "u1", username: role, role, mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
});

export const alder: HostView = {
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

export const waitingImage = (name: string, overrides: Partial<ContainerView> = {}): ContainerView => ({
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
  source: null,
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
export const QUANTUM = waitingImage("quantum", {
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

export const updateTask = (name: string, advice: TaskSummaryView["advice"]): TaskSummaryView => ({
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

export const board: BoardView = {
  needsYou: [],
  autoheal: [],
  noticed: [
    { kind: "task", task: updateTask("quantum", "update") },
    { kind: "task", task: updateTask("radicale", "hold") },
  ],
  done: [],
};

export const RUNS = apiPath(API_ROUTES.containerUpdates, { hostId: "h1" });

export const handedOver = {
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

export const diskNearlyFull: TaskSummaryView = {
  ...updateTask("disk", null),
  id: "task-disk",
  title: "Alder's disk is 97% full",
  labels: [],
  resource: null,
};

// What waits for a person besides the updates: one incident Ollama handed over, and one problem.
export const needsYou: BoardView = {
  ...board,
  needsYou: [
    { kind: "incident", incident: handedOver },
    { kind: "task", task: diskNearlyFull },
  ],
};

export const started: UpdateRunView = {
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

export const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

// Two of the host's own packages wait for a person: the rules hold netdata's repository's.
export const heldPackages = {
  facts: { setting: "apply", unsupported: null },
  running: null,
  automatic: [],
  packages: ["netdata-dashboard", "netdata-user"].map((name) => ({ name, security: false })),
};
// Tika failed and waits for a person; its image is up to date.
export const TIKA = waitingImage("tika", {
  state: "exited",
  update: { status: "current", checkedAt: Date.now(), policy: "ask", remote: null, reason: null },
});

export function serve(
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
      const sent = JSON.parse(String(init.body)) as { updates: string[]; incidents: string[]; tags: object[] };
      return json({
        updates: sent.updates.length,
        packages: 0,
        incidents: sent.incidents.length,
        tags: sent.tags.length,
      });
    }
    return json(path in answers ? answers[path] : []);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

export function renderAttention(role: "admin" | "viewer") {
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

// What a browser's drag carries, as far as the page reads it.
export function dragged() {
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

// Newer versions go along as tags: none unless a test hands one over.
export const sentHandOver = (fetch: ReturnType<typeof serve>, body: Partial<AgentDispatchRequest>) =>
  waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      API_ROUTES.agentDispatch,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ ...body, tags: body.tags ?? [] }) }),
    ),
  );
