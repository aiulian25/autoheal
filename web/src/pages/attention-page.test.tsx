import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath, type IncidentSummaryView } from "../../../src/shared/api.js";
import { TEXT } from "../constants.js";
import {
  waitingImage,
  QUANTUM,
  board,
  RUNS,
  handedOver,
  needsYou,
  serve,
  renderAttention,
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
