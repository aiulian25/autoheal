import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath, type HostView } from "../../../src/shared/api.js";
import { TEXT } from "../constants.js";
import { HostHistory } from "./host-stats.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("folds the stats history away under the dials, and reads it only once it is opened", async () => {
  const fetch = vi.fn(async (_url: string) => new Response("[]", { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <HostHistory host={{ id: "h1", label: "DeltaAv1" } as HostView} />
    </QueryClientProvider>,
  );
  const fold = screen.getByText(TEXT.metrics.statsHistory).closest("details")!;
  expect(fold.open).toBe(false);
  expect(screen.queryByText(TEXT.metrics.history)).toBeNull();
  expect(fetch).not.toHaveBeenCalled();

  fold.open = true;
  fireEvent(fold, new Event("toggle"));
  expect(await screen.findByText(TEXT.metrics.history)).toBeTruthy();
  await waitFor(() =>
    expect(fetch.mock.calls.map(([url]) => String(url))).toContain(apiPath(API_ROUTES.hostMetrics, { hostId: "h1" })),
  );
  client.clear();
});
