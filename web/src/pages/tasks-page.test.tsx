import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_ROUTES,
  apiPath,
  type ContainerView,
  type SessionView,
  type TaskDetailView,
  type TaskSummaryView,
} from "../../../src/shared/api.js";
import { PATHS, SESSION_QUERY_KEY, TEXT } from "../constants.js";
import { TasksPage } from "./tasks-page.js";

const session: SessionView = {
  user: { id: "u1", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};

const summary = (overrides: Partial<TaskSummaryView>): TaskSummaryView => ({
  id: "t1",
  number: 7,
  title: "Update whoami on Alder",
  status: "todo",
  priority: "low",
  source: "detector",
  assignee: { kind: "user", id: "u1", name: "admin" },
  labels: ["update"],
  hostId: "h1",
  hostLabel: "Alder",
  resource: { kind: "container", id: "whoami", label: "whoami" },
  parentId: null,
  occurrences: 1,
  checkedOut: false,
  advice: null,
  snoozedUntil: null,
  incidentId: null,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000,
  lastSeenAt: Date.now(),
  closedAt: null,
  ...overrides,
});

const whoami: ContainerView = {
  hostId: "h1",
  hostLabel: "Alder",
  hostState: "online",
  name: "whoami",
  containerId: "0123456789ab",
  image: "traefik/whoami:latest",
  state: "running",
  health: "none",
  startedAt: Date.now() - 3_600_000,
  finishedAt: null,
  exitCode: null,
  oomKilled: false,
  restartCount: 0,
  restartPolicy: "unless-stopped",
  composeProject: null,
  composeService: null,
  link: null,
  version: null,
  source: null,
  ports: null,
  hostNetwork: false,
  update: { status: "available", checkedAt: Date.now(), policy: "ask", remote: null, reason: null },
  usage: null,
  protected: false,
  byItself: { restart: "restart", update: "ask", restartLock: null, updateLock: null },
  handsOff: null,
  problem: null,
};

const detail = (overrides: Partial<TaskDetailView> = {}): TaskDetailView => ({
  ...summary({}),
  description: "A newer image is behind traefik/whoami:latest.",
  createdBy: "Autoheal",
  incidentId: null,
  comments: [
    {
      id: "c1",
      author: "Autoheal",
      fromAgent: true,
      body: "Going ahead: a web demo with no data.",
      createdAt: Date.now(),
    },
  ],
  activity: [{ id: 1, kind: "created", actor: "Autoheal", data: {}, createdAt: Date.now() - 60_000 }],
  subtasks: [],
  blockedBy: [],
  blocking: [],
  jobs: [],
  container: whoami,
  ...overrides,
});

function serve(routes: Record<string, unknown>) {
  const answers: Record<string, unknown> = { [API_ROUTES.session]: session, ...routes };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split("?")[0]!;
    const body =
      init?.method === "PATCH" || init?.method === "POST" ? (answers[`${init.method} ${path}`] ?? {}) : answers[path];
    return new Response(JSON.stringify(body ?? []), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function renderTasks(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(SESSION_QUERY_KEY, session);
  const router = createMemoryRouter(
    [
      { path: PATHS.tasks, element: <TasksPage /> },
      { path: PATHS.task, element: <TasksPage /> },
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

const calls = (fetch: ReturnType<typeof serve>, method: string) =>
  fetch.mock.calls
    .filter(([, init]) => init?.method === method)
    .map(([url, init]) => [url, JSON.parse(String(init?.body ?? "null"))]);

describe("the tasks page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens a task beside the board, with its container's update right there, and closes it on a second click", async () => {
    const taskPath = apiPath(API_ROUTES.task, { taskId: "t1" });
    const fetch = serve({
      [API_ROUTES.tasks]: [
        summary({}),
        summary({ id: "t2", number: 8, title: "Tidy the cables", labels: [], resource: null }),
      ],
      [taskPath]: detail(),
      [API_ROUTES.assignees]: { users: [{ id: "u1", name: "admin" }], agents: [{ id: "autoheal", name: "Autoheal" }] },
      [API_ROUTES.containers]: [whoami],
      [`PATCH ${taskPath}`]: detail({ status: "in_progress" }),
    });
    const router = renderTasks(PATHS.tasks);
    const card = (await screen.findByText("Update whoami on Alder")).closest("button")!;
    expect(card.closest("section")?.getAttribute("aria-label")).toBe("To do");
    fireEvent.click(card);
    expect(router.state.location.pathname).toBe(apiPath(PATHS.task, { taskId: "t1" }));

    const panel = await screen.findByRole("region", { name: "#7 Update whoami on Alder" });
    expect(within(panel).getByText("Going ahead: a web demo with no data.")).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Update now" })).toBeTruthy();
    expect(within(panel).getByRole("option", { name: "Autoheal" })).toBeTruthy();

    fireEvent.change(within(panel).getByLabelText("Status"), { target: { value: "in_progress" } });
    await screen.findByDisplayValue("In progress");
    expect(calls(fetch, "PATCH")).toEqual([[taskPath, { status: "in_progress" }]]);

    fireEvent.click(card);
    expect(router.state.location.pathname).toBe(PATHS.tasks);
    expect(screen.queryByRole("region", { name: "#7 Update whoami on Alder" })).toBeNull();
  });

  it("lets an admin say from the task what it waits on, and take that back", async () => {
    const taskPath = apiPath(API_ROUTES.task, { taskId: "t1" });
    const blockers = apiPath(API_ROUTES.taskBlockers, { taskId: "t1" });
    const blocker = apiPath(API_ROUTES.taskBlocker, { taskId: "t1", blockerId: "t2" });
    const cables = summary({ id: "t2", number: 8, title: "Tidy the cables", labels: [], resource: null });
    const fetch = serve({
      [API_ROUTES.tasks]: [summary({}), cables],
      [taskPath]: detail(),
      [API_ROUTES.assignees]: { users: [{ id: "u1", name: "admin" }], agents: [] },
      [API_ROUTES.containers]: [whoami],
      [`POST ${blockers}`]: detail({ blockedBy: [cables] }),
      [blocker]: detail(),
    });
    renderTasks(apiPath(PATHS.task, { taskId: "t1" }));
    const panel = await screen.findByRole("region", { name: "#7 Update whoami on Alder" });

    fireEvent.change(await within(panel).findByLabelText(TEXT.tasks.waitsOn), { target: { value: "t2" } });
    fireEvent.click(within(panel).getByRole("button", { name: TEXT.tasks.addBlocker }));
    await waitFor(() => expect(calls(fetch, "POST")).toContainEqual([blockers, { blockedById: "t2" }]));
    fireEvent.click(await within(panel).findByRole("button", { name: TEXT.tasks.stopWaiting(8) }));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([url, init]) => url === blocker && init?.method === "DELETE")).toBe(true),
    );
  });

  it("offers only what the host allows: a protected container's logs, and why nothing else", async () => {
    serve({
      [API_ROUTES.tasks]: [summary({})],
      [apiPath(API_ROUTES.task, { taskId: "t1" })]: detail({
        container: { ...whoami, protected: true, handsOff: "protected" },
      }),
      [API_ROUTES.assignees]: { users: [{ id: "u1", name: "admin" }], agents: [] },
    });
    renderTasks("/tasks/t1");
    const panel = await screen.findByRole("region", { name: "#7 Update whoami on Alder" });
    expect(within(panel).getByRole("button", { name: "Logs" })).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "Update now" })).toBeNull();
    expect(within(panel).getByText(/^Protected on Alder: Autoheal never changes it/)).toBeTruthy();
  });

  it("does not offer Autoheal a task it cannot do, and keeps the filter in the address", async () => {
    const taskPath = apiPath(API_ROUTES.task, { taskId: "t2" });
    const fetch = serve({
      [API_ROUTES.tasks]: [summary({ id: "t2", number: 8, title: "Tidy the cables", labels: [], resource: null })],
      [taskPath]: detail({
        id: "t2",
        number: 8,
        title: "Tidy the cables",
        labels: [],
        resource: null,
        container: null,
      }),
      [API_ROUTES.assignees]: { users: [{ id: "u1", name: "admin" }], agents: [{ id: "autoheal", name: "Autoheal" }] },
    });
    renderTasks(`/tasks/t2?show=mine`);
    const panel = await screen.findByRole("region", { name: "#8 Tidy the cables" });
    expect(within(panel).queryByRole("option", { name: "Autoheal" })).toBeNull();
    expect(screen.getByRole("button", { name: "Mine" }).getAttribute("aria-pressed")).toBe("true");
    const listed = fetch.mock.calls.map(([url]) => String(url)).find((url) => url.startsWith(`${API_ROUTES.tasks}?`))!;
    expect(new URLSearchParams(listed.split("?")[1])).toEqual(new URLSearchParams({ status: "open", assignee: "me" }));
  });
});
