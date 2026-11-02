import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionView } from "../../src/shared/api.js";
import { PATHS, SESSION_QUERY_KEY, TEXT } from "./constants.js";
import { boardQuery, integrationsQuery, ollamaQuery, overviewQuery } from "./queries.js";
import { routes } from "./router.js";

const fixtures = vi.hoisted(() => ({
  pageFailure: new Error("A host view in a shape the Fleet page does not expect"),
  signInFailure: new Error("A sign-in step that cannot draw itself"),
  attention: "The Attention page",
}));
const REACT_ROUTER_FALLBACK = "Unexpected Application Error!";

// Two screens that throw while rendering, as one would given data in a shape it does not expect, and an Attention
// page that needs no data to come back to.
vi.mock("./pages/fleet-page.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pages/fleet-page.js")>()),
  FleetPage: () => {
    throw fixtures.pageFailure;
  },
}));
vi.mock("./pages/auth-pages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pages/auth-pages.js")>()),
  LoginPage: () => {
    throw fixtures.signInFailure;
  },
}));
vi.mock("./pages/attention-page.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pages/attention-page.js")>()),
  AttentionPage: () => <p>{fixtures.attention}</p>,
}));

const session: SessionView = {
  user: { id: "u", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};
let client: QueryClient;

function show(path: string, signedIn: SessionView | null) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(SESSION_QUERY_KEY, signedIn);
  client.setQueryData(boardQuery.queryKey, { needsYou: [] });
  client.setQueryData(ollamaQuery.queryKey, { reachable: true });
  client.setQueryData(overviewQuery.queryKey, { homeAssistant: null });
  client.setQueryData(integrationsQuery.queryKey, []);
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      close() {}
    },
  );
  vi.stubGlobal("fetch", vi.fn());
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

afterEach(() => {
  cleanup();
  client?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps the navigation and the session when a page fails to render, says so, and lets the person move on", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const router = show(PATHS.hosts, session);
  const notice = await screen.findByText(TEXT.routeError.message);
  expect(notice.getAttribute("role")).toBe("alert");
  expect(screen.getByRole("navigation", { name: TEXT.nav.label })).toBeTruthy();
  expect(screen.getByRole("button", { name: TEXT.signOut })).toBeTruthy();
  expect(screen.queryByText(REACT_ROUTER_FALLBACK)).toBeNull();
  expect(consoleError.mock.calls.some((call) => call.includes(fixtures.pageFailure))).toBe(true);

  const page = within(screen.getByRole("main"));
  expect(page.getByRole("button", { name: TEXT.routeError.reload })).toBeTruthy();
  fireEvent.click(page.getByRole("link", { name: TEXT.nav.attention }));
  expect(await screen.findByText(fixtures.attention)).toBeTruthy();
  expect(screen.queryByText(TEXT.routeError.message)).toBeNull();
  expect(router.state.location.pathname).toBe(PATHS.home);
});

it("shows the same notice, never a stack trace, when a screen outside the dashboard fails to render", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  show(PATHS.login, null);
  const notice = await screen.findByText(TEXT.routeError.message);
  expect(notice.closest("main")!.className).toBe("centered");
  expect(screen.queryByText(REACT_ROUTER_FALLBACK)).toBeNull();
  expect(document.querySelector("pre")).toBeNull();
});
