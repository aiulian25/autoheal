import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_ROUTES,
  apiPath,
  type HostView,
  type SessionView,
  type StackRestartView,
} from "../../../src/shared/api.js";
import { containerUsage } from "../../../test/support/inventory.js";
import { stackRestartQuery } from "./stack-head.js";
import { timeOfDay } from "../format.js";
import { TEXT } from "../constants.js";
import { HostContainers } from "./host-containers.js";
import {
  session,
  TICKS,
  STACK_RESTARTS,
  alder,
  container,
  CONTAINERS,
  noPanels,
  serve,
  show,
  sent,
} from "../test-support/host-table.js";

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

describe("where a container's row sits", () => {
  const available = { status: "available" as const, checkedAt: 1, policy: "ask" as const, remote: null, reason: null };
  const rowNames = () =>
    screen
      .getAllByRole("row")
      .map((row) => row.querySelector("button.container-name")?.textContent ?? row.textContent?.split(" ")[0] ?? "")
      .filter((name) => name !== "");

  it("keeps each row in its place while it updates, a problem shows or its update goes, by name alone", async () => {
    const routes = {
      [API_ROUTES.containers]: [
        container({ name: "calendar", composeProject: null }),
        container({ name: "agent", composeProject: "agent", update: available }),
        container({ name: "tunnel", composeProject: null, problem: "restarting" }),
      ],
    };
    serve(routes);
    const client = show(<HostContainers host={alder(false)} admin />);
    await screen.findByRole("button", { name: "agent" });
    const before = rowNames().filter((name) => ["agent", "tunnel", "calendar"].includes(name));
    expect(before).toEqual(["agent", "calendar", "tunnel"]);

    // Mid-update: the old container is kept aside under the same Compose project. No stack appears for it.
    routes[API_ROUTES.containers] = [
      container({ name: "calendar", composeProject: null }),
      container({ name: "agent", composeProject: "agent" }),
      container({ name: "agent-autoheal-old", composeProject: "agent", state: "exited" }),
      container({ name: "tunnel", composeProject: null }),
    ];
    await client.invalidateQueries({ queryKey: ["containers"] });
    await screen.findByRole("button", { name: "agent-autoheal-old" });
    expect(document.querySelectorAll('th[scope="rowgroup"]')).toHaveLength(0);
    expect(rowNames().filter((name) => name.startsWith("agent") || name === "tunnel" || name === "calendar")).toEqual([
      "agent",
      "agent-autoheal-old",
      "calendar",
      "tunnel",
    ]);
  });
});

describe("the sidecar runner's own row", () => {
  const ready = { status: "available" as const, checkedAt: 1, policy: "ask" as const, remote: null, reason: null };
  const runner = container({
    name: "autoheal",
    composeProject: null,
    protected: true,
    handsOff: "protected",
    ownRunner: true,
    update: ready,
    byItself: { restart: "ask", update: "ask", restartLock: "protected", updateLock: "protected" },
  });

  it("lets an admin update the runner from its row, protected as it is", async () => {
    const fetch = serve({ [API_ROUTES.containers]: [runner] });
    show(<HostContainers host={alder(false)} admin />);
    const row = (await screen.findByRole("button", { name: "autoheal" })).closest("tr")!;

    fireEvent.click(within(row).getByRole("button", { name: TEXT.ssh.updateRunner }));

    await sent(fetch, apiPath(API_ROUTES.hostActions, { hostId: "h1" }), "POST", { action: "update_runner" });
    expect(await within(row).findByText(TEXT.hostContainers.runnerUpdating)).toBeTruthy();
  });

  it("only says an update is ready to a viewer", async () => {
    serve({ [API_ROUTES.containers]: [runner] });
    show(<HostContainers host={alder(false)} admin={false} />, {
      ...session,
      user: { ...session.user, role: "viewer" },
    });
    const row = (await screen.findByRole("button", { name: "autoheal" })).closest("tr")!;

    expect(within(row).getByText(TEXT.hostContainers.updateReady)).toBeTruthy();
    expect(within(row).queryByRole("button", { name: TEXT.ssh.updateRunner })).toBeNull();
  });
});

describe("container CPU and RAM in the host table", () => {
  it.each([true, false])("shows and refreshes each container's usage (admin: %s)", async (admin) => {
    const routes = {
      [API_ROUTES.containers]: [
        container({
          name: "beszel",
          usage: { ...containerUsage({ cpuPercent: 0.4, memoryBytes: 60 * 1024 ** 2 }), at: Date.now() },
        }),
        container({
          name: "dozzle",
          usage: {
            ...containerUsage({
              cpuPercent: 0.8,
              cpuLimitCores: 2,
              memoryBytes: 72 * 1024 ** 2,
              memoryLimitBytes: 256 * 1024 ** 2,
            }),
            at: Date.now(),
          },
        }),
      ],
    };
    serve(routes);
    const client = show(<HostContainers host={alder(false)} admin={admin} />, {
      ...session,
      user: { ...session.user, role: admin ? "admin" : "viewer" },
    });
    const first = (await screen.findByRole("button", { name: "beszel" })).closest("tr")!;
    const second = screen.getByRole("button", { name: "dozzle" }).closest("tr")!;
    const headers = screen.getAllByRole("columnheader");
    const names = headers.map((header) => header.textContent);
    const ports = names.indexOf("Ports");
    expect(names.slice(ports, ports + 4)).toEqual(["Ports", "CPU", "RAM", "If it fails"]);
    expect(within(first).getByRole("cell", { name: "0.4%" }).title).toBe("of host");
    expect(within(first).getByRole("cell", { name: "60 MB" }).title).toBe("no limit");
    expect(within(second).getByRole("cell", { name: "0.8%" }).title).toBe("2 CPU limit");
    expect(within(second).getByRole("cell", { name: "72 MB" }).title).toBe("256 MB limit");
    expect(within(first).getAllByRole("cell")).toHaveLength(headers.length);
    fireEvent.click(within(first).getByRole("button", { name: "beszel" }));
    expect(first.nextElementSibling?.querySelector("td")?.colSpan).toBe(headers.length);

    routes[API_ROUTES.containers][0] = container({
      name: "beszel",
      usage: { ...containerUsage({ cpuPercent: 1.2, memoryBytes: 80 * 1024 ** 2 }), at: Date.now() },
    });
    await client.invalidateQueries({ queryKey: ["containers"] });
    expect(await within(first).findByRole("cell", { name: "1.2%" })).toBeTruthy();
    expect(within(first).getByRole("cell", { name: "80 MB" })).toBeTruthy();
    expect(within(second).getByRole("cell", { name: "0.8%" })).toBeTruthy();
  });

  it("distinguishes zero usage from missing samples and stopped containers", async () => {
    const usage = { ...containerUsage({ cpuPercent: 0, memoryBytes: 0 }), at: Date.now() };
    serve({
      [API_ROUTES.containers]: [
        container({ name: "idle", usage }),
        container({ name: "waiting", usage: null }),
        container({ name: "stopped", state: "exited", usage }),
      ],
    });
    show(<HostContainers host={alder(false)} admin />);
    const row = (name: string) => screen.getByRole("button", { name }).closest("tr")!;
    await screen.findByRole("button", { name: "idle" });
    expect(within(row("idle")).getByRole("cell", { name: "0%" })).toBeTruthy();
    expect(within(row("idle")).getByRole("cell", { name: "0 B" })).toBeTruthy();
    for (const [name, explanation] of [
      ["waiting", TEXT.metrics.waitingForContainer],
      ["stopped", TEXT.metrics.notRunning],
    ] as const) {
      const cells = within(row(name)).getAllByTitle(explanation);
      expect(cells).toHaveLength(2);
      expect(cells.every((cell) => cell.textContent === TEXT.none)).toBe(true);
    }
  });
});

describe("a host's containers and what each does", () => {
  it("lists stacks first, then the ones on their own, and says why a choice is fixed", async () => {
    serve({ [API_ROUTES.containers]: CONTAINERS });
    show(<HostContainers host={alder(false)} admin />);

    const stack = (await screen.findByRole("rowheader", { name: /^attic/ })).closest("tr")!;
    const single = screen.getByRole("rowheader", { name: "On their own" }).closest("tr")!;
    expect(stack.compareDocumentPosition(single) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("heading", { name: /^Containers/ }).textContent).toBe("Containers · 4 of 4 running");
    const database = screen.getByRole("button", { name: "attic-postgres" }).closest("tr")!;
    expect(within(database).getByText("Databases ask first")).toBeTruthy();
    const runner = screen.getByRole("button", { name: "autoheal" }).closest("tr")!;
    expect(within(runner).getByText("Protected in this host's .env")).toBeTruthy();
    expect(within(runner).queryByRole("combobox")).toBeNull();
  });
  it("says how long a running container has been up, and nothing for one that is stopped", async () => {
    const hour = 3_600_000;
    const hours = 5;
    const startedAt = Date.now() - hours * hour;
    const base = CONTAINERS[0]!;
    serve({
      [API_ROUTES.containers]: [
        { ...base, name: "up-one", state: "running", hostState: "online", startedAt },
        { ...base, name: "down-one", state: "exited", hostState: "online", startedAt },
      ],
    });
    show(<HostContainers host={alder(false)} admin />);

    const running = (await screen.findByRole("button", { name: "up-one" })).closest("tr")!;
    expect(within(running).getByRole("cell", { name: "5 hours" })).toBeTruthy();
    const stopped = screen.getByRole("button", { name: "down-one" }).closest("tr")!;
    expect(within(stopped).queryByRole("cell", { name: "5 hours" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Up for" })).toBeTruthy();
  });
  it("keeps only the container being worked on pinned in view", async () => {
    serve({ [API_ROUTES.containers]: CONTAINERS });
    show(<HostContainers host={alder(false)} admin />);
    const name = await screen.findByRole("button", { name: "attic-postgres" });
    expect(name.closest("tr")!.classList.contains("pinned")).toBe(false);

    fireEvent.click(name);

    await waitFor(() => expect(name.closest("tr")!.classList.contains("pinned")).toBe(true));
    expect(document.querySelectorAll("tr.pinned")).toHaveLength(1);
  });
  it("gives each stack how many of its containers are up, and restarts it from its header", async () => {
    const restartPath = apiPath(API_ROUTES.stackRestart, { hostId: "h1", stack: "attic" });
    const running: StackRestartView = {
      hostId: "h1",
      stack: "attic",
      names: ["attic-postgres", "attic-redis", "attic"],
      status: "running",
      current: "attic-postgres",
      done: [],
      failed: null,
      outcome: null,
      refusal: null,
    };
    const fetch = serve({
      [API_ROUTES.containers]: [
        container({}),
        container({ name: "attic-postgres", state: "exited", health: "none" }),
        container({ name: "attic-redis", health: "unhealthy" }),
      ],
      [`POST ${restartPath}`]: running,
    });
    show(<HostContainers host={alder(false)} admin />);
    const header = await screen.findByRole("rowheader", { name: /^attic/ });
    // One stopped and one running but unhealthy: only one of the three is up.
    expect(within(header).getByText("1 of 3 up")).toBeTruthy();
    fireEvent.click(within(header).getByRole("button", { name: "Restart stack attic" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(restartPath, expect.objectContaining({ method: "POST" })));
    expect(await within(header).findByText("Restarting attic-postgres, 1 of 3")).toBeTruthy();
    expect((within(header).getByRole("button", { name: "Restart stack attic" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
  it("says where a stack's restart stopped, until that container is up again", async () => {
    const stopped: StackRestartView = {
      hostId: "h1",
      stack: "attic",
      names: ["attic-postgres", "attic"],
      status: "stopped",
      current: null,
      done: [],
      failed: "attic-postgres",
      outcome: "Could not restart attic-postgres: the container is gone.",
      refusal: null,
    };
    const down = container({ name: "attic-postgres", state: "exited", health: "none" });
    serve({ [API_ROUTES.containers]: [container({}), down], [STACK_RESTARTS]: stopped });
    show(<HostContainers host={alder(false)} admin />);
    const header = await screen.findByRole("rowheader", { name: /^attic/ });
    expect(
      await within(header).findByText(
        "Stopped at attic-postgres: Could not restart attic-postgres: the container is gone.",
      ),
    ).toBeTruthy();

    cleanup();
    serve({
      [API_ROUTES.containers]: [container({}), container({ name: "attic-postgres" })],
      [STACK_RESTARTS]: stopped,
    });
    const client = show(<HostContainers host={alder(false)} admin />);
    expect(within(await screen.findByRole("rowheader", { name: /^attic/ })).getByText("2 of 2 up")).toBeTruthy();
    await waitFor(() => expect(client.getQueryData(stackRestartQuery("h1").queryKey)).toEqual(stopped));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.queryByText(/Stopped at/)).toBeNull();
  });
  it("offers a viewer Restart stack only with a grant on every container it would restart", async () => {
    // Grants name hosts by id, which the dashboard checks is a UUID.
    const hostId = "66cc4c4e-efb1-4a02-9e0b-f9ba7c2e7b92";
    const host = { ...alder(false), id: hostId };
    const viewer: SessionView = { ...session, user: { ...session.user, role: "viewer" } };
    const routes = (scope: "container" | "stack") => ({
      [API_ROUTES.containers]: [container({ hostId }), container({ name: "attic-postgres", hostId })],
      [apiPath(API_ROUTES.containerUpdates, { hostId })]: null,
      [apiPath(API_ROUTES.stackRestarts, { hostId })]: null,
      ...noPanels(hostId),
      [API_ROUTES.accountPermissions]: {
        revision: 1,
        grants: [{ hostId, scope, resource: "attic", actions: ["lifecycle"] }],
      },
    });
    serve(routes("container"));
    show(<HostContainers host={host} admin={false} />, viewer);
    // attic is granted, so its own row offers its restart; attic-postgres is not, so the stack is not the viewer's.
    expect(await screen.findByRole("button", { name: "Restart attic" })).toBeTruthy();
    const header = screen.getByRole("rowheader", { name: /^attic/ });
    expect(within(header).queryByRole("button", { name: "Restart stack attic" })).toBeNull();

    cleanup();
    serve(routes("stack"));
    show(<HostContainers host={host} admin={false} />, viewer);
    const granted = await screen.findByRole("rowheader", { name: /^attic/ });
    expect(await within(granted).findByRole("button", { name: "Restart stack attic" })).toBeTruthy();
  });
  it("sets what one container does when it fails, or when a new image is out, as the control plane keeps it", async () => {
    const fetch = serve({ [API_ROUTES.containers]: CONTAINERS });
    show(<HostContainers host={alder(false)} admin />);

    const bento = (await screen.findByRole("combobox", { name: "If BentoPDF fails" })) as HTMLSelectElement;
    expect(bento.value).toBe("ask");
    fireEvent.change(bento, { target: { value: "restart" } });
    await sent(fetch, TICKS, "PUT", { names: ["BentoPDF"], restart: "restart" });
    await waitFor(() => expect(bento.value).toBe("restart"));

    fireEvent.change(screen.getByRole("combobox", { name: "When a new image of attic is out" }), {
      target: { value: "apply" },
    });
    await sent(fetch, TICKS, "PUT", { names: ["attic"], update: "apply" });

    fireEvent.change(bento, { target: { value: "tell" } });
    await sent(fetch, TICKS, "PUT", { names: ["BentoPDF"], restart: "tell" });
    fireEvent.change(screen.getByRole("combobox", { name: "When a new image of attic is out" }), {
      target: { value: "never" },
    });
    await sent(fetch, TICKS, "PUT", { names: ["attic"], update: "never" });
  });
  it("shows the old container an update keeps aside with nothing to choose", async () => {
    const available = { status: "available" as const, checkedAt: 1, remote: null, reason: null };
    serve({
      [API_ROUTES.containers]: [
        container({ name: "BentoPDF", composeProject: "bentopdf", update: { ...available, policy: "ask" } }),
        container({
          name: "BentoPDF-autoheal-old",
          composeProject: "bentopdf",
          state: "exited",
          update: { ...available, policy: "off" },
          byItself: { restart: "ask", update: "ask", restartLock: "parked", updateLock: "parked" },
          handsOff: "parked",
        }),
      ],
    });
    show(<HostContainers host={alder(false)} admin />);

    const parked = (await screen.findByRole("button", { name: "BentoPDF-autoheal-old" })).closest("tr")!;
    expect(within(parked).getByText("Kept aside by an update, for rolling back")).toBeTruthy();
    expect(within(parked).getByText("updates off")).toBeTruthy();
    expect(within(parked).queryByRole("combobox")).toBeNull();
  });
  it("says how many of its hourly restarts Autoheal used on a container, and warns when none are left", async () => {
    serve({ [API_ROUTES.containers]: CONTAINERS });
    show(<HostContainers host={{ ...alder(false), restartBudget: { attic: 1, BentoPDF: 2 } }} admin />);

    const attic = (await screen.findByRole("button", { name: "attic" })).closest("tr")!;
    expect(within(attic).getByText("Restarted by Autoheal 1 of 2 times this hour").className).toBe(
      "restarts-used muted",
    );
    const bento = screen.getByRole("button", { name: "BentoPDF" }).closest("tr")!;
    expect(within(bento).getByText("Restarted by Autoheal 2 of 2 times this hour").className).toBe(
      "restarts-used text-warning",
    );
    const postgres = screen.getByRole("button", { name: "attic-postgres" }).closest("tr")!;
    expect(within(postgres).queryByText(/Restarted by Autoheal/)).toBeNull();
  });
  it("says when Autoheal may act on a container again, and lets an admin reset its used-up restarts", async () => {
    const now = Date.now();
    const againAt = now + 30 * 60_000;
    const looksAgainAt = now + 4 * 60_000;
    const host: HostView = {
      ...alder(false),
      restartBudget: { attic: 1, BentoPDF: 2 },
      restartWait: {
        attic: { againAt: null, looksAgainAt },
        BentoPDF: { againAt, looksAgainAt },
        "attic-postgres": { againAt: null, looksAgainAt },
        // A wait that ended a minute ago says nothing now.
        autoheal: { againAt: null, looksAgainAt: now - 60_000 },
      },
      restartResets: {},
    };
    const resetPath = apiPath(API_ROUTES.restartsReset, { hostId: "h1", containerName: "BentoPDF" });
    const fetch = serve({ [API_ROUTES.containers]: CONTAINERS, [`POST ${resetPath}`]: null });
    show(<HostContainers host={host} admin />);
    const text = TEXT.hostContainers;
    const line = (...parts: string[]) => parts.join(TEXT.separator);

    const bento = (await screen.findByRole("button", { name: "BentoPDF" })).closest("tr")!;
    expect(within(bento).getByText(line(text.restartsUsed(2), text.againFrom(timeOfDay(againAt))))).toBeTruthy();
    const attic = screen.getByRole("button", { name: "attic" }).closest("tr")!;
    expect(within(attic).getByText(line(text.restartsUsed(1), text.looksAgain(timeOfDay(looksAgainAt))))).toBeTruthy();
    // A restart left: nothing to reset.
    expect(within(attic).queryByRole("button", { name: text.resetLabel("attic") })).toBeNull();
    const postgres = screen.getByRole("button", { name: "attic-postgres" }).closest("tr")!;
    expect(within(postgres).getByText(text.looksAgainAlone(timeOfDay(looksAgainAt)))).toBeTruthy();
    const runner = screen.getByRole("button", { name: "autoheal" }).closest("tr")!;
    expect(within(runner).queryByText(/looks at it again/)).toBeNull();

    fireEvent.click(within(bento).getByRole("button", { name: text.resetLabel("BentoPDF") }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(resetPath, expect.objectContaining({ method: "POST" })));
    expect(await within(bento).findByText(/reset: clears with its next report/)).toBeTruthy();
    expect(within(bento).queryByRole("button", { name: text.resetLabel("BentoPDF") })).toBeNull();
  });
  it("offers no Reset to a viewer, nor on a host whose runner takes none", async () => {
    const spent = { ...alder(false), restartBudget: { BentoPDF: 2 } };
    const reset = { name: TEXT.hostContainers.resetLabel("BentoPDF") };
    serve({ [API_ROUTES.containers]: CONTAINERS });
    const waits = { BentoPDF: { againAt: Date.now() + 60_000, looksAgainAt: null } };
    show(<HostContainers host={{ ...spent, restartWait: waits }} admin={false} />);
    const bento = (await screen.findByRole("button", { name: "BentoPDF" })).closest("tr")!;
    expect(within(bento).getByText(/Restarted by Autoheal 2 of 2 times this hour/)).toBeTruthy();
    expect(within(bento).queryByRole("button", reset)).toBeNull();

    cleanup();
    serve({ [API_ROUTES.containers]: CONTAINERS });
    show(<HostContainers host={{ ...spent, restartWait: null }} admin />);
    const older = (await screen.findByRole("button", { name: "BentoPDF" })).closest("tr")!;
    expect(within(older).getByText("Restarted by Autoheal 2 of 2 times this hour")).toBeTruthy();
    expect(within(older).queryByRole("button", reset)).toBeNull();
  });
  it("lists every container, and finds one by its name or image", async () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      container({
        name: `app-${String(index + 1).padStart(2, "0")}`,
        composeProject: null,
        image: `example/app:${index}`,
      }),
    );
    serve({ [API_ROUTES.containers]: many });
    show(<HostContainers host={alder(false)} admin />);

    expect(await screen.findByRole("button", { name: "app-12" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^app-\d+$/ })).toHaveLength(12);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "app:11" } });
    expect(screen.getByRole("button", { name: "app-12" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "app-01" })).toBeNull();
  });
});

it("opens networks and volumes in place of the list, keeps its ticks, and comes back", async () => {
  serve({
    [API_ROUTES.containers]: CONTAINERS,
    [apiPath(API_ROUTES.hostNetworks, { hostId: "h1" })]: {
      networks: [
        {
          name: "wyrmrss_default",
          driver: "bridge",
          subnet: "192.168.96.0/20",
          gateway: "192.168.96.1",
          internal: false,
          project: "wyrmrss",
          projectHere: false,
          own: false,
          members: [],
        },
      ],
      lastJob: null,
    },
  });
  show(<HostContainers host={alder(false)} admin />);
  const button = (name: string | RegExp) => screen.findByRole("button", { name });
  fireEvent.click(await screen.findByRole("checkbox", { name: "Tick attic" }));
  const find = screen.getByRole("searchbox");
  fireEvent.change(find, { target: { value: "attic" } });

  fireEvent.click(await button("Networks 1 left behind"));
  expect((await button(/^Not used/)).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("heading", { name: /^Networks/ })).toBeTruthy();
  expect((find as HTMLInputElement).value).toBe("");
  expect(find.getAttribute("placeholder")).toBe(TEXT.hostContainers.findNamePlaceholder);
  expect(screen.queryByRole("button", { name: "attic" })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: "Tick attic" })).toBeNull();
  const shows = screen.getByRole("group", { name: TEXT.hostContainers.showLabel });
  expect(within(shows).getByRole("button", { name: /^All/ }).getAttribute("aria-pressed")).toBe("false");

  fireEvent.click(await button("Volumes 0"));
  expect(screen.getByRole("heading", { name: /^Volumes/ })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: /^Networks/ })).toBeNull();

  fireEvent.click(within(shows).getByRole("button", { name: /^All/ }));
  expect(screen.getByRole("heading", { name: new RegExp(`^${TEXT.hostContainers.title}`) })).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: "Tick attic" }) as HTMLInputElement).checked).toBe(true);
});
