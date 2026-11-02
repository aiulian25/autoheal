import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath, type HostView } from "../../../src/shared/api.js";
import type { ResourcePermissionsView } from "../../../src/shared/resource-permissions.js";
import { OperatorGrants } from "./operator-grants.js";
const HOST = "66cc4c4e-efb1-4a02-9e0b-f9ba7c2e7b92";
const USER = "33bd481a-73d8-4e12-8ec2-f7d334b6cc3c";
const PATH = apiPath(API_ROUTES.userGrants, { userId: USER });
let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function show(initial: ResourcePermissionsView = { revision: 3, grants: [] }, conflict = false) {
  let view = initial;
  const fetch = vi.fn(async (path: string, options?: RequestInit) => {
    const method = options?.method ?? "GET";
    let body: unknown = [];
    let status = 200;
    if (path === PATH && method === "GET") body = view;
    else if (path === PATH && method === "PUT") {
      if (conflict) {
        body = { error: "permission_conflict" };
        status = 409;
      } else {
        view = { ...JSON.parse(options!.body as string), revision: view.revision + 1 };
        body = view;
      }
    } else if (path === API_ROUTES.hosts) body = [{ id: HOST, label: "Lab", state: "online" } as HostView];
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OperatorGrants userId={USER} username="operator" />
    </QueryClientProvider>,
  );
  return fetch;
}
async function open() {
  const details = screen.getByText("Scoped operator access").closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  await screen.findByText("No delegated actions.");
}
it("loads only when opened, reviews exact grants and saves with the current revision", async () => {
  const fetch = show();
  expect(fetch).not.toHaveBeenCalled();
  await open();
  await screen.findByRole("option", { name: "Lab" });
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: HOST } });
  fireEvent.change(screen.getByLabelText("Exact container name"), { target: { value: "database" } });
  fireEvent.click(screen.getByLabelText("Read container logs"));
  fireEvent.click(screen.getByRole("button", { name: "Add to review" }));
  expect(fetch.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false);
  expect(screen.getByText(/Saving ends this person’s current sessions/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save access changes" }));
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "Access saved. The person must sign in again.",
  );
  const put = fetch.mock.calls.find(([, options]) => options?.method === "PUT")!;
  expect(JSON.parse(put[1]!.body as string)).toEqual({
    revision: 3,
    grants: [{ hostId: HOST, scope: "container", resource: "database", actions: ["logs"] }],
  });
});
it("allows an administrator to review revocation without changing account roles", async () => {
  const fetch = show({
    revision: 4,
    grants: [{ hostId: HOST, scope: "host", resource: null, actions: ["lifecycle"] }],
  });
  const details = screen.getByText("Scoped operator access").closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  fireEvent.click(await screen.findByRole("button", { name: "Remove grant" }));
  expect(fetch.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Save access changes" }));
  await screen.findByRole("status");
  const put = fetch.mock.calls.find(([, options]) => options?.method === "PUT")!;
  expect(JSON.parse(put[1]!.body as string)).toEqual({ revision: 4, grants: [] });
  expect(fetch.mock.calls.filter(([path]) => path === apiPath(API_ROUTES.user, { userId: USER }))).toEqual([]);
});
it("preserves the draft and offers a reload when another administrator changed the grants", async () => {
  show({ revision: 4, grants: [] }, true);
  await open();
  await screen.findByRole("option", { name: "Lab" });
  fireEvent.change(screen.getByLabelText("Host"), { target: { value: HOST } });
  fireEvent.change(screen.getByLabelText("Scope"), { target: { value: "host" } });
  fireEvent.click(screen.getByLabelText("Read container logs"));
  fireEvent.click(screen.getByRole("button", { name: "Add to review" }));
  fireEvent.click(screen.getByRole("button", { name: "Save access changes" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "These grants changed while you were editing. Reload them before saving.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Discard changes and reload" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save access changes" }).hasAttribute("disabled")).toBe(true),
  );
});
