import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ContainerView, SessionView } from "../../../src/shared/api.js";
import { API_ROUTES, apiPath } from "../../../src/shared/api.js";
import type { ResourcePermissionsView } from "../../../src/shared/resource-permissions.js";
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
  user: { id: "user", username: "operator", role: "viewer", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};
let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
});
function show(initial: ResourcePermissionsView, admin = false, target = container) {
  let permissions = initial;
  let failure = false;
  const fetch = vi.fn(async (path: string) => {
    if (path === API_ROUTES.accountPermissions)
      return new Response(JSON.stringify(failure ? { error: "not_signed_in" } : permissions), {
        status: failure ? 401 : 200,
        headers: { "content-type": "application/json" },
      });
    return new Response("[]", { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(SESSION_QUERY_KEY, admin ? { ...session, user: { ...session.user, role: "admin" } } : session);
  render(
    <QueryClientProvider client={client}>
      <ContainerActions container={target} parked={false} canAct={admin} />
    </QueryClientProvider>,
  );
  return {
    fetch,
    replace: (view: ResourcePermissionsView) => {
      permissions = view;
      return client.invalidateQueries({ queryKey: ["resource-permissions"] });
    },
    fail: () => {
      failure = true;
      return client.invalidateQueries({ queryKey: ["resource-permissions"] });
    },
  };
}
it("shows only explicitly granted actions for the matching host and stack", async () => {
  show({ revision: 1, grants: [{ hostId: HOST, scope: "stack", resource: "app", actions: ["update", "logs"] }] });
  expect(await screen.findByRole("button", { name: TEXT.actions.names.logs })).toBeTruthy();
  expect(screen.getByRole("button", { name: TEXT.actions.names.update })).toBeTruthy();
  expect(screen.queryByRole("button", { name: TEXT.actions.names.restart })).toBeNull();
  expect(screen.queryByRole("button", { name: TEXT.actions.names.stop })).toBeNull();
});
it("does not turn viewing access into log access or grant actions on another host", async () => {
  const view: ResourcePermissionsView = {
    revision: 1,
    grants: [{ hostId: HOST, scope: "container", resource: "database", actions: ["logs"] }],
  };
  const state = show(view, false, { ...container, hostId: "different-host" });
  await waitFor(() => expect(state.fetch).toHaveBeenCalledWith(API_ROUTES.accountPermissions, expect.anything()));
  expect(screen.queryByRole("button", { name: TEXT.actions.names.logs })).toBeNull();
});
it("removes cached delegated actions after a failed refresh or grant revocation", async () => {
  const state = show({
    revision: 1,
    grants: [{ hostId: HOST, scope: "container", resource: "database", actions: ["logs"] }],
  });
  await screen.findByRole("button", { name: TEXT.actions.names.logs });
  await state.replace({ revision: 2, grants: [] });
  await waitFor(() => expect(screen.queryByRole("button", { name: TEXT.actions.names.logs })).toBeNull());
  await state.replace({
    revision: 3,
    grants: [{ hostId: HOST, scope: "container", resource: "database", actions: ["logs"] }],
  });
  await screen.findByRole("button", { name: TEXT.actions.names.logs });
  await state.fail();
  await waitFor(() => expect(screen.queryByRole("button", { name: TEXT.actions.names.logs })).toBeNull());
});
it("preserves administrator controls without requesting delegated grants", async () => {
  const state = show({ revision: 0, grants: [] }, true);
  expect(screen.getByRole("button", { name: TEXT.actions.names.restart })).toBeTruthy();
  expect(state.fetch.mock.calls.some(([path]) => path === API_ROUTES.accountPermissions)).toBe(false);
});
it("asks once before a stop where this browser is set to, and sends it only on yes", async () => {
  const actionPath = apiPath(API_ROUTES.containerActions, { hostId: HOST, containerName: container.name });
  const answers = [false, true];
  const confirm = vi.fn<(question: string) => boolean>(() => answers.shift() ?? false);
  vi.stubGlobal("confirm", confirm);
  window.localStorage.setItem(ASK_FIRST_STORAGE_KEY, ASK_FIRST_ON);
  try {
    const state = show({ revision: 0, grants: [] }, true);
    const asked = (action: string) => expect.objectContaining({ method: "POST", body: JSON.stringify({ action }) });

    fireEvent.click(screen.getByRole("button", { name: TEXT.actions.names.stop }));
    expect(confirm).toHaveBeenLastCalledWith("Stop database?");
    expect(state.fetch).not.toHaveBeenCalledWith(actionPath, asked("stop"));
    fireEvent.click(screen.getByRole("button", { name: TEXT.actions.names.stop }));
    await waitFor(() => expect(state.fetch).toHaveBeenCalledWith(actionPath, asked("stop")));

    // A restart never asks.
    const restart = screen.getByRole("button", { name: TEXT.actions.names.restart }) as HTMLButtonElement;
    await waitFor(() => expect(restart.disabled).toBe(false));
    fireEvent.click(restart);
    await waitFor(() => expect(state.fetch).toHaveBeenCalledWith(actionPath, asked("restart")));
    expect(confirm).toHaveBeenCalledTimes(2);
    // The no sent nothing, then or later: the stop and the restart are all it asked.
    expect(state.fetch.mock.calls.filter(([path]) => path === actionPath)).toHaveLength(2);
  } finally {
    window.localStorage.removeItem(ASK_FIRST_STORAGE_KEY);
  }
});
