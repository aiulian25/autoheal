import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath, type HostControlView, type HostView } from "../../../src/shared/api.js";
import {
  emptyRecoveryState,
  simulateRecovery,
  type PolicyRehearsalContext,
  type PolicyRehearsalRequest,
  type PolicyRehearsalResult,
} from "../../../src/shared/recovery-policy-simulator.js";
import { PolicyRehearsal } from "./policy-rehearsal.js";

const NOW = Date.UTC(2026, 9, 27);
const HOST_ID = "host";
const host: HostView = {
  id: HOST_ID,
  label: "Lab",
  state: "online",
  tokenHint: "hint",
  enrolledAt: NOW,
  lastHeartbeatAt: NOW,
  runnerVersion: "2.0.0",
  dryRun: false,
  eventStreamConnected: true,
  protectedContainers: [],
  restartBudget: {},
  containerAccess: true,
  health: null,
  metrics: null,
  containerCount: 1,
  runningCount: 1,
  problemCount: 0,
};
let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function show(admin = true, expanded = true) {
  let current: HostControlView["restartDefault"] = "ask";
  const context = (): PolicyRehearsalContext => ({
    hostId: HOST_ID,
    hostLabel: "Lab",
    now: NOW,
    restartDefault: current,
    dryRun: false,
    lastHeartbeatAt: NOW,
    containers: [{ name: "app", restart: current, inherited: true, protected: false }],
    restartBudget: {},
    protectedContainers: [],
    maintenance: [],
  });
  const control = (): HostControlView => ({
    hostId: HOST_ID,
    restartDefault: current,
    updateDefault: "ask",
    imageCleanup: "off",
    clearBuildCache: false,
    clearLeftNetworks: false,
    nextCleanupAt: null,
    timeZone: "UTC",
    lastCleanup: null,
  });
  const json = (data: unknown) =>
    new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  const fetch = vi.fn(async (path: string, options: RequestInit) => {
    if (path === API_ROUTES.hosts) return json([host]);
    if (path === apiPath(API_ROUTES.policyRehearsalContext, { hostId: HOST_ID })) return json(context());
    if (path === apiPath(API_ROUTES.hostControl, { hostId: HOST_ID })) {
      if (options.method === "PUT") current = JSON.parse(options.body as string).restartDefault;
      return json(control());
    }
    if (path === API_ROUTES.policyRehearsal) {
      const request = JSON.parse(options.body as string) as PolicyRehearsalRequest;
      const base = {
        startedAt: NOW,
        containers: {},
        protectedContainers: [],
        dryRun: false,
        maintenance: [],
        groups: [],
        initial: [{ name: "app", ...emptyRecoveryState(), restartTimes: [] }],
        events: request.events!,
      };
      const result: PolicyRehearsalResult = {
        hostId: HOST_ID,
        source: "synthetic",
        change: {
          before: current,
          after: request.proposedRestartDefault,
          containers: [{ name: "app", before: current, after: request.proposedRestartDefault }],
        },
        current: simulateRecovery({ ...base, restartDefault: current }),
        proposed: simulateRecovery({ ...base, restartDefault: request.proposedRestartDefault }),
        evidence: { incidentIds: [], assumptions: ["Captured history is incomplete."] },
      };
      return json(result);
    }
    throw new Error(`Unexpected request: ${options.method} ${path}`);
  });
  vi.stubGlobal("fetch", fetch);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter([{ path: "/replays", element: <PolicyRehearsal admin={admin} /> }], {
    initialEntries: [expanded ? `/replays?hostId=${HOST_ID}#policy-rehearsal` : "/replays"],
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    fetch,
    changeLiveDefault: (value: HostControlView["restartDefault"]) => {
      current = value;
    },
  };
}

it("is lazy and keeps deterministic policy rehearsal separate from model replay", async () => {
  const { fetch } = show(true, false);
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Rehearse recovery policy"));
  expect(await screen.findByRole("button", { name: "Run policy rehearsal" })).toBeTruthy();
  expect(fetch.mock.calls.every(([path]) => path === API_ROUTES.hosts || path.includes("/policy/hosts/"))).toBe(true);
});
it("shows a reasoned timeline and requires review before normal authorized policy apply", async () => {
  const { fetch } = show();
  await screen.findByRole("button", { name: "Run policy rehearsal" });
  fireEvent.change(screen.getByRole("combobox", { name: "Proposed failure policy" }), { target: { value: "restart" } });
  fireEvent.click(screen.getByRole("button", { name: "Run policy rehearsal" }));
  await screen.findByRole("region", { name: "Policy rehearsal result" });
  expect(screen.getAllByText(/Hourly restart budget exhausted/).length).toBeGreaterThan(0);
  expect(screen.getByText("Captured history is incomplete.")).toBeTruthy();
  const apply = screen.getByRole("button", { name: "Apply reviewed host default" });
  expect(apply.hasAttribute("disabled")).toBe(true);
  expect(fetch.mock.calls.some(([, options]) => options.method === "PUT")).toBe(false);
  fireEvent.click(
    screen.getByRole("checkbox", { name: "I reviewed the default change and the rehearsal assumptions." }),
  );
  fireEvent.click(apply);
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "Host default saved through the normal control policy. Runners receive it at their next heartbeat.",
  );
  expect(
    fetch.mock.calls
      .filter(([, options]) => options.method === "PUT")
      .map(([, options]) => JSON.parse(options.body as string)),
  ).toEqual([{ restartDefault: "restart" }]);
});
it("keeps a person's choices when its data is fetched again, and fills the form anew for another host", async () => {
  const other = "other";
  const defaults: Record<string, HostControlView["restartDefault"]> = { [HOST_ID]: "ask", [other]: "restart" };
  let fetched = 0;
  const contextOf = (hostId: string): PolicyRehearsalContext => {
    fetched += 1;
    return {
      hostId,
      hostLabel: hostId === HOST_ID ? "Lab" : "Shed",
      // A new moment each time, as the server's clock and the host's last heartbeat give it.
      now: NOW + fetched,
      restartDefault: defaults[hostId]!,
      dryRun: false,
      lastHeartbeatAt: NOW + fetched,
      containers: [{ name: `${hostId}-app`, restart: defaults[hostId]!, inherited: true, protected: false }],
      restartBudget: {},
      protectedContainers: [],
      maintenance: [],
    };
  };
  const json = (data: unknown) =>
    new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      if (path === API_ROUTES.hosts) return json([host, { ...host, id: other, label: "Shed" }]);
      for (const hostId of [HOST_ID, other]) {
        if (path === apiPath(API_ROUTES.policyRehearsalContext, { hostId })) return json(contextOf(hostId));
      }
      throw new Error(`Unexpected request: ${path}`);
    }),
  );
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const router = createMemoryRouter([{ path: "/replays", element: <PolicyRehearsal admin /> }], {
    initialEntries: [`/replays?hostId=${HOST_ID}#policy-rehearsal`],
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const policy = () => screen.getByRole("combobox", { name: "Proposed failure policy" }) as HTMLSelectElement;
  await waitFor(() => expect(policy().value).toBe("ask"));
  fireEvent.change(policy(), { target: { value: "tell" } });

  // The window gets focus back, or the live stream connects: the same host's data again, a moment later.
  const before = fetched;
  await act(() => client.refetchQueries({ queryKey: ["policy-rehearsal", "context", HOST_ID] }));
  // TanStack Query tells the form on a timer of its own: let it, so the form has the new data when it is read.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(fetched).toBe(before + 1);
  expect(policy().value).toBe("tell");

  fireEvent.change(screen.getByRole("combobox", { name: "Rehearsal host" }), { target: { value: other } });
  await waitFor(() => expect(policy().value).toBe("restart"));
});
it("refuses applying a stale review when the live host default changed", async () => {
  const { fetch, changeLiveDefault } = show();
  await screen.findByRole("button", { name: "Run policy rehearsal" });
  fireEvent.change(screen.getByRole("combobox", { name: "Proposed failure policy" }), { target: { value: "restart" } });
  fireEvent.click(screen.getByRole("button", { name: "Run policy rehearsal" }));
  await screen.findByRole("region", { name: "Policy rehearsal result" });
  changeLiveDefault("tell");
  fireEvent.click(
    screen.getByRole("checkbox", { name: "I reviewed the default change and the rehearsal assumptions." }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Apply reviewed host default" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "This host's default changed after rehearsal. Refresh and rehearse the current policy before applying.",
  );
  expect(fetch.mock.calls.some(([, options]) => options.method === "PUT")).toBe(false);
});
it("does not offer viewers a runnable or applicable policy change", async () => {
  show(false);
  const button = await screen.findByRole("button", { name: "Run policy rehearsal" });
  expect(button.hasAttribute("disabled")).toBe(true);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Apply reviewed host default" })).toBeNull());
});
