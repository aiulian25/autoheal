import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { API_ROUTES } from "../../../src/shared/api.js";
import type { MaintenanceView } from "../../../src/shared/maintenance.js";
import { MaintenanceBadge, MaintenanceDialog } from "./maintenance-dialog.js";
const NOW = Date.UTC(2026, 9, 27);
let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function show(content: React.ReactNode, view: MaintenanceView) {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const fetch = vi.fn(async (_url: string, options: RequestInit) => {
    if (options.method === "POST") {
      view = {
        ...view,
        generation: 1,
        windows: [
          {
            id: "window",
            hostId: "host",
            containerName: null,
            owner: "admin",
            reason: "Planned upgrade",
            startsAt: NOW,
            expiresAt: NOW + 60 * 60_000,
          },
        ],
      };
    }
    return { ok: true, status: 200, json: async () => view };
  });
  vi.stubGlobal("fetch", fetch);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}>{content}</QueryClientProvider>);
  return fetch;
}
it("distinguishes a requested window from runner acknowledgement and scopes container badges", async () => {
  const view: MaintenanceView = {
    generation: 1,
    acknowledged: { host: { generation: 0, at: NOW } },
    windows: [
      {
        id: "w",
        hostId: "host",
        containerName: "db",
        owner: "admin",
        reason: "Planned upgrade",
        startsAt: NOW,
        expiresAt: NOW + 60_000,
      },
    ],
  };
  show(
    <>
      <MaintenanceBadge hostId="host" containerName="db" />
      <MaintenanceBadge hostId="host" containerName="other" />
    </>,
    view,
  );
  expect(await screen.findByText("Maintenance · awaiting runner")).toBeTruthy();
  expect(screen.getAllByText(/Maintenance/)).toHaveLength(1);
  client.setQueryData(["maintenance"], { ...view, acknowledged: { host: { generation: 1, at: NOW } } });
  expect(await screen.findByText("Maintenance · runner confirmed")).toBeTruthy();
});
it("saves a bounded maintenance request with a reason and keeps confirmation visible", async () => {
  const fetch = show(<MaintenanceDialog hostId="host" admin />, {
    generation: 0,
    windows: [],
    acknowledged: { host: { generation: 0, at: NOW } },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Start maintenance", hidden: true }).hasAttribute("disabled")).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByText("Maintenance windows"));
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Planned upgrade" } });
  fireEvent.click(screen.getByRole("button", { name: "Start maintenance" }));
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "Maintenance policy saved. Await runner confirmation before planned work.",
  );
  const post = fetch.mock.calls.find(([, options]) => options.method === "POST")!;
  expect(post[0]).toContain("/maintenance");
  expect(JSON.parse(post[1].body as string)).toEqual({
    containerName: null,
    reason: "Planned upgrade",
    expiresAt: NOW + 60 * 60_000,
  });
  expect(fetch.mock.calls.some(([path]) => path === API_ROUTES.maintenance)).toBe(true);
});
it("does not offer creation on an unsupported runner or to a viewer", async () => {
  show(<MaintenanceDialog hostId="host" admin />, {
    generation: 0,
    windows: [],
    acknowledged: { host: { generation: null, at: NOW } },
  });
  expect(await screen.findByText(/Update and connect/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start maintenance", hidden: true }).hasAttribute("disabled")).toBe(true);
});
