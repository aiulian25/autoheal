import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath, type HostMetricsView, type HostView } from "../../../src/shared/api.js";
import { hostMetrics } from "../../../test/support/inventory.js";
import { TEXT } from "../constants.js";
import { HostHistory } from "./host-stats.js";

const JSON_HEADERS = { "content-type": "application/json" };
const reading = (at: number): HostMetricsView => ({ ...hostMetrics(), at });
const answer = (body: unknown) => new Response(JSON.stringify(body), { headers: JSON_HEADERS });
const refused = () =>
  new Response(JSON.stringify({ error: "host_unreachable" }), { status: 503, headers: JSON_HEADERS });
const isMetrics = (url: string) => url === apiPath(API_ROUTES.hostMetrics, { hostId: "h1" });

/** The fold, opened as a person opens it: nothing is read until then. */
function openHistory(fetch: (url: string) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(fetch as (url: string) => Promise<Response>));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <HostHistory host={{ id: "h1", label: "DeltaAv1" } as HostView} />
    </QueryClientProvider>,
  );
  const fold = screen.getByText(TEXT.metrics.statsHistory).closest("details")!;
  fold.open = true;
  fireEvent(fold, new Event("toggle"));
  return client;
}

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

it("says it is reading, then that there are no readings yet, rather than showing nothing", async () => {
  const client = openHistory(async (url) => (isMetrics(url) ? answer([]) : answer({})));

  expect(await screen.findByText(TEXT.loading)).toBeTruthy();
  expect(await screen.findByText(TEXT.metrics.noReadings)).toBeTruthy();
  expect(screen.queryByText(TEXT.loading)).toBeNull();
  client.clear();
});

it("says a reading could not be read, and reads again on request", async () => {
  let answering = refused;
  const client = openHistory(async (url) => (isMetrics(url) ? answering() : answer({})));

  const notice = await screen.findByRole("alert");
  expect(notice.textContent).toBeTruthy();
  expect(screen.queryByText(TEXT.metrics.noReadings)).toBeNull();

  answering = () => answer([reading(1), reading(2)]);
  fireEvent.click(screen.getByRole("button", { name: TEXT.metrics.readAgain }));

  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByText(TEXT.metrics.cpu)).toBeTruthy();
  expect(screen.queryByRole("button", { name: TEXT.metrics.readAgain })).toBeNull();
  client.clear();
});

it("keeps the readings it has when the next read fails, and says they are not the newest", async () => {
  let answering = () => answer([reading(1), reading(2)]);
  const client = openHistory(async (url) => (isMetrics(url) ? answering() : answer({})));

  expect(await screen.findByText(TEXT.metrics.cpu)).toBeTruthy();
  expect(screen.queryByText(TEXT.metrics.oldReadings)).toBeNull();

  // The refresh that follows on its own, which the host no longer answers.
  answering = refused;
  await client.invalidateQueries({ queryKey: ["host-metrics", "h1"] });

  expect(await screen.findByText(TEXT.metrics.oldReadings)).toBeTruthy();
  expect(screen.getByText(TEXT.metrics.cpu)).toBeTruthy();
  expect(screen.getByRole("button", { name: TEXT.metrics.readAgain })).toBeTruthy();
  expect(screen.queryByText(TEXT.metrics.noReadings)).toBeNull();
  client.clear();
});
