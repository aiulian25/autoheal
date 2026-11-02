import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath, type HostView, type SessionView } from "../../../src/shared/api.js";
import type { SavedView, ViewPreferences } from "../../../src/shared/view-preferences.js";
import { SESSION_QUERY_KEY, TEXT } from "../constants.js";
import { useFilters } from "./filters.js";
import { SavedViewPicker } from "./saved-view-picker.js";

const text = TEXT.savedViews;
const session: SessionView = {
  user: { id: "u1", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};
const HOSTS = [{ id: "h1", label: "Alder" }] as HostView[];
const view = (change: Partial<SavedView> = {}): SavedView => ({
  id: "v1",
  name: "Problems on Alder",
  search: "db",
  problemsOnly: true,
  hostId: "h1",
  ...change,
});

let preferences: ViewPreferences;
let sent: { method: string; url: string; body: Record<string, unknown> | null }[];

beforeEach(() => {
  preferences = { views: [], board: null };
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        sent.push({ method, url, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
      }
      if (method === "POST") preferences = { ...preferences, views: [view({ id: "new", name: "Mine" })] };
      if (method === "DELETE") preferences = { ...preferences, views: [] };
      return new Response(JSON.stringify(preferences), { status: 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Page() {
  const filters = useFilters();
  const { search } = useLocation();
  return (
    <>
      <SavedViewPicker filters={filters} hosts={HOSTS} />
      <output>{search}</output>
    </>
  );
}
function show(address = "/containers") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(SESSION_QUERY_KEY, session);
  const router = createMemoryRouter([{ path: "/containers", element: <Page /> }], { initialEntries: [address] });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}
const address = () => screen.getByRole("status").textContent;

describe("saved views beside the filters", () => {
  it("adds nothing for someone with no views and no filter set", async () => {
    show();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve));
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers to save only once there is something to save, and saves those filters", async () => {
    show("/containers?search=db&problems=true&host=h1");
    fireEvent.click(await screen.findByRole("button", { name: text.save }));
    fireEvent.change(screen.getByLabelText(text.name), { target: { value: "Mine" } });
    fireEvent.click(screen.getByRole("button", { name: text.saveNow }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      method: "POST",
      url: API_ROUTES.accountSavedViews,
      body: { name: "Mine", search: "db", problemsOnly: true, hostId: "h1" },
    });
  });

  it("opens a view into the address, all its filters at once, so it can be shared", async () => {
    preferences = { views: [view()], board: null };
    show();
    fireEvent.change(await screen.findByLabelText(text.label), { target: { value: "v1" } });
    await waitFor(() => expect(address()).toBe("?search=db&problems=true&host=h1"));
    expect((screen.getByLabelText(text.label) as HTMLSelectElement).value).toBe("v1");
  });

  it("clears the filters when none is chosen", async () => {
    preferences = { views: [view()], board: null };
    show("/containers?search=db&problems=true&host=h1");
    fireEvent.change(await screen.findByLabelText(text.label), { target: { value: "" } });
    await waitFor(() => expect(address()).toBe(""));
  });

  it("checks again that a view's host is still there, and leaves it out if not", async () => {
    preferences = { views: [view({ hostId: "gone" })], board: null };
    show();
    fireEvent.change(await screen.findByLabelText(text.label), { target: { value: "v1" } });
    await waitFor(() => expect(address()).toBe("?search=db&problems=true"));
    expect(screen.getByText(text.hostGone)).toBeTruthy();
  });

  it("removes the view that is open", async () => {
    preferences = { views: [view()], board: null };
    show("/containers?search=db&problems=true&host=h1");
    fireEvent.click(await screen.findByRole("button", { name: text.remove }));
    await waitFor(() =>
      expect(sent).toEqual([
        { method: "DELETE", url: apiPath(API_ROUTES.accountSavedView, { viewId: "v1" }), body: null },
      ]),
    );
    await waitFor(() => expect(screen.queryByLabelText(text.label)).toBeNull());
  });
});
