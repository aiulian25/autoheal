import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath, type HostView } from "../../../src/shared/api.js";
import type { OperationImpactView, TopologyView } from "../../../src/shared/topology.js";
import { MemoryRouter } from "react-router";
import { HOST_SECTIONS } from "../../../src/shared/constants.js";
import { DEPENDENCY_MAP_TEXT } from "../constants.js";
import { DependencyMap, OperationImpactReview } from "./dependency-map.js";

const host: HostView = {
  id: "host",
  label: "mini",
  state: "online",
  tokenHint: "hint",
  enrolledAt: 1,
  lastHeartbeatAt: 1,
  runnerVersion: "2.0.0",
  dryRun: false,
  eventStreamConnected: true,
  protectedContainers: [],
  restartBudget: {},
  containerAccess: null,
  health: null,
  metrics: null,
  containerCount: 0,
  runningCount: 0,
  problemCount: 0,
};
let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
// Reached by the host page's Dependencies tab unless told otherwise: the map opens by itself then.
function show(content: React.ReactNode, answer: unknown, hash = `#${HOST_SECTIONS.dependencies}`) {
  const fetch = vi.fn(
    async () => new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetch);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/hosts/host${hash}`]}>{content}</MemoryRouter>
    </QueryClientProvider>,
  );
  return fetch;
}

it("stays folded away, reading nothing, until it is opened", async () => {
  const fetch = show(<DependencyMap host={host} />, { hostId: "host", available: false }, "");
  const fold = screen.getByText(DEPENDENCY_MAP_TEXT.title).closest("details")!;
  expect(fold.open).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  fold.open = true;
  fireEvent(fold, new Event("toggle"));
  expect(await screen.findByText(DEPENDENCY_MAP_TEXT.noReportFromRunner)).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("offers distinct accessible relationship lists and labels a stale partial graph", async () => {
  const view: TopologyView = {
    hostId: "host",
    available: true,
    stale: true,
    revision: "one",
    snapshot: {
      capturedAt: Date.now(),
      nodes: [
        { name: "app", containerId: "a", composeProject: "stack" },
        { name: "db", containerId: "b", composeProject: "stack" },
      ],
      edges: ["network_namespace", "compose_association", "shared_writable_data", "declared_dependency"].map(
        (kind) => ({ from: "app", to: "db", kind: kind as "network_namespace", source: "docker" }),
      ),
      truncated: true,
      notes: ["byte_limit"],
    },
  };
  show(<DependencyMap host={host} />, view);
  expect(await screen.findByRole("heading", { name: "Shares network namespace" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Same Compose project (association only)" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Shares writable data" })).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Declared dependency (Compose depends_on or autoheal.depends-on)" }),
  ).toBeTruthy();
  expect(screen.getByText(/This report is stale/)).toBeTruthy();
  expect(screen.getByText(/This report is partial/)).toBeTruthy();
});
it.each([
  ["a runner host", host, DEPENDENCY_MAP_TEXT.noReportFromRunner],
  ["an SSH host with Docker", { ...host, kind: "ssh", docker: true }, DEPENDENCY_MAP_TEXT.notYet],
  ["an SSH host without Docker", { ...host, kind: "ssh", docker: false }, DEPENDENCY_MAP_TEXT.noDocker],
] as const)("says why %s has no dependency report, and what to do", async (_name, shown, words) => {
  show(<DependencyMap host={shown} />, { hostId: "host", available: false, stale: true, revision: "", snapshot: null });
  expect(await screen.findByText(words)).toBeTruthy();
});
it("submits only a read-only preflight until the reviewed scope is explicitly confirmed", async () => {
  const confirm = vi.fn();
  const view: OperationImpactView = {
    id: "prepared",
    hostId: "host",
    containerName: "app",
    action: "update",
    expiresAt: Date.now() + 60_000,
    answer: {
      ok: true,
      fingerprint: "a".repeat(64),
      members: [
        { name: "app", protected: false },
        { name: "db", protected: false },
      ],
      resources: ["resource-0123456789abcdef"],
      refusals: [],
    },
  };
  const fetch = show(
    <OperationImpactReview hostId="host" action="update" names={["app"]} onCancel={() => {}} onConfirm={confirm} />,
    view,
  );
  await screen.findByText("db");
  expect(screen.getByRole("dialog", { name: /^Review update .*impact$/ })).toBeTruthy();
  expect(confirm).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    apiPath(API_ROUTES.operationPreview, { hostId: "host", containerName: "app" }),
    expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "update" }) }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm reviewed operation" }));
  expect(confirm).toHaveBeenCalledWith({ app: "prepared" });
});
it("blocks protected/refused plans and expired reviews", async () => {
  const confirm = vi.fn();
  const view: OperationImpactView = {
    id: "prepared",
    hostId: "host",
    containerName: "app",
    action: "update",
    expiresAt: Date.now() - 1,
    answer: {
      ok: true,
      fingerprint: "a".repeat(64),
      members: [{ name: "db", protected: true }],
      resources: [],
      refusals: ["Protected group member"],
    },
  };
  show(
    <OperationImpactReview hostId="host" action="update" names={["app"]} onCancel={() => {}} onConfirm={confirm} />,
    view,
  );
  await screen.findByText("Protected group member");
  expect(screen.getByRole("button", { name: "Confirm reviewed operation" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Confirm reviewed operation" }));
  expect(confirm).not.toHaveBeenCalled();
});
