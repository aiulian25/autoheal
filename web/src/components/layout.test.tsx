import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import {
  API_ROUTES,
  CSRF_HEADER,
  type SessionView,
  type IntegrationView,
  type NotificationDeliveryView,
} from "../../../src/shared/api.js";
import { api, rememberCsrfToken } from "../api-client.js";
import { PATHS, SESSION_QUERY_KEY } from "../constants.js";
import {
  boardQuery,
  integrationsQuery,
  jarvisQuery,
  networkOverviewQuery,
  ollamaQuery,
  overviewQuery,
  routerSettingsQuery,
} from "../queries.js";
import { SignedInApp } from "../router.js";

const session: SessionView = {
  user: { id: "u", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};
let client: QueryClient;
// Long enough to render that React yields before it commits the sign-in page: until then the signed-in page is
// still mounted, and any update that reaches it first renders it again.
const RENDER_STALL_MILLISECONDS = 20;
function SlowSignIn() {
  const until = performance.now() + RENDER_STALL_MILLISECONDS;
  while (performance.now() < until);
  return <p>Sign in</p>;
}
let router: ReturnType<typeof createMemoryRouter>;
function show() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(SESSION_QUERY_KEY, session);
  rememberCsrfToken(session.csrfToken);
  client.setQueryData(boardQuery.queryKey, { needsYou: [] });
  client.setQueryData(ollamaQuery.queryKey, { reachable: true });
  client.setQueryData(overviewQuery.queryKey, { homeAssistant: null });
  client.setQueryData(routerSettingsQuery.queryKey, { configured: false });
  client.setQueryData(jarvisQuery.queryKey, { connected: false });
  client.setQueryData(integrationsQuery.queryKey, [
    { kind: "gotify", source: "dashboard", url: "https://gotify.test", tokenSet: true, topic: null, plainHttp: false },
  ]);
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      close() {}
    },
  );
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  router = createMemoryRouter(
    [
      {
        path: PATHS.home,
        element: <SignedInApp />,
        children: [
          { index: true, element: <p>Attention</p> },
          { path: PATHS.hosts, element: <p>Fleet page</p> },
        ],
      },
      { path: PATHS.login, element: <SlowSignIn /> },
    ],
    { initialEntries: [PATHS.home] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return fetch;
}
afterEach(() => {
  cleanup();
  client?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rememberCsrfToken(null);
});
it("lists what is connected on every page, Jarvis and the router among them", async () => {
  show();
  await screen.findByRole("list", { name: "Connections" });
  expect(screen.queryByText(/Jarvis/)).toBeNull();
  act(() => {
    client.setQueryData(jarvisQuery.queryKey, { connected: true, paused: false, lastHeardAt: Date.now() });
    client.setQueryData(routerSettingsQuery.queryKey, { configured: true });
    client.setQueryData(networkOverviewQuery.queryKey, { connected: true });
  });
  await screen.findByText("Jarvis connected");
  await screen.findByText("Router connected");

  fireEvent.click(screen.getByRole("link", { name: "Fleet" }));
  await screen.findByText("Fleet page");
  expect(screen.getByRole("list", { name: "Connections" })).toBeTruthy();
  expect(screen.getByText("Jarvis connected")).toBeTruthy();

  act(() => {
    client.setQueryData(jarvisQuery.queryKey, { connected: true, paused: false, lastHeardAt: 1 });
  });
  await screen.findByText("Jarvis not heard from");
  act(() => {
    client.setQueryData(jarvisQuery.queryKey, { connected: true, paused: true, lastHeardAt: 1 });
  });
  await screen.findByText("Jarvis paused");
});

it("does not call a configured notification channel sending or healthy before any observed attempt", async () => {
  const fetch = show();
  await screen.findByRole("list", { name: "Connections" });
  expect(screen.queryByText("Gotify sending")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it("shows refused and timed-out attempts as degraded, then a server-accepted success with timestamps", async () => {
  show();
  expect(await screen.findByText("Gotify: Configured; untested")).toBeTruthy();
  expect(
    screen.getByText("Gotify: Configured; untested").closest("li")!.querySelector(".status-dot")!.className,
  ).toContain("off");
  const update = (delivery: NotificationDeliveryView) =>
    act(() => {
      client.setQueryData<IntegrationView[]>(integrationsQuery.queryKey, (rows) =>
        rows!.map((row) => ({ ...row, delivery })),
      );
    });
  for (const failureCode of ["refused", "timeout"] as const) {
    update({ status: "degraded", lastAttemptAt: Date.now(), lastSuccessAt: null, failureCode });
    const failed = await screen.findByText(/^Gotify: Last attempt failed/);
    expect(failed.closest("li")!.querySelector(".status-dot")!.className).toContain("tone-danger");
    expect(failed.title).toContain(failureCode === "timeout" ? "timed out" : "refused");
    expect(screen.queryByText(/Gotify.*sending/)).toBeNull();
  }
  update({ status: "healthy", lastAttemptAt: Date.now(), lastSuccessAt: Date.now(), failureCode: null });
  const accepted = await screen.findByText(/^Gotify: Last accepted by server/);
  expect(accepted.closest("li")!.querySelector(".status-dot")!.className).toContain("tone-good");
  expect(accepted.title).toContain("Last attempt:");
  expect(accepted.title).toContain("does not confirm device receipt");
});

it("forgets private data when the session ends without a sign-out, as an idle timeout or a restore ends it", async () => {
  show();
  client.setQueryData(["private-detail", "one"], { secret: "synthetic-private-data" });
  await screen.findByRole("list", { name: "Connections" });

  // What the session's re-check after a 401 answers: nobody is signed in any more.
  act(() => {
    client.setQueryData(SESSION_QUERY_KEY, null);
  });

  expect(await screen.findByText("Sign in")).toBeTruthy();
  expect(
    client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey),
  ).toEqual([SESSION_QUERY_KEY]);
});

it("forgets the last person's data before showing anything to another signed in from another tab", async () => {
  const fetch = show();
  const viewer: SessionView = { ...session, user: { ...session.user, id: "v", username: "viewer", role: "viewer" } };
  fetch.mockImplementation(async (url: string) =>
    url === API_ROUTES.session
      ? new Response(JSON.stringify(viewer), { status: 200, headers: { "content-type": "application/json" } })
      : new Promise<Response>(() => undefined),
  );
  client.setQueryData(["private-detail", "one"], { secret: "synthetic-private-data" });
  await screen.findByRole("list", { name: "Connections" });

  await act(() => client.invalidateQueries({ queryKey: SESSION_QUERY_KEY }));

  expect(client.getQueryData(SESSION_QUERY_KEY)).toEqual(viewer);
  expect(client.getQueryData(["private-detail", "one"])).toBeUndefined();
  expect(router.state.location.pathname).toBe(PATHS.home);
});

it("keeps the signed-in page, session and private queries after network failure, then clears them on retry success", async () => {
  const fetch = show();
  fetch
    .mockRejectedValueOnce(new TypeError("Network unavailable"))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  client.setQueryData(["private-detail", "one"], { secret: "synthetic-private-data" });
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Could not confirm sign out. You may still be signed in. Try Sign out again.",
  );
  expect(router.state.location.pathname).toBe(PATHS.home);
  expect(client.getQueryData(SESSION_QUERY_KEY)).toEqual(session);
  expect(client.getQueryData(["private-detail", "one"])).toEqual({ secret: "synthetic-private-data" });
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByText("Sign in")).toBeTruthy();
  expect(router.state.location.pathname).toBe(PATHS.login);
  expect(client.getQueryData(SESSION_QUERY_KEY)).toBeNull();
  expect(
    client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey),
  ).toEqual([SESSION_QUERY_KEY]);
  expect(fetch.mock.calls.slice(0, 2).map(([url, init]) => [url, init.method, init.headers[CSRF_HEADER]])).toEqual([
    [API_ROUTES.logout, "POST", session.csrfToken],
    [API_ROUTES.logout, "POST", session.csrfToken],
  ]);
  fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
  await api("POST", "/synthetic-csrf-probe");
  expect(fetch.mock.calls[2]![1].headers[CSRF_HEADER]).toBeUndefined();
});

it("prevents duplicate sign-out requests while pending and keeps the signed-in state until confirmed", async () => {
  const fetch = show();
  let finish!: (response: Response) => void;
  fetch.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const button = screen.getByRole("button", { name: "Sign out" }) as HTMLButtonElement;
  fireEvent.click(button);
  await waitFor(() => expect(button.disabled).toBe(true));
  fireEvent.click(button);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(router.state.location.pathname).toBe(PATHS.home);
  expect(client.getQueryData(SESSION_QUERY_KEY)).toEqual(session);
  await act(async () => finish(new Response(null, { status: 204 })));
  expect(await screen.findByText("Sign in")).toBeTruthy();
});

it.each([
  [403, "bad_csrf"],
  [500, "internal_error"],
  [401, "unexpected_refusal"],
])("does not treat HTTP %s (%s) as confirmation of logout", async (status, error) => {
  const fetch = show();
  fetch.mockResolvedValue(new Response(JSON.stringify({ error }), { status }));
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Could not confirm sign out. You may still be signed in. Try Sign out again.",
  );
  expect(router.state.location.pathname).toBe(PATHS.home);
  expect(client.getQueryData(SESSION_QUERY_KEY)).toEqual(session);
  expect((screen.getByRole("button", { name: "Sign out" }) as HTMLButtonElement).disabled).toBe(false);
});

it("clears private data when the API explicitly confirms the session is already absent", async () => {
  const fetch = show();
  fetch.mockResolvedValue(new Response(JSON.stringify({ error: "not_signed_in" }), { status: 401 }));
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByText("Sign in")).toBeTruthy();
  expect(client.getQueryData(SESSION_QUERY_KEY)).toBeNull();
  expect(
    client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey),
  ).toEqual([SESSION_QUERY_KEY]);
});

it("cancels pending session/private reads so their late responses cannot repopulate a signed-out cache", async () => {
  const fetch = show();
  const closed = vi.spyOn(EventSource.prototype, "close");
  fetch.mockResolvedValue(new Response(null, { status: 204 }));
  const releases: (() => void)[] = [];
  const pending = [SESSION_QUERY_KEY, ["private-detail", "pending"]].map((queryKey) =>
    client
      .fetchQuery({
        queryKey,
        staleTime: 0,
        queryFn: () =>
          new Promise((resolve) => {
            releases.push(() => resolve(session));
          }),
      })
      .catch(() => undefined),
  );
  expect(releases).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByText("Sign in")).toBeTruthy();
  await act(async () => {
    releases.forEach((release) => release());
    await Promise.all(pending);
  });
  expect(client.getQueryData(SESSION_QUERY_KEY)).toBeNull();
  expect(
    client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey),
  ).toEqual([SESSION_QUERY_KEY]);
  expect(closed).toHaveBeenCalledTimes(1);
});
