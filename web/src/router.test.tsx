import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import type { BoardView, SessionView } from "../../src/shared/api.js";
import { PATHS, SESSION_QUERY_KEY, TEXT } from "./constants.js";
import { boardQuery, integrationsQuery, ollamaQuery, overviewQuery } from "./queries.js";
import { routes } from "./router.js";

const fixtures = vi.hoisted(() => ({
  pageFailure: new Error("A host view in a shape the Fleet page does not expect"),
  signInFailure: new Error("A sign-in step that cannot draw itself"),
  attention: "The Attention page",
}));
const REACT_ROUTER_FALLBACK = "Unexpected Application Error!";
// A page's code loads the first time it is opened: in a test, while other files run, that first load can take over
// the second a find waits by default.
const FIRST_PAGE_LOAD = { timeout: 5_000 };

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
// Which page modules have been loaded: none until its page is first opened.
const loaded = vi.hoisted(() => new Set<string>());
vi.mock("./pages/board-page.js", async (importOriginal) => {
  loaded.add("board");
  return importOriginal<typeof import("./pages/board-page.js")>();
});

const session: SessionView = {
  user: { id: "u", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};
let client: QueryClient;

function show(path: string, signedIn: SessionView | null) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(SESSION_QUERY_KEY, signedIn);
  const emptyBoard: BoardView = { needsYou: [], autoheal: [], noticed: [], done: [] };
  client.setQueryData(boardQuery.queryKey, emptyBoard);
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

it("loads a page's code the first time it is opened, not with the dashboard", async () => {
  const router = show(PATHS.home, session);
  expect(await screen.findByText(fixtures.attention, {}, FIRST_PAGE_LOAD)).toBeTruthy();
  expect(loaded.has("board")).toBe(false);
  await router.navigate(PATHS.board);
  await waitFor(() => expect(loaded.has("board")).toBe(true), FIRST_PAGE_LOAD);
  // Drawn, not only loaded: its columns, and no notice that it failed.
  const column = TEXT.board.columns.needsYou.title;
  expect(await screen.findByRole("region", { name: column }, FIRST_PAGE_LOAD)).toBeTruthy();
  expect(screen.queryByText(TEXT.routeError.message)).toBeNull();
});

it("keeps the navigation and the session when a page fails to render, says so, and lets the person move on", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const router = show(PATHS.hosts, session);
  const notice = await screen.findByText(TEXT.routeError.message, {}, FIRST_PAGE_LOAD);
  expect(notice.getAttribute("role")).toBe("alert");
  expect(screen.getByRole("navigation", { name: TEXT.nav.label })).toBeTruthy();
  expect(screen.getByRole("button", { name: TEXT.signOut })).toBeTruthy();
  expect(screen.queryByText(REACT_ROUTER_FALLBACK)).toBeNull();
  expect(consoleError.mock.calls.some((call) => call.includes(fixtures.pageFailure))).toBe(true);

  const page = within(screen.getByRole("main"));
  expect(page.getByRole("button", { name: TEXT.routeError.reload })).toBeTruthy();
  fireEvent.click(page.getByRole("link", { name: TEXT.nav.attention }));
  expect(await screen.findByText(fixtures.attention, {}, FIRST_PAGE_LOAD)).toBeTruthy();
  expect(screen.queryByText(TEXT.routeError.message)).toBeNull();
  expect(router.state.location.pathname).toBe(PATHS.home);
});

it("shows the same notice, never a stack trace, when a screen outside the dashboard fails to render", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  show(PATHS.login, null);
  const notice = await screen.findByText(TEXT.routeError.message, {}, FIRST_PAGE_LOAD);
  expect(notice.closest("main")!.className).toBe("centered");
  expect(screen.queryByText(REACT_ROUTER_FALLBACK)).toBeNull();
  expect(document.querySelector("pre")).toBeNull();
});
