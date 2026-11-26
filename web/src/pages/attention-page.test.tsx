import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_ROUTES,
  apiPath,
  type HostView,
  type IncidentSummaryView,
  type JobView,
  type TaskSummaryView,
} from "../../../src/shared/api.js";
import { TASK_ABOUT, TASK_TEXT, type TaskAbout } from "../../../src/shared/constants.js";
import { TEXT } from "../constants.js";
import {
  alder,
  diskNearlyFull,
  waitingImage,
  QUANTUM,
  board,
  RUNS,
  handedOver,
  heldPackages,
  needsYou,
  serve,
  renderAttention,
  TIKA,
} from "../test-support/attention-page.js";

describe("updates on the attention page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows Ollama's word on each update, and applies the ticked ones one at a time", async () => {
    const fetch = serve("admin");
    renderAttention("admin");

    const quantum = await screen.findByRole("checkbox", { name: "Update quantum" });
    const group = quantum.closest("details")!;
    const radicale = within(group).getByRole("checkbox", { name: "Update radicale" });
    expect((quantum as HTMLInputElement).checked).toBe(false);
    expect(within(quantum.closest("li")!).getByText("Ollama: safe to apply")).toBeTruthy();
    expect(within(radicale.closest("li")!).getByText("Ollama: hold it for you")).toBeTruthy();
    expect(within(group).getByText("One at a time. If one fails to come back healthy, the rest wait.")).toBeTruthy();

    fireEvent.click(quantum);
    fireEvent.click(within(group).getByRole("button", { name: "Update 1 container now" }));
    expect(fetch.mock.calls.some(([url, options]) => url === RUNS && options?.method === "POST")).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm reviewed operation" }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        RUNS,
        expect.objectContaining({
          method: "POST",
          body: '{"names":["quantum"],"previews":{"quantum":"review-quantum"}}',
        }),
      ),
    );
    expect(await within(group).findByText("Updating quantum, 1 of 1…")).toBeTruthy();
    expect(within(quantum.closest("li")!).getByText("updating now…")).toBeTruthy();
    expect((radicale as HTMLInputElement).disabled).toBe(true);
  });

  it("lists only the updates their host still has waiting: one applied by hand meanwhile is no history to nag about", async () => {
    serve(
      "admin",
      board,
      { homeAssistant: null },
      { packages: [], automatic: [] },
      {
        [API_ROUTES.containers]: [
          QUANTUM,
          waitingImage("radicale", {
            update: { status: "current", checkedAt: Date.now(), policy: "ask", remote: null, reason: null },
          }),
        ],
      },
    );
    renderAttention("admin");

    expect(await screen.findByRole("checkbox", { name: "Update quantum" })).toBeTruthy();
    expect(screen.queryByText("radicale")).toBeNull();
    expect(screen.getByRole("button", { name: "Select all (1)" })).toBeTruthy();
  });

  it("says what each update brings where its images say, and what updating does where they do not", async () => {
    serve("admin");
    renderAttention("admin");

    const quantum = (await screen.findByRole("checkbox", { name: "Update quantum" })).closest("li")!;
    expect(await within(quantum).findByText("v1.120.1 → v1.120.2")).toBeTruthy();
    expect(within(quantum).getByText("3 days ago")).toBeTruthy();
    expect(within(quantum).getByRole("link", { name: "release notes" }).getAttribute("href")).toBe(
      "https://github.com/example/quantum/releases?q=1.120.2",
    );
    const radicale = screen.getByRole("checkbox", { name: "Update radicale" }).closest("li")!;
    expect(within(radicale).getByText("Container image · recreated with its settings and volumes")).toBeTruthy();
  });

  it("lists Home Assistant's own updates with the rest, to install there", async () => {
    serve("admin", board, {
      homeAssistant: {
        connected: true,
        system: {
          updates: [
            {
              title: "Home Assistant Core",
              installed: "2026.10.2",
              latest: "2026.10.3",
              releaseUrl: "https://www.home-assistant.io/changelogs/core-2026.10/#2026103",
            },
          ],
        },
      },
    });
    renderAttention("admin");
    const group = (await screen.findByText("Install it in Home Assistant: Settings → System → Updates.")).closest(
      "details",
    )!;
    expect(group.querySelector("summary")!.textContent).toContain("1 waiting");
    expect(within(group).getByText("Home Assistant Core")).toBeTruthy();
    expect(within(group).getByText(/2026\.10\.2 → 2026\.10\.3/)).toBeTruthy();
    expect(within(group).getByRole("link", { name: "release notes" }).getAttribute("href")).toBe(
      "https://www.home-assistant.io/changelogs/core-2026.10/#2026103",
    );
    expect(within(group).queryByRole("checkbox")).toBeNull();
  });

  it("restarts a container Ollama handed over, whatever it named, and approves the dependency it chose", async () => {
    // A model that hands an incident over may still name a target; "escalate" is no choice to send back.
    const named: IncidentSummaryView = { ...handedOver, target: "tika" };
    const dependency: IncidentSummaryView = {
      ...handedOver,
      id: "i2",
      containerName: "app",
      action: "restart_dependency",
      target: "db",
    };
    const fetch = serve("admin", {
      ...board,
      needsYou: [
        { kind: "incident", incident: named },
        { kind: "incident", incident: dependency },
      ],
    });
    renderAttention("admin");
    const sent = (incidentId: string) =>
      fetch.mock.calls
        .filter(
          ([url, init]) => url === apiPath(API_ROUTES.incidentApproval, { incidentId }) && init?.method === "POST",
        )
        .map(([, init]) => init?.body);

    fireEvent.click(await screen.findByRole("button", { name: "Restart it" }));
    fireEvent.click(screen.getByRole("button", { name: "Approve restart" }));
    await waitFor(() => expect(sent("i1")).toEqual(['{"choice":"restart"}']));
    await waitFor(() => expect(sent("i2")).toEqual(['{"choice":"restart_dependency","target":"db"}']));
  });

  it("puts a problem off for a day, and stops watching a container Ollama handed over", async () => {
    const fetch = serve("admin", needsYou);
    renderAttention("admin");
    const sent = (method: string, path: string) =>
      fetch.mock.calls.filter(([url, init]) => url === path && init?.method === method).map(([, init]) => init?.body);

    fireEvent.click(await screen.findByRole("button", { name: "Snooze a day" }));
    await waitFor(() =>
      expect(sent("PATCH", apiPath(API_ROUTES.task, { taskId: "task-disk" }))).toEqual(['{"snoozed":"day"}']),
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop watching this container" }));
    await waitFor(() =>
      expect(sent("POST", apiPath(API_ROUTES.incidentApproval, { incidentId: "i1" }))).toEqual([
        '{"choice":"dismiss"}',
      ]),
    );
    expect(sent("PUT", apiPath(API_ROUTES.containerControls, { hostId: "h1" }))).toEqual([
      '{"names":["tika"],"restart":"ignore"}',
    ]);
  });

  it("offers a problem's actions as buttons: its way there and Done on one row, then how long to put it off", async () => {
    serve("admin", needsYou);
    renderAttention("admin");
    const card = (await screen.findByText("Alder's disk is 97% full")).closest("article")!;
    const open = within(card).getByRole("link", { name: /^Open / });
    const done = within(card).getByRole("button", { name: "Done" });
    const snooze = within(card).getByRole("group", { name: TEXT.tasks.snooze.label });
    expect([...open.parentElement!.children]).toEqual([open, done, snooze]);
    for (const button of [done, ...within(snooze).getAllByRole("button")]) {
      expect(button.classList.contains("quiet"), button.textContent!).toBe(false);
    }
  });

  it("leaves a stopped container stopped, and stops one Docker keeps starting again, following its stop", async () => {
    const approval = apiPath(API_ROUTES.incidentApproval, { incidentId: "i1" });
    const actions = apiPath(API_ROUTES.containerActions, { hostId: "h1", containerName: "tika" });
    const stop: JobView = {
      id: "j1",
      hostId: "h1",
      hostLabel: "Alder",
      containerName: "tika",
      action: "stop",
      status: "pending",
      requestedBy: "admin",
      taskId: null,
      createdAt: Date.now(),
      completedAt: null,
      outcome: null,
      output: null,
      packages: [],
      recoveryBackupId: null,
      progress: null,
      stack: null,
    };
    const sentTo = (fetch: ReturnType<typeof serve>, path: string) =>
      fetch.mock.calls.filter(([url, init]) => url === path && init?.method === "POST").map(([, init]) => init?.body);

    const stopped = serve("admin", needsYou);
    renderAttention("admin");
    fireEvent.click(await screen.findByRole("button", { name: "Leave it stopped" }));
    await waitFor(() => expect(sentTo(stopped, approval)).toEqual(['{"choice":"dismiss"}']));
    expect(sentTo(stopped, actions)).toEqual([]);
    expect(screen.queryByRole("button", { name: "Stop it" })).toBeNull();
    cleanup();

    // Dismissing it would only bring the question back at its next failure: the way out is to stop it.
    const refused = "Alder is in dry-run: tika was not stopped.";
    const looping = serve(
      "admin",
      needsYou,
      { homeAssistant: null },
      { packages: [], automatic: [] },
      {
        [API_ROUTES.containers]: [{ ...TIKA, state: "restarting" }],
        [actions]: stop,
        [API_ROUTES.jobs]: [{ ...stop, status: "failed", completedAt: Date.now(), outcome: refused }],
      },
    );
    renderAttention("admin");
    fireEvent.click(await screen.findByRole("button", { name: "Stop it" }));
    await waitFor(() => expect(sentTo(looping, actions)).toEqual(['{"action":"stop"}']));
    expect(await screen.findByText(refused)).toBeTruthy();
    expect(sentTo(looping, approval)).toEqual([]);
    expect(screen.queryByRole("button", { name: "Leave it stopped" })).toBeNull();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Stop it" }) as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("shows a viewer what waits, with nothing to tick, apply or decide", async () => {
    serve("viewer", needsYou);
    renderAttention("viewer");

    expect(await screen.findByText("Ollama: safe to apply")).toBeTruthy();
    expect(screen.getByText("Alder's disk is 97% full")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "tika" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Update quantum" })).toBeNull();
    expect(screen.queryByRole("button", { name: /containers? now$/ })).toBeNull();
    for (const action of ["Restart it", "Leave it stopped", "Stop watching this container", "Snooze a day", "Done"]) {
      expect(screen.queryByRole("button", { name: action })).toBeNull();
    }
  });
});

describe("a host whose runner is held back, on the attention page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const tagChange = { operation: "job:j1:change_tag", target: "gitea", step: 7, at: Date.UTC(2026, 9, 4, 6, 20) };
  const heldBack = {
    ...alder,
    kind: "ssh",
    state: "silent",
    ssh: { state: "connected", since: Date.now(), reason: "1 unfinished operation", interrupted: [tagChange] },
  } as HostView;
  const silent: TaskSummaryView = {
    ...diskNearlyFull,
    id: "task-silent",
    title: TASK_TEXT.runnerHeldBack("Alder"),
    about: TASK_ABOUT.runnerSilent,
    resource: { kind: "host", id: "h1", label: "Alder" },
  };
  // Another problem on the same host: what holds its runner back is told once, on the card its silence opened.
  const shown = {
    ...board,
    needsYou: [
      { kind: "task" as const, task: silent },
      { kind: "task" as const, task: diskNearlyFull },
    ],
  };
  const clear = apiPath(API_ROUTES.sshHostInterrupted, { hostId: "h1" });

  it("says so on its card and its host's, names what holds it, and lets an admin clear it right there", async () => {
    const fetch = serve("admin", shown, undefined, undefined, { [API_ROUTES.hosts]: [heldBack] });
    renderAttention("admin");

    const card = (await screen.findByText(TASK_TEXT.runnerHeldBack("Alder"))).closest("article")!;
    expect(within(card).getByText("change_tag on gitea (step 7, 2026-10-04 06:20)")).toBeTruthy();
    expect(screen.getAllByText("change_tag on gitea (step 7, 2026-10-04 06:20)")).toHaveLength(1);
    expect(screen.getByRole("link", { name: new RegExp(TEXT.hosts.heldBack) })).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: TEXT.heldBack.clear }));
    fireEvent.click(screen.getByRole("button", { name: TEXT.yes }));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([url, init]) => url === clear && init?.method === "DELETE")).toBe(true),
    );
  });

  it("shows a viewer what holds it, with no way to clear it", async () => {
    serve("viewer", shown, undefined, undefined, { [API_ROUTES.hosts]: [heldBack] });
    renderAttention("viewer");

    const card = (await screen.findByText(TASK_TEXT.runnerHeldBack("Alder"))).closest("article")!;
    expect(within(card).getByText("change_tag on gitea (step 7, 2026-10-04 06:20)")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: TEXT.heldBack.clear })).toBeNull();
  });
});

describe("what a host's packages ask of a person, on the attention page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const packageTask = (id: string, title: string, about: TaskAbout | null): TaskSummaryView => ({
    ...diskNearlyFull,
    id: `task-${id}`,
    title,
    labels: ["packages"],
    priority: "low",
    about,
  });
  const reboot = packageTask("reboot", "Alder needs a reboot", TASK_ABOUT.reboot);
  const release = packageTask("release", "Ubuntu 20.04 on Alder gets no security fixes any more", TASK_ABOUT.lifecycle);
  const upgrades = packageTask("upgrades", "OS updates on Alder: 2", TASK_ABOUT.osUpdates);
  const stray = packageTask("stray", "Something else about Alder's packages", null);
  const needing = (...tasks: TaskSummaryView[]) => ({
    ...board,
    noticed: [],
    needsYou: tasks.map((task) => ({ kind: "task" as const, task })),
  });

  it("shows a reboot and a release's end with their host's updates, so all that is counted is there to see", async () => {
    serve("admin", needing(reboot, release));
    renderAttention("admin");
    expect(await screen.findByText(reboot.title)).toBeTruthy();
    expect(screen.getByText(release.title)).toBeTruthy();
    expect(screen.getByText(TEXT.attention.lede(2))).toBeTruthy();
  });

  it("lets a host's package list stand for its updates task, and shows that task itself while the list is empty", async () => {
    serve("admin", needing(upgrades), undefined, heldPackages);
    renderAttention("admin");
    expect(await screen.findByText("netdata-dashboard")).toBeTruthy();
    expect(screen.queryByText(upgrades.title)).toBeNull();
    cleanup();

    serve("admin", needing(upgrades));
    renderAttention("admin");
    expect(await screen.findByText(upgrades.title)).toBeTruthy();
  });

  it("puts a package task no group draws among the problems to fix", async () => {
    serve("admin", needing(stray));
    renderAttention("admin");
    const card = (await screen.findByText(stray.title)).closest("article")!;
    expect(card.closest(".fix-grid")).toBeTruthy();
  });
});

describe("arranging the attention page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  const { onItNow, healed, comingUp, howFar } = TEXT.attention;
  const updates = TEXT.attention.sections.updates.label;
  const sideCards = () => [...document.querySelectorAll(".attention-side h2")].map((heading) => heading.textContent);

  it("hides a card for this browser alone, and brings it back from the hidden cards line", async () => {
    serve("viewer");
    renderAttention("viewer");
    await screen.findByRole("heading", { name: healed });
    // Nothing to arrange shows until asked for.
    expect(screen.queryByRole("group", { name: TEXT.arrange.controls(healed) })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: TEXT.arrange.start }));
    fireEvent.click(screen.getByRole("button", { name: TEXT.arrange.hideCard(healed) }));
    expect(screen.queryByRole("heading", { name: healed })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: TEXT.arrange.done }));

    // As after a reload: this browser keeps it hidden.
    cleanup();
    renderAttention("viewer");
    await screen.findByRole("heading", { name: onItNow });
    expect(screen.queryByRole("heading", { name: healed })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: TEXT.arrange.show(healed) }));
    expect(await screen.findByRole("heading", { name: healed })).toBeTruthy();
    expect(window.localStorage.length).toBe(0);
  });

  it("puts a pinned card first in its column after a reload, and leaves what needs a person in its place", async () => {
    serve("admin", needsYou);
    renderAttention("admin");
    await screen.findByRole("heading", { name: comingUp });
    expect(sideCards()).toEqual([onItNow, healed, comingUp, howFar]);
    fireEvent.click(screen.getByRole("button", { name: TEXT.arrange.start }));
    // The updates and the four cards beside them; what to decide and fix has no controls.
    expect(screen.getAllByRole("group", { name: /^Arrange / })).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: TEXT.arrange.pinCard(comingUp) }));
    expect(sideCards()).toEqual([comingUp, onItNow, healed, howFar]);
    // Alone in its column, the updates have nothing to come before.
    expect(screen.getByRole("button", { name: TEXT.arrange.hideCard(updates) })).toBeTruthy();
    expect(screen.queryByRole("button", { name: TEXT.arrange.pinCard(updates) })).toBeNull();

    cleanup();
    renderAttention("admin");
    await screen.findByRole("heading", { name: comingUp });
    expect(sideCards()).toEqual([comingUp, onItNow, healed, howFar]);
  });
});
