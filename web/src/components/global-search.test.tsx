import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { SEARCH_LIMITS, type SearchResponse } from "../../../src/shared/search.js";
import { GlobalSearch } from "./global-search.js";
const response: SearchResponse = {
  query: "Atlas",
  partial: false,
  elapsedMilliseconds: 1,
  results: [
    {
      kind: "container",
      id: "Atlas-db",
      hostId: "host",
      title: "Atlas-db",
      snippet: "Container inventory",
      at: null,
      href: "/hosts/host?container=Atlas-db#containers",
    },
  ],
};
let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search + location.hash}</output>;
}
function show(fetch: ReturnType<typeof vi.fn>, currentHostId?: string) {
  vi.stubGlobal("fetch", fetch);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GlobalSearch currentHostId={currentHostId} />
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return screen.getByRole("combobox", { name: "Search infrastructure" });
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
it("debounces a burst into one request and opens an existing container route with keyboard navigation", async () => {
  const fetch = vi.fn().mockImplementation(async () => json(response));
  const input = show(fetch);
  expect(fetch).not.toHaveBeenCalled();
  for (const value of ["At", "Atl", "Atla", "Atlas"]) fireEvent.change(input, { target: { value } });
  expect(fetch).not.toHaveBeenCalled();
  expect(await screen.findByRole("option", { name: /Atlas-db/ })).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0]![0])).toContain("q=Atlas");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByTestId("location").textContent).toBe("/hosts/host?container=Atlas-db#containers");
  expect(input.getAttribute("aria-expanded")).toBe("false");
});
it("cancels an obsolete request and does not render its result", async () => {
  let firstSignal: AbortSignal | undefined;
  const fetch = vi.fn((path: string, options: RequestInit) => {
    if (path.includes("q=Atlas")) {
      firstSignal = options.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) =>
        firstSignal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }),
      );
    }
    return Promise.resolve(json({ ...response, query: "Beta", results: [] }));
  });
  const input = show(fetch);
  fireEvent.change(input, { target: { value: "Atlas" } });
  await waitFor(() => expect(firstSignal).toBeDefined());
  fireEvent.change(input, { target: { value: "Beta" } });
  expect(await screen.findByText("No matching items.")).toHaveProperty("textContent", "No matching items.");
  expect(firstSignal!.aborted).toBe(true);
  expect(screen.queryByRole("option")).toBeNull();
});
it("supports a host filter, an accessible failure state, and the focus shortcut", async () => {
  const fetch = vi
    .fn()
    .mockImplementationOnce(async () => json(response))
    .mockImplementationOnce(async () => json({ error: "internal_error" }, 500));
  const input = show(fetch, "host-id");
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "Atlas" } });
  await screen.findByRole("option");
  fireEvent.click(screen.getByLabelText("Only this host"));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(String(fetch.mock.calls[1]![0])).toContain("hostId=host-id");
  expect(screen.queryByRole("option")).toBeNull();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input.getAttribute("aria-expanded")).toBe("false");
});
it("does not query single characters or exceed the agreed input/request budget", async () => {
  const fetch = vi.fn();
  const input = show(fetch);
  fireEvent.change(input, { target: { value: "a" } });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, SEARCH_LIMITS.debounceMilliseconds + 20));
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(input.getAttribute("maxlength")).toBe(String(SEARCH_LIMITS.query));
});
