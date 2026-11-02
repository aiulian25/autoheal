import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_ROUTES,
  apiPath,
  type IncidentDetailView,
  type ReplayRunView,
  type RunbookView,
  type SessionView,
} from "../../../src/shared/api.js";
import { PATHS, SESSION_QUERY_KEY } from "../constants.js";
import { IncidentDetailPage } from "./incident-page.js";

const HOSTILE = '<script>alert("pwned")</script><img src=x onerror=alert(1)>';

const incident: IncidentDetailView = {
  id: "6f1c9a1e-0000-4000-8000-000000000000",
  hostId: "h1",
  hostLabel: "HP",
  containerName: "paperless",
  image: "paperless:2",
  trigger: "die",
  status: "awaiting_approval",
  decidedBy: "model",
  action: "escalate",
  target: "paperless",
  verdict: "needs you",
  detectedAt: Date.now(),
  updatedAt: Date.now(),
  diagnosis: `The model says: ${HOSTILE}`,
  outcome: "Needs you, nothing was changed.",
  promptHash: "a".repeat(64),
  modelName: "qwen3:4b-instruct",
  modelDigest: null,
  reasoning: null,
  report: {
    stateSummary: "status=exited",
    healthOutputs: [],
    knownContainers: ["paperless", "tika", "npm"],
    protectedContainers: ["npm"],
    logs: `GET /search?q=${HOSTILE}`,
    composeProject: null,
    neighbours: [],
  },
  trace: [{ id: 1, kind: "reported", payload: { host: "HP" }, createdAt: Date.now() }],
  approvals: [],
  earlier: [],
  evidence: [],
  usage: [],
};

const sessionFor = (role: "admin" | "viewer"): SessionView => ({
  user: { id: "u1", username: role, role, mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
});

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const version = (id: string, number: number, publishedAt: number | null) => ({
  id,
  version: number,
  body: "DRAFT RULE",
  contentHash: "c".repeat(64),
  createdBy: "admin",
  createdAt: 1,
  publishedAt,
});

// One runbook a person is still editing, one that is all published.
const runbooks: RunbookView[] = [
  {
    id: "r1",
    scope: "global",
    pattern: null,
    title: "Restart a crashed web app once",
    archived: false,
    createdAt: 1,
    publishedVersion: 2,
    versions: [version("v2", 2, 1), version("v3", 3, null)],
  },
  {
    id: "r2",
    scope: "global",
    pattern: null,
    title: "Never restart a database",
    archived: false,
    createdAt: 1,
    publishedVersion: 1,
    versions: [version("v1", 1, 1)],
  },
];

const started = { id: "replay-1" } as ReplayRunView;

// The incident by its path, the session, and no hosts or containers: what the page needs, nothing more.
function renderIncident(role: "admin" | "viewer", shown: IncidentDetailView = incident) {
  const answers: Record<string, unknown> = {
    [API_ROUTES.session]: sessionFor(role),
    [apiPath(API_ROUTES.incident, { incidentId: incident.id })]: shown,
    [API_ROUTES.runbooks]: runbooks,
  };
  const fetch = vi.fn(async (url: string, init?: RequestInit) =>
    json(init?.method === "POST" && url === API_ROUTES.replays ? started : (answers[url.split("?")[0]!] ?? [])),
  );
  vi.stubGlobal("fetch", fetch);
  const queryClient = new QueryClient();
  queryClient.setQueryData(SESSION_QUERY_KEY, sessionFor(role));
  const router = createMemoryRouter(
    [
      { path: PATHS.incident, element: <IncidentDetailPage /> },
      { path: PATHS.replay, element: <p>the replay</p> },
    ],
    { initialEntries: [`/incidents/${incident.id}`] },
  );
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...rendered, fetch, router };
}

describe("incident detail", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows log lines and the diagnosis as text, never as markup", async () => {
    const { container } = renderIncident("viewer");
    expect(await screen.findByText(`GET /search?q=${HOSTILE}`)).toBeTruthy();
    expect(screen.getByText(`The model says: ${HOSTILE}`)).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img[src=x]")).toBeNull();
  });

  it("shows how the model reasoned when asked, as text, and offers nothing where it did not think", async () => {
    const reasoning = `The logs show ${HOSTILE}`;
    const { container } = renderIncident("viewer", { ...incident, reasoning });
    const toggle = await screen.findByRole("button", { name: "See how the model reasoned" });
    expect(screen.queryByText(reasoning)).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Hide how the model reasoned");
    expect(screen.getByText(reasoning)).toBeTruthy();
    expect(screen.getByText(/may quote the container's log lines, which are untrusted/)).toBeTruthy();
    expect(container.querySelector("script")).toBeNull();
    cleanup();

    renderIncident("viewer");
    expect(await screen.findByRole("button", { name: "See the prompt and answer" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "See how the model reasoned" })).toBeNull();
  });

  it("lists the container's earlier incidents, leads to all of them, and shows what else the model was told", async () => {
    const earlier = { ...incident, id: "e1", verdict: "restarted", detectedAt: Date.now() - 86_400_000 };
    const evidence =
      "Earlier incidents of this container on this host, newest first:\n- 2026-10-20 11:59 UTC, die: restart";
    renderIncident("viewer", { ...incident, earlier: [earlier], evidence: [evidence] });
    const card = (await screen.findByRole("heading", { name: "Earlier incidents of this container" })).closest(
      "section",
    )!;
    expect(within(card).getByRole("link", { name: "restarted" }).getAttribute("href")).toBe("/incidents/e1");
    expect(within(card).getByRole("link", { name: "All incidents of paperless" }).getAttribute("href")).toBe(
      "/incidents?hostId=h1&containerName=paperless",
    );

    fireEvent.click(screen.getByRole("button", { name: "See the prompt and answer" }));
    const told = screen.getByRole("heading", { name: "Also given to the model" }).nextElementSibling;
    expect(told?.textContent).toBe(evidence);
    cleanup();

    renderIncident("viewer");
    await screen.findByRole("button", { name: "See the prompt and answer" });
    expect(screen.queryByRole("heading", { name: "Earlier incidents of this container" })).toBeNull();
  });

  it("charts the container's last half hour when it was measured, and leaves it out otherwise", async () => {
    const reading = (at: number, memoryPercent: number) => ({
      at,
      cpuPercent: 4,
      cpuLimitCores: null,
      throttledPercent: null,
      memoryBytes: 1_000_000,
      memoryPercent,
      memoryLimitBytes: 2_000_000,
      cacheBytes: 0,
      readBytesPerSecond: 0,
      writeBytesPerSecond: 0,
      receiveBytesPerSecond: null,
      transmitBytesPerSecond: null,
      droppedPackets: null,
      processes: null,
    });
    renderIncident("viewer", { ...incident, usage: [reading(1, 50), reading(2, 99)] });
    const usage = (await screen.findByRole("heading", { name: "Its last half hour before Autoheal looked" })).closest(
      "section",
    )!;
    expect(within(usage).getByText("Memory")).toBeTruthy();
    cleanup();

    renderIncident("viewer", { ...incident, usage: [reading(1, 50)] });
    await screen.findByRole("button", { name: "See the prompt and answer" });
    expect(screen.queryByRole("heading", { name: "Its last half hour before Autoheal looked" })).toBeNull();
  });

  it("shows the rest of its compose project in the whole report, and the last lines of one that was down", async () => {
    const neighbours = [
      { name: "paperless-db", status: "Exited (0) 12 minutes ago", logs: "database system is shut down" },
      { name: "paperless-redis", status: "Up 3 hours", logs: null },
    ];
    renderIncident("viewer", { ...incident, report: { ...incident.report!, composeProject: "paperless", neighbours } });
    fireEvent.click(await screen.findByRole("button", { name: "Read the whole report" }));
    expect(
      screen.getByRole("heading", { name: "The rest of its compose project, paperless, as Docker showed it" }),
    ).toBeTruthy();
    expect(screen.getByText("paperless-db").closest("li")?.textContent).toContain("Exited (0) 12 minutes ago");
    expect(screen.getByText("database system is shut down")).toBeTruthy();
    expect(screen.getByText("paperless-redis").closest("li")?.querySelector("pre")).toBeNull();
  });

  it("offers the decision only to admins, and never a protected container", async () => {
    renderIncident("viewer");
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("paperless on HP");
    expect(screen.queryByRole("button", { name: "Approve restart" })).toBeNull();
    cleanup();

    renderIncident("admin");
    expect(await screen.findByRole("button", { name: "Approve restart" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restart a dependency instead" }));
    const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(options).toEqual(["tika"]);
  });

  it("says what became of a person's restart that did not hold, while it waits for them again", async () => {
    const outcome = "Restarted paperless, but it stopped again (exit 1); escalating.";
    renderIncident("viewer", {
      ...incident,
      outcome,
      approvals: [{ id: "a1", choice: "restart", target: null, note: null, decidedBy: "admin", decidedAt: Date.now() }],
    });
    expect((await screen.findAllByText(outcome)).length).toBeGreaterThan(0);
    expect(screen.queryByText("Ollama found no safe fix, so it is yours to decide.")).toBeNull();
    expect(screen.getByRole("region", { name: "What happened, step by step" })).toBeTruthy();
  });

  it("shows Ollama's repair: while it looks into it, then what it found and how to fix it once the repair did not work", async () => {
    const restarted = { ...incident, action: "restart" as const };
    const looking = [
      ...incident.trace,
      { id: 2, kind: "repair_started", payload: { offered: ["recreate", "report"] }, createdAt: Date.now() },
    ];
    renderIncident("viewer", { ...restarted, status: "approved", trace: looking });
    expect(await screen.findByText("Ollama is looking into it")).toBeTruthy();
    expect(
      screen.getByText("A restart did not hold. It may recreate it from its settings or write you a report."),
    ).toBeTruthy();
    cleanup();

    const plan = { repair: "recreate", findings: "A stale pid file.", cause: "Killed mid-run.", jobId: "j1" };
    const steps = [`Remove /run/paperless.pid ${HOSTILE}`, "Start it again."];
    const { container } = renderIncident("viewer", {
      ...restarted,
      trace: [
        ...looking,
        { id: 3, kind: "repair_planned", payload: { ...plan, steps }, createdAt: Date.now() },
        {
          id: 4,
          kind: "repair_finished",
          payload: { succeeded: false, outcome: "Recreated paperless, but it exited with code 1." },
          createdAt: Date.now(),
        },
      ],
    });
    expect(await screen.findByText("Ollama's repair did not hold")).toBeTruthy();
    expect(screen.getByText("It chose to recreate it from its settings.")).toBeTruthy();
    expect(screen.getByText("Recreated paperless, but it exited with code 1.")).toBeTruthy();
    expect(screen.getByText("A stale pid file.")).toBeTruthy();
    expect(screen.getByText("Killed mid-run.")).toBeTruthy();
    const listed = [...container.querySelectorAll(".repair-steps li")].map((item) => item.textContent);
    expect(listed).toEqual(steps);
    expect(container.querySelector("script")).toBeNull();
  });

  it("replays this incident against a draft a person is still editing, and opens the replay", async () => {
    const { fetch, router } = renderIncident("admin");
    fireEvent.click(await screen.findByRole("button", { name: "Replay against a draft" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Replay with Restart a crashed web app once, draft version 3" }),
    );
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        API_ROUTES.replays,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ draftVersionIds: ["v3"], incidentIds: [incident.id] }),
        }),
      ),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/replays/replay-1"));
    expect(screen.queryByRole("button", { name: /Never restart a database/ })).toBeNull();
  });
});
