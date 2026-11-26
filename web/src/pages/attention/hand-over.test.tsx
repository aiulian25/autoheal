import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES } from "../../../../src/shared/api.js";
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
  updateTask,
} from "../../test-support/attention-page.js";
import { timeOfDay } from "../../format.js";

describe("handing work to the Ollama agent", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("ticks what its runner would take on a host's card, and hands the ticked ones to the agent from its foot", async () => {
    const fetch = serve("admin", board, { homeAssistant: null }, heldPackages);
    renderAttention("admin");

    const hand = await screen.findByRole("button", { name: "Hand 0 to Ollama" });
    expect((hand as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: TEXT.attention.reviewCount(2) }));
    for (const name of ["quantum", "radicale", "netdata-dashboard", "netdata-user"]) {
      fireEvent.click(await screen.findByRole("checkbox", { name: `Update ${name}` }));
    }

    fireEvent.click(screen.getByRole("button", { name: "Hand 4 to Ollama" }));
    await sentHandOver(fetch, {
      updates: ["task-quantum", "task-radicale"],
      packages: [{ hostId: "h1", names: ["netdata-dashboard", "netdata-user"] }],
      incidents: [],
    });
    expect(await screen.findByText("Handed 2 items to Ollama.")).toBeTruthy();
    expect(screen.getAllByRole("checkbox").some((box) => (box as HTMLInputElement).checked)).toBe(false);
  });

  it("shows in its row what the assistant asked about an update, and the answer it heard", async () => {
    const at = Date.UTC(2026, 10, 10, 20, 6);
    const asked = { ...updateTask("quantum", null), assistant: { answer: null, how: null, at } };
    const answered = {
      ...updateTask("radicale", null),
      assistant: { answer: "yes" as const, how: "voice" as const, at },
    };
    const noticed = [asked, answered].map((task) => ({ kind: "task" as const, task }));
    serve("admin", { ...board, noticed }, { homeAssistant: null }, heldPackages);
    renderAttention("admin");
    expect(await screen.findByText("Asked the assistant")).toBeTruthy();
    expect(screen.getByText(`Yes, by voice, ${timeOfDay(at)}`)).toBeTruthy();
  });

  it("shows in its row why an update that was tried waits for a person", async () => {
    const at = Date.UTC(2026, 10, 10, 20, 6);
    const tried = {
      ...updateTask("quantum", "update"),
      assistant: { answer: "yes" as const, how: "voice" as const, at },
      heldBecause: "data_not_kept" as const,
    };
    const noticed = [tried, updateTask("radicale", null)].map((task) => ({ kind: "task" as const, task }));
    serve("admin", { ...board, noticed }, { homeAssistant: null }, heldPackages);
    renderAttention("admin");
    const quantum = (await screen.findByText(`Yes, by voice, ${timeOfDay(at)}`)).closest("li")!;
    expect(within(quantum).getByText("Ollama: safe to apply")).toBeTruthy();
    expect(within(quantum).getByText("Its data could not be copied first")).toBeTruthy();
    expect(screen.getAllByText("Its data could not be copied first")).toHaveLength(1);
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
    fireEvent.click(screen.getByRole("button", { name: "Hand 1 to Ollama" }));
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
            name: "Orion2480",
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
      expect(await within(agent).findByText("Orion2480")).toBeTruthy();
      expect(within(agent).getByText("big:30b")).toBeTruthy();
      expect(within(agent).getByText("1 host")).toBeTruthy();
      expect(within(agent).getByText("2 of 2 answering")).toBeTruthy();
      expect(screen.getByText(TEXT.attention.agent.ready)).toBeTruthy();
      const quantum = (await screen.findByRole("checkbox", { name: "Update quantum" })).closest("li")!;
      fireEvent.dragStart(quantum, { dataTransfer: dragged() });
      expect(await within(agent).findByText("Goes to Orion2480")).toBeTruthy();
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

  it("keeps the agent's card at the head of the side column, where it stays in sight, with no strip of hosts", async () => {
    serve("admin");
    renderAttention("admin");
    const agent = (await screen.findByText(TEXT.attention.agent.dropTarget)).closest("a")!;
    const side = agent.closest(".attention-side");
    expect(side?.firstElementChild).toBe(agent);
    expect(screen.queryByRole("navigation", { name: TEXT.attention.services })).toBeNull();
    expect(screen.getByLabelText(TEXT.attention.fleet.label).textContent).toContain("1 of 1 hosts");
  });

  it("shows one server just as before", async () => {
    serve("admin");
    renderAttention("admin");
    const agent = (await screen.findByText(TEXT.attention.agent.dropTarget)).closest("a")!;
    // Cut short on a card too narrow for it, the model's name keeps all of it to read.
    expect(within(agent).getByText("qwen3:30b-a3b").title).toBe("qwen3:30b-a3b");
    expect(within(agent).getByText(TEXT.attention.ollama.answering)).toBeTruthy();
    expect(within(agent).queryByText(TEXT.attention.ollama.defaultName)).toBeNull();
  });

  it("takes what is dropped on its card: the ticked rows with the one dragged, else that one alone", async () => {
    const fetch = serve("admin", board, { homeAssistant: null }, heldPackages);
    renderAttention("admin");
    const agent = (await screen.findByText("Drop Target")).closest("a")!;
    fireEvent.click(await screen.findByRole("button", { name: TEXT.attention.reviewCount(2) }));
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

  it("keeps a host's package list open while one of its packages is ticked, so nothing ticked is out of sight", async () => {
    serve("admin", board, { homeAssistant: null }, heldPackages);
    renderAttention("admin");
    expect(await screen.findByText(TEXT.attention.packageUpdates(2))).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Update netdata-user" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: TEXT.attention.reviewCount(2) }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Update netdata-user" }));
    fireEvent.click(screen.getByRole("button", { name: TEXT.attention.hideList }));
    expect(screen.getByRole("checkbox", { name: "Update netdata-user" })).toBeTruthy();

    // Unticked, the list it was asked to hide goes.
    fireEvent.click(screen.getByRole("checkbox", { name: "Update netdata-user" }));
    expect(screen.queryByRole("checkbox", { name: "Update netdata-user" })).toBeNull();
    expect(screen.getByRole("button", { name: TEXT.attention.reviewCount(2) })).toBeTruthy();
  });

  it("leads each update to its own place on the host, and its card's head to the host", async () => {
    serve("admin", needsYou);
    renderAttention("admin");
    const row = (await screen.findAllByText("quantum")).map((found) => found.closest("li")).find(Boolean)!;
    expect(within(row).getByRole("link", { name: "Review" }).getAttribute("href")).toBe("/hosts/h1?container=quantum");
    const card = row.closest("article")!;
    expect(within(card).getByRole("link", { name: "Open Alder" }).getAttribute("href")).toBe("/hosts/h1");
  });

  it("hands an escalated incident over from its card, and offers a viewer none of it", async () => {
    const fetch = serve("admin", needsYou);
    renderAttention("admin");
    const decision = (await screen.findByText("tika")).closest("li")!;
    expect(decision.getAttribute("draggable")).toBe("true");
    fireEvent.click(within(decision).getByRole("button", { name: "Hand to Ollama" }));
    await sentHandOver(fetch, { updates: [], packages: [], incidents: ["i1"] });
    cleanup();

    serve("viewer", needsYou, { homeAssistant: null }, heldPackages);
    renderAttention("viewer");
    expect(await screen.findByText(TEXT.attention.packageUpdates(2))).toBeTruthy();
    expect(screen.queryByText("Drop Target")).toBeNull();
    expect(screen.queryByRole("button", { name: /to Ollama$/ })).toBeNull();
    expect(screen.queryAllByRole("checkbox")).toEqual([]);
    expect(screen.getByText("Agent ready")).toBeTruthy();
  });
});
