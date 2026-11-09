import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath, type RunbookSuggestionView, type SessionView } from "../../../src/shared/api.js";
import { PATHS, REPLAY_REFRESH_MILLISECONDS, SESSION_QUERY_KEY, TEXT } from "../constants.js";
import { RunbookDetailPage, RunbooksPage } from "./runbooks-page.js";

const KEY = "a".repeat(64);
const DRAFT = apiPath(API_ROUTES.runbookSuggestionDraft, { key: KEY });
const text = TEXT.runbooks.suggested;

// paperless escalated three times, and each time restarting tika held.
const suggestion = (overrides: Partial<RunbookSuggestionView> = {}): RunbookSuggestionView => ({
  key: KEY,
  hostId: "h1",
  hostLabel: "HP",
  containerName: "paperless",
  trigger: "die",
  action: "restart_dependency",
  target: "tika",
  incidents: [
    { id: "i3", detectedAt: Date.UTC(2026, 9, 27) },
    { id: "i2", detectedAt: Date.UTC(2026, 9, 24) },
    { id: "i1", detectedAt: Date.UTC(2026, 9, 20) },
  ],
  title: "paperless: restart tika when it dies",
  runbookId: null,
  replay: null,
  ...overrides,
});

const sessionFor = (role: "admin" | "viewer"): SessionView => ({
  user: { id: "u1", username: role, role, mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
});

// GET answers by path, other methods by "METHOD path".
function serve(role: "admin" | "viewer", answers: Record<string, unknown>) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split("?")[0]!;
    const method = init?.method ?? "GET";
    const served: Record<string, unknown> = { [API_ROUTES.session]: sessionFor(role), ...answers };
    const answer = method === "GET" ? served[path] : served[`${method} ${path}`];
    return new Response(JSON.stringify(answer ?? []), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function show(role: "admin" | "viewer") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(SESSION_QUERY_KEY, sessionFor(role));
  const router = createMemoryRouter([{ path: PATHS.runbooks, element: <RunbooksPage /> }], {
    initialEntries: [PATHS.runbooks],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("suggested runbooks", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers an admin a draft for a recurring escalation, then says how the draft did", async () => {
    const drafted = suggestion({ runbookId: "r1", replay: { id: "p1", status: "finished", matched: 3, incidents: 3 } });
    const answers: Record<string, unknown> = {
      [API_ROUTES.runbooks]: [],
      [API_ROUTES.runbookSuggestions]: [suggestion()],
      [`POST ${DRAFT}`]: drafted,
    };
    const fetch = serve("admin", answers);
    show("admin");
    const section = await screen.findByRole("region", { name: text.title });
    expect(within(section).getByText("paperless: restart tika when it dies")).toBeTruthy();
    // Each escalation behind it, linked.
    expect(within(section).getAllByRole("link")).toHaveLength(3);

    answers[API_ROUTES.runbookSuggestions] = [drafted];
    fireEvent.click(within(section).getByRole("button", { name: text.makeDraft }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(DRAFT, expect.objectContaining({ method: "POST" })));
    expect(await within(section).findByText(text.matched(3, 3))).toBeTruthy();
    expect(within(section).getByRole("link", { name: text.openDraft }).getAttribute("href")).toBe(
      apiPath(PATHS.runbook, { runbookId: "r1" }),
    );
    expect(within(section).getByRole("button", { name: text.tryAgain })).toBeTruthy();
  });

  it("says while the draft is being tried, then how it did, and shows a viewer nothing", async () => {
    const trying = suggestion({ runbookId: "r1", replay: { id: "p1", status: "running", matched: 0, incidents: 3 } });
    const answers: Record<string, unknown> = { [API_ROUTES.runbooks]: [], [API_ROUTES.runbookSuggestions]: [trying] };
    serve("admin", answers);
    show("admin");
    expect(await screen.findByText(text.trying)).toBeTruthy();
    answers[API_ROUTES.runbookSuggestions] = [
      { ...trying, replay: { ...trying.replay!, status: "finished", matched: 1 } },
    ];
    expect(await screen.findByText(text.matched(1, 3), {}, { timeout: REPLAY_REFRESH_MILLISECONDS * 2 })).toBeTruthy();

    cleanup();
    const fetch = serve("viewer", { [API_ROUTES.runbooks]: [] });
    show("viewer");
    expect(await screen.findByText(TEXT.runbooks.empty)).toBeTruthy();
    expect(screen.queryByRole("region", { name: text.title })).toBeNull();
    expect(fetch).not.toHaveBeenCalledWith(API_ROUTES.runbookSuggestions, expect.anything());
  });
});

describe("a runbook's versions", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const version = (number: number, body: string, published: boolean) => ({
    id: `v${number}`,
    version: number,
    body,
    contentHash: String(number).repeat(64),
    createdBy: "admin",
    createdAt: Date.UTC(2026, 9, number),
    publishedAt: published ? Date.UTC(2026, 9, number) : null,
  });

  it("says a published version stays as written, and starts a new draft from any version", async () => {
    serve("admin", {
      [apiPath(API_ROUTES.runbook, { runbookId: "r1" })]: {
        id: "r1",
        scope: "global",
        pattern: null,
        title: "Be careful with tika",
        archived: false,
        createdAt: Date.UTC(2026, 9, 1),
        publishedVersion: 1,
        versions: [version(1, "Restart tika first.", true), version(2, "Restart tika, then wait.", false)],
      },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(SESSION_QUERY_KEY, sessionFor("admin"));
    const router = createMemoryRouter([{ path: PATHS.runbook, element: <RunbookDetailPage /> }], {
      initialEntries: [apiPath(PATHS.runbook, { runbookId: "r1" })],
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(TEXT.runbooks.keptAsWritten)).toBeTruthy();
    const editor = screen.getByRole("textbox", { name: TEXT.runbooks.body }) as HTMLTextAreaElement;
    expect(editor.value).toBe("Restart tika, then wait.");
    fireEvent.click(screen.getByRole("button", { name: TEXT.runbooks.startFrom(1) }));
    expect(editor.value).toBe("Restart tika first.");
  });
});
