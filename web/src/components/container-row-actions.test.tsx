import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath, type JobView } from "../../../src/shared/api.js";
import { hostHealth } from "../../../test/support/inventory.js";
import { ASK_FIRST_ON, ASK_FIRST_STORAGE_KEY, TEXT } from "../constants.js";
import { HostContainers } from "./host-containers.js";
import { alder, container, CONTAINERS, serve, show, sent } from "../test-support/host-table.js";

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

describe("a host's containers and what each does", () => {
  it("acts on the ticked containers at once, each action on the ones it fits, and says how it went", async () => {
    const nightly = container({ name: "nightly", composeProject: null, state: "exited", health: "none" });
    const actionPath = (containerName: string) => apiPath(API_ROUTES.containerActions, { hostId: "h1", containerName });
    const jobOf = (id: string, containerName: string, action: JobView["action"]): JobView => ({
      id,
      hostId: "h1",
      hostLabel: "Alder",
      containerName,
      action,
      status: "succeeded",
      requestedBy: "admin",
      taskId: null,
      createdAt: 1,
      completedAt: 2,
      outcome: `${action} ${containerName}`,
      output: null,
      recoveryBackupId: null,
      packages: [],
      progress: null,
      stack: null,
    });
    const fetch = serve({
      [API_ROUTES.containers]: [...CONTAINERS, nightly],
      [`POST ${actionPath("attic")}`]: jobOf("j1", "attic", "restart"),
      [`POST ${actionPath("nightly")}`]: jobOf("j2", "nightly", "remove"),
      [API_ROUTES.jobs]: [jobOf("j1", "attic", "restart"), jobOf("j2", "nightly", "remove")],
    });
    show(<HostContainers host={alder(false)} admin />);

    const bar = await screen.findByRole("group", { name: "Act on the ticked containers" });
    expect(screen.queryByText(/Choosing Update allows/)).toBeNull();
    const hint = "Tick containers to restart, stop, update or remove several at once.";
    expect(within(bar).getByText(hint)).toBeTruthy();
    // What its host keeps to itself has no tick.
    const runner = (await screen.findByRole("button", { name: "autoheal" })).closest("tr")!;
    expect(within(runner).queryByRole("checkbox")).toBeNull();

    // The hint scrolls away with the page; the buttons stay in view.
    expect(bar.classList.contains("action-bar")).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick attic" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick nightly" }));
    expect(within(bar).getByText("2 ticked")).toBeTruthy();
    expect(bar.classList.contains("action-bar")).toBe(true);
    expect(
      within(bar)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Clear", "Restart 1", "Start 1", "Stop 1", "Pause 1", "Check for updates", "Remove 2"]);

    fireEvent.click(within(bar).getByRole("button", { name: "Restart 1" }));
    await sent(fetch, actionPath("attic"), "POST", { action: "restart" });
    expect(await within(bar).findByText("Restart: 1 of 1 done.")).toBeTruthy();
    // Once asked, no tick stays behind for the next action to reach by mistake.
    expect(within(bar).getByText(hint)).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Tick nightly" }) as HTMLInputElement).checked).toBe(false);

    // Nor after a row's own button.
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick nightly" }));
    const atticRow = screen.getByRole("button", { name: "attic" }).closest("tr")!;
    fireEvent.click(within(atticRow).getByRole("button", { name: "Restart attic" }));
    await waitFor(() => expect(within(bar).getByText(hint)).toBeTruthy());

    // The running one too: its runner stops it first. A removal is asked about once, for all of them.
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick attic" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Tick nightly" }));
    fireEvent.click(within(bar).getByRole("button", { name: "Remove 2" }));
    const question = screen.getByRole("group", { name: "Remove attic and nightly? Volumes are kept." });
    fireEvent.click(within(question).getByRole("button", { name: TEXT.yes }));
    await sent(fetch, actionPath("attic"), "POST", { action: "remove" });
    await sent(fetch, actionPath("nightly"), "POST", { action: "remove" });

    // Ticking all ticks every container shown that its host lets Autoheal change; again, none.
    const all = screen.getByRole("checkbox", { name: "Tick every container shown" });
    fireEvent.click(all);
    expect(within(bar).getByText("4 ticked")).toBeTruthy();
    fireEvent.click(all);
    expect(within(bar).getByText(hint)).toBeTruthy();
  });
  it("shows what each container publishes, linked on its host, and acts on one container from its own row", async () => {
    const actionPath = (containerName: string) => apiPath(API_ROUTES.containerActions, { hostId: "h1", containerName });
    const fetch = serve({
      [API_ROUTES.containers]: CONTAINERS.map((each) => {
        if (each.name === "attic") {
          return { ...each, ports: [{ published: 8080, target: 80, protocol: "tcp" as const }] };
        }
        return each.name === "BentoPDF" ? { ...each, hostNetwork: true } : each;
      }),
    });
    show(<HostContainers host={{ ...alder(false), health: hostHealth({ address: "192.168.10.178" }) }} admin />);

    const attic = (await screen.findByRole("button", { name: "attic" })).closest("tr")!;
    const port = within(attic).getByRole("link", { name: "8080" });
    expect(port.getAttribute("href")).toBe("http://192.168.10.178:8080");
    expect(port.closest("[title]")!.getAttribute("title")).toBe("8080 → 80/tcp");
    const bento = screen.getByRole("button", { name: "BentoPDF" }).closest("tr")!;
    expect(within(bento).getByText("host network")).toBeTruthy();

    // Its own buttons: a restart is one click; the ones that do not fit it, or its host keeps to itself, are off.
    fireEvent.click(within(attic).getByRole("button", { name: "Restart attic" }));
    await sent(fetch, actionPath("attic"), "POST", { action: "restart" });
    expect((within(attic).getByRole("button", { name: "Remove attic" }) as HTMLButtonElement).disabled).toBe(false);
    const runner = screen.getByRole("button", { name: "autoheal" }).closest("tr")!;
    expect((within(runner).getByRole("button", { name: "Restart autoheal" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(runner).getByRole("button", { name: "Logs autoheal" }) as HTMLButtonElement).disabled).toBe(false);

    // Its logs are read under the row, with its stats.
    fireEvent.click(within(attic).getByRole("button", { name: "Logs attic" }));
    await sent(fetch, actionPath("attic"), "POST", { action: "logs" });
    expect(within(attic).getByRole("button", { name: "Stats of attic" }).getAttribute("aria-pressed")).toBe("true");
  });
  it("asks once before a stop or a removal where this browser is set to, from a row or for the ticked ones", async () => {
    const nightly = container({ name: "nightly", composeProject: null, state: "exited", health: "none" });
    const actionPath = (containerName: string) => apiPath(API_ROUTES.containerActions, { hostId: "h1", containerName });
    const fetch = serve({ [API_ROUTES.containers]: [...CONTAINERS, nightly] });
    const answer = (question: string, said: string) =>
      fireEvent.click(within(screen.getByRole("group", { name: question })).getByRole("button", { name: said }));
    window.localStorage.setItem(ASK_FIRST_STORAGE_KEY, ASK_FIRST_ON);
    try {
      show(<HostContainers host={alder(false)} admin />);
      const attic = (await screen.findByRole("button", { name: "attic" })).closest("tr")!;
      const stopped = expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "stop" }) });

      // A no sends nothing; a yes stops it. A restart still goes on one click.
      fireEvent.click(within(attic).getByRole("button", { name: "Stop attic" }));
      answer("Stop attic?", TEXT.no);
      expect(fetch).not.toHaveBeenCalledWith(actionPath("attic"), stopped);
      fireEvent.click(within(attic).getByRole("button", { name: "Stop attic" }));
      answer("Stop attic?", TEXT.yes);
      await sent(fetch, actionPath("attic"), "POST", { action: "stop" });
      const restart = within(attic).getByRole("button", { name: "Restart attic" }) as HTMLButtonElement;
      await waitFor(() => expect(restart.disabled).toBe(false));
      fireEvent.click(restart);
      expect(screen.queryByRole("group", { name: /^Restart/ })).toBeNull();
      await sent(fetch, actionPath("attic"), "POST", { action: "restart" });

      // The ticked ones are asked about once, each by name.
      fireEvent.click(screen.getByRole("checkbox", { name: "Tick attic" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Tick nightly" }));
      const bar = screen.getByRole("group", { name: "Act on the ticked containers" });
      const remove = within(bar).getByRole("button", { name: "Remove 2" }) as HTMLButtonElement;
      await waitFor(() => expect(remove.disabled).toBe(false));
      fireEvent.click(remove);
      answer("Remove attic and nightly? Volumes are kept.", TEXT.yes);
      await sent(fetch, actionPath("attic"), "POST", { action: "remove" });
      await sent(fetch, actionPath("nightly"), "POST", { action: "remove" });
      // The no sent nothing, then or later: one stop in all.
      expect(
        fetch.mock.calls.filter(
          ([path, init]) => path === actionPath("attic") && init?.body === JSON.stringify({ action: "stop" }),
        ),
      ).toHaveLength(1);
    } finally {
      window.localStorage.removeItem(ASK_FIRST_STORAGE_KEY);
    }
  });
  it("asks before every removal, from a row or for the ticked ones, while a stop still goes on one click", async () => {
    const nightly = container({ name: "nightly", composeProject: null, state: "exited", health: "none" });
    const actionPath = (containerName: string) => apiPath(API_ROUTES.containerActions, { hostId: "h1", containerName });
    const fetch = serve({ [API_ROUTES.containers]: [...CONTAINERS, nightly] });
    const answer = (question: string, said: string) =>
      fireEvent.click(within(screen.getByRole("group", { name: question })).getByRole("button", { name: said }));
    const removed = expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "remove" }) });
    show(<HostContainers host={alder(false)} admin />);
    const attic = (await screen.findByRole("button", { name: "attic" })).closest("tr")!;

    // Not set to ask in this browser: a removal asks all the same, and a no sends nothing.
    fireEvent.click(within(attic).getByRole("button", { name: "Remove attic" }));
    answer("Remove attic? Volumes are kept.", TEXT.no);
    expect(fetch).not.toHaveBeenCalledWith(actionPath("attic"), removed);
    fireEvent.click(within(attic).getByRole("button", { name: "Remove attic" }));
    answer("Remove attic? Volumes are kept.", TEXT.yes);
    await sent(fetch, actionPath("attic"), "POST", { action: "remove" });

    const stop = within(attic).getByRole("button", { name: "Stop attic" }) as HTMLButtonElement;
    await waitFor(() => expect(stop.disabled).toBe(false));
    fireEvent.click(stop);
    expect(screen.queryByRole("group", { name: /^Stop/ })).toBeNull();
    await sent(fetch, actionPath("attic"), "POST", { action: "stop" });

    fireEvent.click(screen.getByRole("checkbox", { name: "Tick nightly" }));
    const bar = screen.getByRole("group", { name: "Act on the ticked containers" });
    const removeTicked = within(bar).getByRole("button", { name: "Remove 1" }) as HTMLButtonElement;
    await waitFor(() => expect(removeTicked.disabled).toBe(false));
    fireEvent.click(removeTicked);
    expect(fetch).not.toHaveBeenCalledWith(actionPath("nightly"), removed);
    answer("Remove nightly? Volumes are kept.", TEXT.yes);
    await sent(fetch, actionPath("nightly"), "POST", { action: "remove" });
  });
  it("opens a shell under a row at once, where the host allows one", async () => {
    serve({ [API_ROUTES.containers]: CONTAINERS });
    show(<HostContainers host={alder(false)} admin />);
    const attic = (await screen.findByRole("button", { name: "attic" })).closest("tr")!;
    const shellOf = (row: HTMLElement, name: string) =>
      within(row).getByRole("button", { name: `Shell in ${name}` }) as HTMLButtonElement;
    // The host's .env has not let anyone in.
    expect(shellOf(attic, "attic").disabled).toBe(true);
    expect(shellOf(attic, "attic").title).toMatch(/its \.env says CONTAINER_ACCESS=off, or its runner needs updating/);
    cleanup();

    show(<HostContainers host={{ ...alder(false), containerAccess: true }} admin />);
    const row = (name: string) => screen.getByRole("button", { name }).closest("tr")!;
    await screen.findByRole("button", { name: "attic" });
    expect(shellOf(row("autoheal"), "autoheal").disabled).toBe(true);
    fireEvent.click(shellOf(row("attic"), "attic"));

    // No code asked: the shell, until it is closed.
    fireEvent.click(await screen.findByRole("button", { name: "Close the shell in attic" }));
    expect(screen.queryByRole("button", { name: "Close the shell in attic" })).toBeNull();
    expect(shellOf(row("attic"), "attic").getAttribute("aria-pressed")).toBe("false");
  });
});
