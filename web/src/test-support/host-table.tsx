import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { expect, vi } from "vitest";
import {
  API_ROUTES,
  apiPath,
  type ContainerView,
  type HostControlView,
  type HostView,
  type SessionView,
} from "../../../src/shared/api.js";
import { SESSION_QUERY_KEY } from "../constants.js";

// The host page's container table and control card in tests: one host, its containers, and what the dashboard answers.
export const session: SessionView = {
  user: { id: "u1", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};
export const CONTROL = apiPath(API_ROUTES.hostControl, { hostId: "h1" });
export const TICKS = apiPath(API_ROUTES.containerControls, { hostId: "h1" });
export const RUN = apiPath(API_ROUTES.containerUpdates, { hostId: "h1" });
export const STACK_RESTARTS = apiPath(API_ROUTES.stackRestarts, { hostId: "h1" });
export const NO_LOCKS = { restartLock: null, updateLock: null };

export const alder = (dryRun: boolean | null): HostView => ({
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

export const controlView = (overrides: Partial<HostControlView> = {}): HostControlView => ({
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

export const container = (overrides: Partial<ContainerView>): ContainerView => ({
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
  source: null,
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
export const CONTAINERS = [
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

export const noPanels = (hostId: string) => ({
  [apiPath(API_ROUTES.hostNetworks, { hostId })]: { networks: [], lastJob: null },
  [apiPath(API_ROUTES.hostVolumes, { hostId })]: { volumes: [], lastJob: null },
});

// GET answers by path; other methods by "METHOD path". A tick is kept, as the control plane keeps it. No update run
// goes on unless a test says so.
export function serve(routes: Record<string, unknown>) {
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

export function show(element: ReactNode, currentSession: SessionView = session) {
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

export const sent = (fetch: ReturnType<typeof serve>, path: string, method: string, body: object) =>
  waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(path, expect.objectContaining({ method, body: JSON.stringify(body) })),
  );
