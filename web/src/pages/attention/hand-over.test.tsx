import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath } from "../../../../src/shared/api.js";
import { AGENT_DRAG_TYPE, TEXT } from "../../constants.js";
import {
  alder,
  waitingImage,
  QUANTUM,
  board,
  needsYou,
  heldPackages,
  TIKA,
  serve,
  renderAttention,
  dragged,
  sentHandOver,
} from "../../test-support/attention-page.js";

describe("handing work to the Ollama agent", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("ticks every update its runner would take, and dispatches the ticked ones to the agent", async () => {
    const fetch = serve("admin", board, { homeAssistant: null }, heldPackages);
    renderAttention("admin");

    const all = await screen.findByRole("button", { name: "Select all (4)" });
    expect(await screen.findByRole("checkbox", { name: "Update netdata-user" })).toBeTruthy();
    expect(screen.getByText("Drag & drop active")).toBeTruthy();
    expect(screen.getByText(/to run with LLM supervision/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Dispatch to Ollama Agent" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(all);
    expect(screen.getAllByRole("checkbox").every((box) => (box as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole("button", { name: "Clear selection" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dispatch to Ollama Agent" }));
    await sentHandOver(fetch, {
      updates: ["task-quantum", "task-radicale"],
      packages: [{ hostId: "h1", names: ["netdata-dashboard", "netdata-user"] }],
      incidents: [],
    });
    expect(await screen.findByText("Handed 2 items to Ollama.")).toBeTruthy();
    expect(screen.getAllByRole("checkbox").some((box) => (box as HTMLInputElement).checked)).toBe(false);
  });

  it("lists a newer version with the host's updates, and hands it to the agent with the rest", async () => {
    const pinnedApp = waitingImage("calibre", {
      image: "ghcr.io/linuxserver/calibre:9.17.0",
      composeProject: "calibre",
      update: {
        status: "current",
        checkedAt: Date.now(),
        policy: "ask",
        remote: null,
        reason: null,
        newerTag: "9.18.0",
      },
    });
    const acting = { ...alder, containerAccess: true, hostDeploy: true, tagChanges: true };
    const fetch = serve("admin", board, { homeAssistant: null }, undefined, {
      [API_ROUTES.hosts]: [acting],
      [API_ROUTES.containers]: [QUANTUM, waitingImage("radicale"), TIKA, pinnedApp],
    });
    renderAttention("admin");

    expect(await screen.findByText("Newer version · 9.17.0 → 9.18.0, its tag changed in its files")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ignore new versions of calibre" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Tick the new version of calibre" }));
    fireEvent.click(screen.getByRole("button", { name: "Dispatch to Ollama Agent" }));
    await sentHandOver(fetch, {
      updates: [],
      packages: [],
      incidents: [],
      tags: [{ hostId: "h1", container: "calibre", tag: "9.18.0" }],
    });
  });

  describe("with several Ollama servers", () => {
    const withDell = (reachable: boolean) => ({
      [API_ROUTES.ollamaServers]: {
        extras: [
          {
            id: "s1",
            name: "Delta3640",
            url: "http://delta",
            model: "big:30b",
            contextTokens: 1,
            plainHttp: true,
            status: { reachable },
            hostIds: ["h1"],
          },
        ],
        reviewServerId: null,
      },
    });
    const agentCard = async () => (await screen.findByText(TEXT.attention.agent.dropTarget)).closest("a")!;

    it("shows each server and who it watches, and says where a drag goes", async () => {
      serve("admin", board, { homeAssistant: null }, heldPackages, withDell(true));
      renderAttention("admin");
      const agent = await agentCard();
      expect(await within(agent).findByText("Delta3640")).toBeTruthy();
      expect(within(agent).getByText("big:30b")).toBeTruthy();
      expect(within(agent).getByText("1 host")).toBeTruthy();
      expect(within(agent).getByText("2 of 2 answering")).toBeTruthy();
      expect(screen.getByText(TEXT.attention.agent.ready)).toBeTruthy();
      const quantum = (await screen.findByRole("checkbox", { name: "Update quantum" })).closest("li")!;
      fireEvent.dragStart(quantum, { dataTransfer: dragged() });
      expect(await within(agent).findByText("Goes to Delta3640")).toBeTruthy();
      fireEvent.dragEnd(quantum);
      expect(await within(agent).findByText(TEXT.attention.agent.dropTarget)).toBeTruthy();
    });

    it("says a drag goes to the default while its server is off, and that it is partly offline", async () => {
      serve("admin", board, { homeAssistant: null }, heldPackages, withDell(false));
      renderAttention("admin");
      const agent = await agentCard();
      expect(await within(agent).findByText("1 of 2 answering")).toBeTruthy();
      expect(
        within(agent).getByText(TEXT.attention.ollama.onDefault(TEXT.attention.ollama.defaultServer)),
      ).toBeTruthy();
      expect(await screen.findByText(TEXT.attention.agent.partlyOffline)).toBeTruthy();
      const quantum = (await screen.findByRole("checkbox", { name: "Update quantum" })).closest("li")!;
      fireEvent.dragStart(quantum, { dataTransfer: dragged() });
      expect(await within(agent).findByText("Goes to the default server")).toBeTruthy();
    });
  });

  it("shows one server just as before", async () => {
    serve("admin");
    renderAttention("admin");
    const agent = (await screen.findByText(TEXT.attention.agent.dropTarget)).closest("a")!;
    expect(within(agent).getByText("qwen3:30b-a3b")).toBeTruthy();
    expect(within(agent).getByText(TEXT.attention.ollama.answering)).toBeTruthy();
    expect(within(agent).queryByText(TEXT.attention.ollama.defaultName)).toBeNull();
  });

  it("takes what is dropped on its card: the ticked rows with the one dragged, else that one alone", async () => {
    const fetch = serve("admin", board, { homeAssistant: null }, heldPackages);
    renderAttention("admin");
    const agent = (await screen.findByText("Drop Target")).closest("a")!;
    const quantum = (await screen.findByRole("checkbox", { name: "Update quantum" })).closest("li")!;
    const user = (await screen.findByRole("checkbox", { name: "Update netdata-user" })).closest("li")!;

    const alone = dragged();
    const page = agent.closest(".page")!;
    fireEvent.dragStart(quantum, { dataTransfer: alone });
    // The agent's strip stays in sight while it drags.
    expect(page.className).toContain("dragging");
    fireEvent.dragOver(agent, { dataTransfer: alone });
    expect(agent.className).toContain("dragged-over");
    fireEvent.drop(agent, { dataTransfer: alone });
    expect(page.className).not.toContain("dragging");
    await sentHandOver(fetch, { updates: ["task-quantum"], packages: [], incidents: [] });

    fireEvent.click(screen.getByRole("checkbox", { name: "Update radicale" }));
    const together = dragged();
    fireEvent.click(screen.getByRole("checkbox", { name: "Update netdata-user" }));
    fireEvent.dragStart(user, { dataTransfer: together });
    expect(JSON.parse(together.getData(AGENT_DRAG_TYPE))).toEqual(["update:task-radicale", "package:h1:netdata-user"]);
    fireEvent.drop(agent, { dataTransfer: together });
    await sentHandOver(fetch, {
      updates: ["task-radicale"],
      packages: [{ hostId: "h1", names: ["netdata-user"] }],
      incidents: [],
    });

    // Something else dropped there is not a hand-over.
    const stranger = dragged();
    stranger.setData("text/plain", "hello");
    fireEvent.drop(agent, { dataTransfer: stranger });
    expect(fetch.mock.calls.filter(([url]) => url === API_ROUTES.agentDispatch)).toHaveLength(2);
  });

  it("opens a host's updates once one of them is ticked, so nothing ticked is out of sight", async () => {
    const rowan = { ...alder, id: "h2", label: "Rowan" };
    serve(
      "admin",
      board,
      { homeAssistant: null },
      { packages: [], automatic: [] },
      {
        [API_ROUTES.hosts]: [alder, rowan],
        [apiPath(API_ROUTES.hostPackages, { hostId: "h2" })]: heldPackages,
      },
    );
    renderAttention("admin");
    // The folded group's summary says Review; each row's own link says it too.
    const folded = (await screen.findByText("Review", { selector: "summary span" })).closest("details")!;
    expect(folded.open).toBe(false);

    fireEvent.click(await screen.findByRole("button", { name: "Select all (4)" }));
    await waitFor(() => expect(folded.open).toBe(true));
  });

  it("leads each update to its own place on the host: a container's row, the host's updates", async () => {
    serve("admin", needsYou);
    renderAttention("admin");
    const row = (await screen.findAllByText("quantum")).map((found) => found.closest("li")).find(Boolean)!;
    expect(within(row).getByRole("link", { name: "Review" }).getAttribute("href")).toBe("/hosts/h1?container=quantum");
    const group = row.closest("details")!;
    expect(
      within(group)
        .getByRole("link", { name: /^Review on / })
        .getAttribute("href"),
    ).toMatch(/#updates$/);
  });

  it("hands an escalated incident over from its card, and offers a viewer none of it", async () => {
    const fetch = serve("admin", needsYou);
    renderAttention("admin");
    const decision = (await screen.findByText("tika")).closest("article")!;
    expect(decision.getAttribute("draggable")).toBe("true");
    fireEvent.click(within(decision).getByRole("button", { name: "Hand to Ollama" }));
    await sentHandOver(fetch, { updates: [], packages: [], incidents: ["i1"] });
    cleanup();

    serve("viewer", needsYou, { homeAssistant: null }, heldPackages);
    renderAttention("viewer");
    expect(await screen.findByText("netdata-user")).toBeTruthy();
    expect(screen.queryByText("Drop Target")).toBeNull();
    expect(screen.queryByRole("button", { name: /Dispatch to Ollama Agent|Hand to Ollama|Select all/ })).toBeNull();
    expect(screen.queryAllByRole("checkbox")).toEqual([]);
    expect(screen.queryByText("Drag & drop active")).toBeNull();
    expect(screen.getByText("Agent ready")).toBeTruthy();
  });
});
