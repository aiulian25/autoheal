import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath, type HostView, type JobView, type TaskSummaryView } from "../../../src/shared/api.js";
import { PATHS, TEXT } from "../constants.js";
import { HostContainers } from "./host-containers.js";
import { HostUpdates } from "../pages/host-updates.js";
import { NO_LOCKS, alder, container, CONTAINERS, serve, show, sent } from "../test-support/host-table.js";

// The terminal draws on a canvas jsdom lacks: in its place, what the row shows of it and its close button.
vi.mock("./shell-terminal.js", () => ({
  ContainerTerminal: ({ containerName, onClose }: { containerName: string; onClose: () => void }) => (
    <button type="button" onClick={onClose}>
      {`Close the shell in ${containerName}`}
    </button>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a newer version of a container's tag", () => {
  it("says so in the Image column, where an up-to-date tag would, leading to the host's updates", async () => {
    const current = { status: "current" as const, checkedAt: 1, policy: "ask" as const, remote: null, reason: null };
    serve({
      [API_ROUTES.containers]: [
        container({ name: "notes", composeProject: null, update: { ...current, newerTag: "3.4.2" } }),
        container({ name: "wiki", composeProject: null, update: current }),
      ],
    });
    show(<HostContainers host={alder(false)} admin />);
    const notes = (await screen.findByRole("button", { name: "notes" })).closest("tr")!;
    const wiki = screen.getByRole("button", { name: "wiki" }).closest("tr")!;

    expect(within(notes).getByRole("link", { name: "3.4.2 out" }).getAttribute("href")).toBe("#updates");
    expect(within(wiki).getByText(TEXT.hostContainers.upToDate)).toBeTruthy();
  });
});

describe("a host's containers and what each does", () => {
  it("leads to the Updates for a container whose new image waits", async () => {
    serve({ [API_ROUTES.containers]: CONTAINERS });
    show(<HostContainers host={alder(false)} admin />);

    const bento = (await screen.findByRole("button", { name: "BentoPDF" })).closest("tr")!;
    expect(within(bento).getByRole("link", { name: "update ready" }).getAttribute("href")).toBe("#updates");
  });
  it("says why a new image cannot be applied on a host that only watches, and offers no way that fails", async () => {
    const waiting = container({
      name: "BentoPDF",
      handsOff: "dry_run",
      update: { status: "available", checkedAt: 1, policy: "ask", remote: null, reason: null },
    });
    serve({ [API_ROUTES.containers]: [waiting] });
    show(<HostContainers host={alder(true)} admin />);

    const bento = (await screen.findByRole("button", { name: "BentoPDF" })).closest("tr")!;
    expect(within(bento).getByText("update ready")).toBeTruthy();
    expect(within(bento).getByText("host only watches")).toBeTruthy();
    expect(within(bento).queryByRole("link", { name: "update ready" })).toBeNull();
    expect(within(bento).queryByRole("button", { name: "Update BentoPDF" })).toBeNull();
  });
  it("does not call images up to date in Updates when a host that only watches has a new one", async () => {
    const waiting = container({
      name: "BentoPDF",
      handsOff: "dry_run",
      update: { status: "available", checkedAt: 1, policy: "ask", remote: null, reason: null },
    });
    serve({ [API_ROUTES.containers]: [waiting] });
    // No packages reported: this is about the images card alone.
    show(<HostUpdates host={{ ...alder(true), health: {} as HostView["health"] }} admin />);

    expect(await screen.findByRole("heading", { name: "Container images" })).toBeTruthy();
    expect(
      await screen.findByText(
        "1 new image is out, but this host only watches. Set DRY_RUN=0 on it to update from here.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Every image here is up to date.")).toBeNull();
  });
  it("says a new image Autoheal applies comes shortly, unless it waits for a person: then it leads to that task", async () => {
    const available = {
      status: "available" as const,
      checkedAt: 1,
      policy: "auto" as const,
      remote: null,
      reason: null,
    };
    const held: TaskSummaryView = {
      id: "t59",
      number: 59,
      title: "Update radicale on Alder",
      status: "todo",
      priority: "low",
      source: "detector",
      assignee: { kind: "user", id: "u1", name: "admin" },
      labels: ["update"],
      hostId: "h1",
      hostLabel: "Alder",
      resource: { kind: "container", id: "radicale", label: "radicale" },
      parentId: null,
      occurrences: 1,
      checkedOut: false,
      advice: "hold",
      snoozedUntil: null,
      incidentId: null,
      createdAt: 1,
      updatedAt: 1,
      lastSeenAt: 1,
      closedAt: null,
    };
    serve({
      [API_ROUTES.containers]: [
        container({
          name: "radicale",
          update: available,
          byItself: { restart: "restart", update: "apply", ...NO_LOCKS },
        }),
        container({
          name: "whoami",
          update: { ...available, policy: "always" },
          byItself: { restart: "repair", update: "always", ...NO_LOCKS },
        }),
      ],
      [API_ROUTES.tasks]: [held],
    });
    show(<HostContainers host={alder(false)} admin />);

    const radicale = (await screen.findByRole("button", { name: "radicale" })).closest("tr")!;
    const link = await within(radicale).findByRole("link", { name: "held for you" });
    expect(link.getAttribute("href")).toBe(apiPath(PATHS.task, { taskId: "t59" }));
    const whoami = screen.getByRole("button", { name: "whoami" }).closest("tr")!;
    expect(within(whoami).getByText("updating shortly")).toBeTruthy();
  });
  it("says why a container's image could not be checked", async () => {
    serve({
      [API_ROUTES.containers]: [
        container({
          update: {
            status: "unknown",
            checkedAt: 1,
            policy: "ask",
            remote: null,
            reason: "not public on Docker Hub: private, or built on this host",
          },
        }),
      ],
    });
    show(<HostContainers host={alder(false)} admin />);

    const attic = (await screen.findByRole("button", { name: "attic" })).closest("tr")!;
    expect(within(attic).getByText("could not check")).toBeTruthy();
    expect(within(attic).getByText("not public on Docker Hub: private, or built on this host")).toBeTruthy();
  });
  it("shows what each row's job is doing, an update's pull under its row, and each kind of container apart", async () => {
    const job = (overrides: Partial<JobView>): JobView => ({
      id: "j1",
      hostId: "h1",
      hostLabel: "Alder",
      containerName: "attic",
      action: "restart",
      status: "pending",
      requestedBy: "admin",
      taskId: null,
      createdAt: Date.now(),
      completedAt: null,
      outcome: null,
      output: null,
      recoveryBackupId: null,
      packages: [],
      progress: null,
      stack: null,
      ...overrides,
    });
    const pulling = job({
      id: "j2",
      containerName: "BentoPDF",
      action: "update",
      status: "delivered",
      progress: {
        phase: "pulling",
        layers: [
          { id: "4f4fb700ef54", state: "downloading", current: 50_000_000, total: 100_000_000 },
          { id: "1a2b3c4d5e6f", state: "present", current: 0, total: null },
        ],
        downloaded: 50_000_000,
        total: 100_000_000,
        bytesPerSecond: 10_000_000,
        log: ["4f4fb700ef54: Downloading [====>] 50MB/100MB"],
      },
    });
    serve({ [API_ROUTES.containers]: CONTAINERS, [API_ROUTES.jobs]: [pulling, job({})] });
    show(<HostContainers host={alder(false)} admin />);

    const attic = (await screen.findByRole("button", { name: "attic" })).closest("tr")!;
    expect(await within(attic).findByText("restarting…")).toBeTruthy();
    expect(attic.getAttribute("aria-busy")).toBe("true");
    const bento = screen.getByRole("button", { name: "BentoPDF" }).closest("tr")!;
    expect(within(bento).getByText("pulling 50%")).toBeTruthy();

    const stream = screen.getByRole("region", { name: "How the update of BentoPDF goes" });
    expect(within(stream).getByText("pulling the new image")).toBeTruthy();
    for (const fact of ["10 MB/s", "50 MB of 100 MB", "5 seconds left", "1 of 2 layers"]) {
      expect(within(stream).getByText(fact)).toBeTruthy();
    }
    fireEvent.click(within(stream).getByRole("button", { name: "Show details" }));
    const layers = within(stream).getAllByRole("listitem");
    expect(layers.slice(0, 2).map((layer) => layer.textContent)).toEqual([
      "4f4fb700ef54100 MBdownloading 50%",
      "1a2b3c4d5e6falready here",
    ]);
    expect(within(stream).getByText("4f4fb700ef54: Downloading [====>] 50MB/100MB")).toBeTruthy();

    // Each kind with how many it holds; one with none is not offered.
    const kinds = screen.getByRole("group", { name: "Show containers" });
    expect(
      within(kinds)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["All 4", "Running 4", "Update ready 1", "In progress 2", "Networks 0", "Volumes 0"]);
    fireEvent.click(within(kinds).getByRole("button", { name: "In progress 2" }));
    expect(screen.queryByRole("button", { name: "attic-postgres" })).toBeNull();
    expect(screen.getByRole("button", { name: "attic" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "BentoPDF" })).toBeTruthy();
  });
});

it("shows a stack's recreate in one line under its stack, keeps its rows, then says how it went", async () => {
  const stackJob = (overrides: Partial<JobView>): JobView => ({
    id: "s1",
    hostId: "h1",
    hostLabel: "Alder",
    containerName: "",
    action: "stack_up",
    status: "delivered",
    requestedBy: "admin",
    taskId: null,
    createdAt: Date.now(),
    completedAt: null,
    outcome: null,
    output: null,
    recoveryBackupId: null,
    packages: [],
    progress: { phase: "recreating", layers: [], downloaded: 0, total: null, bytesPerSecond: null, log: [] },
    stack: "attic",
    ...overrides,
  });
  const routes: Record<string, unknown> = {
    [API_ROUTES.containers]: CONTAINERS,
    [API_ROUTES.jobs]: [stackJob({})],
  };
  serve(routes);
  const client = show(<HostContainers host={alder(false)} admin />);

  const attic = (await screen.findByRole("button", { name: "attic" })).closest("tr")!;
  const database = screen.getByRole("button", { name: "attic-postgres" }).closest("tr")!;
  expect(within(attic).getByText("recreating from its Compose file")).toBeTruthy();
  expect(within(database).getByText("recreating from its Compose file")).toBeTruthy();
  expect(attic.getAttribute("aria-busy")).toBe("true");
  // One line for the stack, not one under each of its containers.
  const lines = screen.getAllByRole("region", { name: /How the update of/ });
  expect(lines).toHaveLength(1);
  expect(within(lines[0]!).getByText("recreating from its Compose file")).toBeTruthy();

  routes[API_ROUTES.jobs] = [
    stackJob({ status: "succeeded", progress: null, completedAt: Date.now(), outcome: "attic is up." }),
  ];
  await act(() => client.invalidateQueries());
  expect(await screen.findByText("recreated")).toBeTruthy();
  expect(screen.getByText("attic is up.")).toBeTruthy();
  expect(screen.queryByRole("region", { name: /How the update of/ })).toBeNull();
});

it("offers confirmed rollback recovery without a parked row and hides unsafe starts", async () => {
  const recovering = container({ name: "attic", state: "exited", recovery: { owner: "attic" } });
  const path = apiPath(API_ROUTES.containerActions, { hostId: "h1", containerName: "attic" });
  const fetch = serve({
    [API_ROUTES.containers]: [recovering],
    [`POST ${path}`]: { id: "recovery-job", status: "pending" },
    [`POST ${apiPath(API_ROUTES.operationPreview, { hostId: "h1", containerName: "attic" })}`]: {
      id: "review-rollback",
      hostId: "h1",
      containerName: "attic",
      action: "roll_back",
      expiresAt: Date.now() + 60_000,
      answer: {
        ok: true,
        fingerprint: "a".repeat(64),
        members: [{ name: "attic", protected: false }],
        resources: [],
        refusals: [],
      },
    },
  });
  show(<HostContainers host={alder(false)} admin />);
  const resume = await screen.findByRole("button", {
    name: TEXT.hostContainers.rowAction(TEXT.actions.names.roll_back, "attic"),
  });
  expect(
    screen.queryByRole("button", { name: TEXT.hostContainers.rowAction(TEXT.actions.names.start, "attic") }),
  ).toBeNull();
  expect(screen.getByText(TEXT.actions.recovery("attic"))).toBeTruthy();
  fireEvent.click(resume);
  fireEvent.click(
    within(screen.getByRole("group", { name: TEXT.actions.confirmRollBack("attic") })).getByRole("button", {
      name: TEXT.yes,
    }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Confirm reviewed operation" }));
  await sent(fetch, path, "POST", { action: "roll_back", previewId: "review-rollback" });
});

describe("a row's update icon", () => {
  const BOX = TEXT.hostContainers.updateBox;
  const ICON = BOX.icon("BentoPDF");
  const reviewPath = apiPath(API_ROUTES.operationPreview, { hostId: "h1", containerName: "BentoPDF" });
  const review = (answer: object) => ({
    id: "review-update",
    hostId: "h1",
    containerName: "BentoPDF",
    action: "update",
    expiresAt: Date.now() + 60_000,
    answer: { ok: true, fingerprint: "a".repeat(64), members: [], resources: [], refusals: [], ...answer },
  });
  const members = (...names: string[]) => names.map((name) => ({ name, protected: false }));

  it("shows beside the name only where there is an update, and nothing goes out before the box's Update", async () => {
    const fetch = serve({
      [API_ROUTES.containers]: CONTAINERS,
      [`POST ${reviewPath}`]: review({ members: members("BentoPDF", "attic") }),
      [`POST ${apiPath(API_ROUTES.containerUpdates, { hostId: "h1" })}`]: null,
    });
    show(<HostContainers host={alder(false)} admin />);
    const icon = await screen.findByRole("button", { name: ICON });
    expect(icon.closest(".name-cell")).toBeTruthy();
    for (const other of ["attic", "attic-postgres", "autoheal"]) {
      expect(screen.queryByRole("button", { name: BOX.icon(other) })).toBeNull();
    }

    fireEvent.click(icon);
    const box = await screen.findByRole("dialog", { name: BOX.title("BentoPDF") });
    expect(await within(box).findByText(BOX.alsoHeld("attic"))).toBeTruthy();
    const updates = apiPath(API_ROUTES.containerUpdates, { hostId: "h1" });
    expect(fetch).not.toHaveBeenCalledWith(updates, expect.objectContaining({ method: "POST" }));

    fireEvent.click(within(box).getByRole("button", { name: BOX.confirm }));
    await sent(fetch, updates, "POST", {
      names: ["BentoPDF"],
      previews: { BentoPDF: "review-update" },
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps Update off while the host checks, and says why it refuses", async () => {
    serve({
      [API_ROUTES.containers]: CONTAINERS,
      [`POST ${reviewPath}`]: review({ refusals: ["BentoPDF is kept hands-off."] }),
    });
    show(<HostContainers host={alder(false)} admin />);
    fireEvent.click(await screen.findByRole("button", { name: ICON }));
    const box = await screen.findByRole("dialog");
    const update = within(box).getByRole("button", { name: BOX.confirm }) as HTMLButtonElement;
    expect(update.disabled).toBe(true);
    expect(await within(box).findByText("BentoPDF is kept hands-off.")).toBeTruthy();
    expect(update.disabled).toBe(true);
  });

  it.each([
    ["Cancel", () => fireEvent.click(screen.getByRole("button", { name: BOX.cancel }))],
    ["Escape", () => fireEvent.keyDown(document, { key: "Escape" })],
    ["a click elsewhere", () => fireEvent.mouseDown(document.body)],
  ])("closes on %s, sending nothing", async (_how, close) => {
    const fetch = serve({
      [API_ROUTES.containers]: CONTAINERS,
      [`POST ${reviewPath}`]: review({ members: members("BentoPDF") }),
    });
    show(<HostContainers host={alder(false)} admin />);
    fireEvent.click(await screen.findByRole("button", { name: ICON }));
    await screen.findByRole("dialog");
    close();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetch).not.toHaveBeenCalledWith(
      apiPath(API_ROUTES.containerUpdates, { hostId: "h1" }),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("is not there for a container Autoheal may not touch", async () => {
    serve({
      [API_ROUTES.containers]: [
        container({
          name: "kept",
          handsOff: "protected",
          update: { status: "available", checkedAt: 1, policy: "ask", remote: null, reason: null },
        }),
      ],
    });
    show(<HostContainers host={alder(false)} admin />);
    await screen.findByRole("button", { name: "kept" });
    expect(screen.queryByRole("button", { name: BOX.icon("kept") })).toBeNull();
  });

  it("names the versions in the status column when the images say them", async () => {
    serve({
      [API_ROUTES.containers]: [
        container({
          name: "BentoPDF",
          version: "1.7.0",
          update: {
            status: "available",
            checkedAt: 1,
            policy: "ask",
            remote: { version: "1.8.0" } as never,
            reason: null,
          },
        }),
      ],
    });
    show(<HostContainers host={alder(false)} admin />);
    expect(await screen.findByRole("link", { name: "1.7.0 → 1.8.0" })).toBeTruthy();
  });
});
