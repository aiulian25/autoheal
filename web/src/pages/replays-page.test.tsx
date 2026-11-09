import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_ROUTES,
  apiPath,
  type OllamaSettingsView,
  type ReplayRunView,
  type SessionView,
} from "../../../src/shared/api.js";
import { PATHS, SESSION_QUERY_KEY } from "../constants.js";
import { ReplayDetailPage, ReplaysPage } from "./replays-page.js";

const session: SessionView = {
  user: { id: "u1", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};

const run = (overrides: Partial<ReplayRunView> = {}): ReplayRunView => ({
  id: "r1",
  status: "finished",
  createdBy: "admin",
  createdAt: Date.now(),
  finishedAt: Date.now(),
  modelName: "qwen3:30b-a3b",
  modelDigest: null,
  draftVersionIds: [],
  incidentCount: 5,
  changedCount: 1,
  results: [],
  ...overrides,
});

const environment = { url: "http://192.168.10.178:38271", model: "qwen3:4b-instruct", contextTokens: 16_384 };
const ollamaSettings: OllamaSettingsView = {
  source: "environment",
  ...environment,
  plainHttp: true,
  fromEnvironment: environment,
};

// GET answers by path, other methods by "METHOD path".
function serve(extra: Record<string, unknown> = {}) {
  const answers: Record<string, unknown> = {
    [API_ROUTES.session]: session,
    [API_ROUTES.replays]: [run()],
    [`POST ${API_ROUTES.replays}`]: run({ id: "r2", status: "running" }),
    [API_ROUTES.ollama]: {
      reachable: true,
      checkedAt: Date.now(),
      error: null,
      version: "0.12.6",
      model: "qwen3:4b-instruct",
      modelPresent: true,
      facts: null,
      models: [
        { name: "qwen3:4b-instruct", sizeBytes: 1, parameterSize: null, quantization: null },
        { name: "qwen3:30b-a3b", sizeBytes: 1, parameterSize: null, quantization: null },
      ],
      loaded: [],
    },
    [API_ROUTES.ollamaSettings]: ollamaSettings,
    [apiPath(API_ROUTES.replay, { replayId: "r1" })]: run(),
    ...extra,
  };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split("?")[0]!;
    const method = init?.method ?? "GET";
    const answer = method === "GET" ? answers[path] : answers[`${method} ${path}`];
    return new Response(answer === undefined ? null : JSON.stringify(answer), {
      status: answer === undefined && method !== "GET" ? 204 : 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function show(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(SESSION_QUERY_KEY, session);
  const router = createMemoryRouter(
    [
      { path: PATHS.replays, element: <ReplaysPage /> },
      { path: PATHS.replay, element: <ReplayDetailPage /> },
    ],
    { initialEntries: [path] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

// Long enough for every answer above to be shown.
const SETTLED_WITHIN_MILLISECONDS = 300;

const bodiesOf = (fetch: ReturnType<typeof serve>, method: string, path: string) =>
  fetch.mock.calls
    .filter(([url, init]) => url === path && init?.method === method)
    .map(([, init]) => JSON.parse(String(init?.body ?? "null")));

describe("trying a model before switching to it", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("replays recent incidents with another model of the same Ollama, and lists each run's model", async () => {
    const fetch = serve();
    const router = show(PATHS.replays);
    expect(await screen.findByText("qwen3:30b-a3b", { selector: "td" })).toBeTruthy();
    const model = (await screen.findByRole("combobox", { name: "Model" })) as HTMLSelectElement;
    await waitFor(() =>
      expect([...model.options].map((option) => option.text)).toContain("qwen3:4b-instruct (in use)"),
    );
    fireEvent.change(model, { target: { value: "qwen3:30b-a3b" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Recent incidents" }), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Replay" }));
    await waitFor(() =>
      expect(bodiesOf(fetch, "POST", API_ROUTES.replays)).toEqual([{ incidentCount: 5, modelName: "qwen3:30b-a3b" }]),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe(apiPath(PATHS.replay, { replayId: "r2" })));
  });

  it("uses the model a finished replay tried from now on, through the Ollama settings", async () => {
    const fetch = serve();
    show(apiPath(PATHS.replay, { replayId: "r1" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use qwen3:30b-a3b from now on" }));
    await waitFor(() =>
      expect(bodiesOf(fetch, "PUT", API_ROUTES.ollamaSettings)).toEqual([{ ...environment, model: "qwen3:30b-a3b" }]),
    );
  });

  it("says a host another Ollama watches replays on that one, and whose the other models are", async () => {
    serve({
      [API_ROUTES.ollamaServers]: {
        extras: [{ id: "s1", name: "Rowan", model: "qwen3:30b-a3b", hostIds: ["h1"] }],
        reviewServerId: null,
        defaultName: null,
        routerServerId: null,
      },
    });
    show(PATHS.replays);
    const model = (await screen.findByRole("combobox", { name: "Model" })) as HTMLSelectElement;
    await waitFor(() =>
      expect([...model.options].map((option) => option.text)).toEqual([
        "Each host's own Ollama and model (in use)",
        "qwen3:30b-a3b",
      ]),
    );
    expect(model.querySelector("optgroup")?.label).toBe("Other models on Default");
  });

  it("offers no switch for a run that several servers' models answered", async () => {
    serve({ [apiPath(API_ROUTES.replay, { replayId: "r1" })]: run({ modelName: "qwen3:4b-instruct, qwen3:30b-a3b" }) });
    show(apiPath(PATHS.replay, { replayId: "r1" }));
    expect(await screen.findByText(/qwen3:4b-instruct, qwen3:30b-a3b/)).toBeTruthy();
    await expect(
      screen.findByRole("button", { name: /from now on/ }, { timeout: SETTLED_WITHIN_MILLISECONDS }),
    ).rejects.toThrow();
  });
});
