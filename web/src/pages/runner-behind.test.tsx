import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath, type HostView, type SessionView } from "../../../src/shared/api.js";
import { JOB_ACTION, RUNNER_UPDATE_REPORT } from "../../../src/shared/constants.js";
import { RUNNER_UPDATE_COMMAND, SESSION_QUERY_KEY, TEXT } from "../constants.js";
import { timeAgo } from "../format.js";
import { settingsQuery } from "../queries.js";
import { RunnerBehind } from "./runner-behind.js";

const text = TEXT.ssh;
const sessionAs = (role: "admin" | "viewer"): SessionView => ({
  user: { id: "u1", username: "admin", role, mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
});
const host = (runnerVersion: string | null, runnerUpdate: HostView["runnerUpdate"]) =>
  ({ id: "h1", label: "Alder", kind: "runner", runnerVersion, runnerUpdate }) as HostView;

let client: QueryClient;
let sent: { url: string; body: unknown }[];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      // Only what the page sends; the session and settings it reads are already in hand.
      if ((options?.method ?? "GET") !== "GET") {
        sent.push({ url, body: options?.body === undefined ? null : JSON.parse(String(options.body)) });
      }
      return new Response(JSON.stringify({ id: "j1", status: "pending" }), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
});

function show(
  runnerVersion: string | null,
  role: "admin" | "viewer" = "admin",
  runnerUpdate: HostView["runnerUpdate"] = null,
) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  client.setQueryData(SESSION_QUERY_KEY, sessionAs(role));
  client.setQueryData(settingsQuery.queryKey, { version: "1.2.0+new" } as never);
  render(
    <QueryClientProvider client={client}>
      <RunnerBehind host={host(runnerVersion, runnerUpdate)} />
    </QueryClientProvider>,
  );
}

it("says the runner is behind and offers to update it from here, keeping the command for doing it by hand", () => {
  show("1.0.0+old");

  expect(screen.getByText(text.runnerBehind("1.0.0+old", "1.2.0+new"))).toBeTruthy();
  expect(screen.getByRole("button", { name: text.updateRunner })).toBeTruthy();
  expect(screen.getByText(RUNNER_UPDATE_COMMAND)).toBeTruthy();
});

it("asks that runner to update itself, naming no image, and says what happens next", async () => {
  show("1.0.0+old");

  fireEvent.click(screen.getByRole("button", { name: text.updateRunner }));

  await waitFor(() => expect(sent).toHaveLength(1));
  expect(sent[0]).toEqual({
    url: apiPath(API_ROUTES.hostActions, { hostId: "h1" }),
    body: { action: JOB_ACTION.updateRunner },
  });
  expect(await screen.findByText(text.updateRunnerAsked)).toBeTruthy();
  expect(screen.queryByRole("button", { name: text.updateRunner })).toBeNull();
});

it("offers the button to admins only; anyone still sees the runner is behind", () => {
  show("1.0.0+old", "viewer");

  expect(screen.getByText(text.runnerBehind("1.0.0+old", "1.2.0+new"))).toBeTruthy();
  expect(screen.queryByRole("button", { name: text.updateRunner })).toBeNull();
});

it("says nothing when the runner already runs Autoheal's release", () => {
  show("1.2.0+new");

  expect(screen.queryByRole("status")).toBeNull();
});

it("says why the runner's last update from here did not go through, and when, beside the button to try again", () => {
  const finishedAt = Date.now() - 5 * 60_000;
  const said = "The new version did not become healthy, so the old one was started again.";
  show("1.0.0+old", "admin", { state: RUNNER_UPDATE_REPORT.state.failed, finishedAt, message: said });

  expect(screen.getByText(text.runnerUpdateFailed(said))).toBeTruthy();
  expect(screen.getByText(timeAgo(finishedAt))).toBeTruthy();
  expect(screen.getByRole("button", { name: text.updateRunner })).toBeTruthy();
});

it("says an update is under way while its helper works, and nothing more of one that went through", () => {
  show("1.0.0+old", "admin", { state: RUNNER_UPDATE_REPORT.state.running, finishedAt: null, message: null });
  expect(screen.getByText(text.runnerUpdating)).toBeTruthy();
  cleanup();

  show("1.0.0+old", "admin", { state: RUNNER_UPDATE_REPORT.state.succeeded, finishedAt: 1, message: "Updated." });
  expect(screen.queryByText(text.runnerUpdating)).toBeNull();
  expect(screen.queryByText(/did not go through/)).toBeNull();
  expect(screen.queryByText("Updated.")).toBeNull();
});
