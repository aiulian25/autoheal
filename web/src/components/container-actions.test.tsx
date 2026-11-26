import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ContainerView, SessionView } from "../../../src/shared/api.js";
import { API_ROUTES, apiPath } from "../../../src/shared/api.js";
import { ASK_FIRST_ON, ASK_FIRST_STORAGE_KEY, SESSION_QUERY_KEY, TEXT } from "../constants.js";
import { ContainerActions } from "./container-actions.js";
const HOST = "66cc4c4e-efb1-4a02-9e0b-f9ba7c2e7b92";
const container: ContainerView = {
  hostId: HOST,
  hostLabel: "Lab",
  hostState: "online",
  name: "database",
  containerId: "0123456789ab",
  image: "postgres:16",
  state: "running",
  health: "healthy",
  startedAt: Date.now(),
  finishedAt: null,
  exitCode: null,
  oomKilled: false,
  restartCount: 0,
  restartPolicy: "unless-stopped",
  composeProject: "app",
  composeService: "db",
  link: null,
  version: null,
  source: null,
  ports: null,
  hostNetwork: false,
  update: { status: "available", checkedAt: 1, policy: "ask", remote: null, reason: null },
  usage: null,
  byItself: { restart: "ask", update: "ask", restartLock: null, updateLock: null },
  protected: false,
  handsOff: null,
  problem: null,
};
const session: SessionView = {
  user: { id: "user", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};
let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
});
// What the row offers: everything to its owner, nothing where nobody may act.
function show(canAct = true, target = container) {
  const fetch = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(
    async () => new Response("[]", { headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetch);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(SESSION_QUERY_KEY, session);
  render(
    <QueryClientProvider client={client}>
      <ContainerActions container={target} parked={false} canAct={canAct} />
    </QueryClientProvider>,
  );
  return { fetch };
}
it("offers its owner the container's actions", async () => {
  show();
  expect(screen.getByRole("button", { name: TEXT.actions.names.restart })).toBeTruthy();
  expect(screen.getByRole("button", { name: TEXT.actions.names.logs })).toBeTruthy();
});
it("offers nothing where nobody may act", async () => {
  show(false);
  expect(screen.queryAllByRole("button")).toEqual([]);
});
it("stops a container Docker keeps starting again where it would start a stopped one, in its row and in its panel", async () => {
  const names = TEXT.actions.names;
  const offered = (name: string) => screen.queryByRole("button", { name }) !== null;
  const looping: ContainerView = {
    ...container,
    state: "restarting",
    update: { ...container.update, status: "current" },
  };

  show(true, looping);
  expect([names.stop, names.remove, names.logs].map(offered)).toEqual([true, true, true]);
  expect([names.start, names.restart].map(offered)).toEqual([false, false]);
  cleanup();

  show(true, { ...looping, state: "exited" });
  expect([names.start, names.stop].map(offered)).toEqual([true, false]);
  cleanup();

  render(
    <QueryClientProvider client={client}>
      <ContainerActions container={looping} parked={false} canAct tools={<span />} />
    </QueryClientProvider>,
  );
  expect([names.stop, names.restart, names.remove].map(offered)).toEqual([true, true, true]);
  expect([names.start, names.pause, names.unpause].map(offered)).toEqual([false, false, false]);
});
it("asks before removing it, wherever this browser is set to ask or not, and removes it only on yes", async () => {
  const actionPath = apiPath(API_ROUTES.containerActions, { hostId: HOST, containerName: container.name });
  const answer = (said: string) =>
    fireEvent.click(
      within(screen.getByRole("group", { name: "Remove database? Volumes are kept." })).getByRole("button", {
        name: said,
      }),
    );
  const state = show(true, { ...container, state: "exited" });
  const removed = expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "remove" }) });

  fireEvent.click(screen.getByRole("button", { name: TEXT.actions.names.remove }));
  answer(TEXT.no);
  expect(state.fetch).not.toHaveBeenCalledWith(actionPath, removed);
  fireEvent.click(screen.getByRole("button", { name: TEXT.actions.names.remove }));
  answer(TEXT.yes);
  await waitFor(() => expect(state.fetch).toHaveBeenCalledWith(actionPath, removed));
});
it("asks once before a stop where this browser is set to, and sends it only on yes", async () => {
  const actionPath = apiPath(API_ROUTES.containerActions, { hostId: HOST, containerName: container.name });
  const answer = (said: string) =>
    fireEvent.click(within(screen.getByRole("group", { name: "Stop database?" })).getByRole("button", { name: said }));
  window.localStorage.setItem(ASK_FIRST_STORAGE_KEY, ASK_FIRST_ON);
  try {
    const state = show();
    const asked = (action: string) => expect.objectContaining({ method: "POST", body: JSON.stringify({ action }) });

    fireEvent.click(screen.getByRole("button", { name: TEXT.actions.names.stop }));
    answer(TEXT.no);
    expect(state.fetch).not.toHaveBeenCalledWith(actionPath, asked("stop"));
    fireEvent.click(screen.getByRole("button", { name: TEXT.actions.names.stop }));
    answer(TEXT.yes);
    await waitFor(() => expect(state.fetch).toHaveBeenCalledWith(actionPath, asked("stop")));

    // A restart never asks.
    const restart = screen.getByRole("button", { name: TEXT.actions.names.restart }) as HTMLButtonElement;
    await waitFor(() => expect(restart.disabled).toBe(false));
    fireEvent.click(restart);
    expect(screen.queryByRole("group", { name: /^Restart/ })).toBeNull();
    await waitFor(() => expect(state.fetch).toHaveBeenCalledWith(actionPath, asked("restart")));
    // The no sent nothing, then or later: the stop and the restart are all it asked.
    expect(state.fetch.mock.calls.filter(([path]) => path === actionPath)).toHaveLength(2);
  } finally {
    window.localStorage.removeItem(ASK_FIRST_STORAGE_KEY);
  }
});
