import { describe, expect, it } from "vitest";
import type { BoardView, HostPackagesView, IncidentSummaryView, TaskSummaryView } from "../../src/shared/api.js";
import { TASK_ABOUT, UPDATE_CHECK_INTERVAL_MILLISECONDS } from "../../src/shared/constants.js";
import {
  doneByItself,
  fleetCounts,
  lookAtPlaces,
  needsYouPlaces,
  nextImageCheckIn,
  snoozedTasks,
  type PlacesInput,
} from "./attention-places.js";
import { TEXT } from "./constants.js";
import { alder, handedOver, updateTask, waitingImage } from "./test-support/attention-page.js";

const rowan = { ...alder, id: "h2", label: "Rowan" };
const task = (id: string, overrides: Partial<TaskSummaryView> = {}): TaskSummaryView => ({
  ...updateTask(id, null),
  id,
  title: id,
  labels: [],
  resource: null,
  priority: "medium",
  ...overrides,
});
const taskCard = (summary: TaskSummaryView) => ({ kind: "task" as const, task: summary });
const incidentCard = (incident: IncidentSummaryView) => ({ kind: "incident" as const, incident });
const emptyBoard: BoardView = { needsYou: [], autoheal: [], noticed: [], done: [] };
const input = (board: Partial<BoardView>, more: Partial<PlacesInput> = {}): PlacesInput => ({
  board: { ...emptyBoard, ...board },
  hosts: [alder, rowan],
  containers: [waitingImage("quantum")],
  packages: new Map(),
  homeAssistantUpdates: [],
  ...more,
});

describe("what needs a person, place by place", () => {
  it("puts each thing on its host's card, a silent host first, then what presses, then the updates", () => {
    const silent = task("silent", {
      hostId: "h2",
      hostLabel: "Rowan",
      about: TASK_ABOUT.runnerSilent,
      priority: "high",
    });
    const disk = task("disk", { hostId: "h2", hostLabel: "Rowan", priority: "urgent" });
    const places = needsYouPlaces(
      input({
        needsYou: [taskCard(updateTask("quantum", null)), taskCard(disk), taskCard(silent)],
      }),
    );
    expect(places.map((place) => place.hostLabel)).toEqual(["Rowan", "Alder"]);
    // Its runner's silence before the disk, though the disk's task presses more.
    expect(places[0]!.problems.map(({ id }) => id)).toEqual(["silent", "disk"]);
    expect(places[1]!.updates?.tasks.map(({ id }) => id)).toEqual(["task-quantum"]);
  });

  it("puts a host gone quiet before all, even a decision elsewhere", () => {
    const silent = task("silent", { hostId: "h2", hostLabel: "Rowan", about: TASK_ABOUT.runnerSilent });
    const places = needsYouPlaces(
      input(
        { needsYou: [incidentCard(handedOver), taskCard(silent)] },
        { hosts: [alder, { ...rowan, state: "silent" }] },
      ),
    );
    expect(places.map((place) => place.hostLabel)).toEqual(["Rowan", "Alder"]);
  });

  it("puts a decision before what only updates, and a host that has nothing for anyone nowhere", () => {
    const places = needsYouPlaces(
      input({
        needsYou: [incidentCard({ ...handedOver, hostId: "h2", hostLabel: "Rowan" })],
        noticed: [taskCard(updateTask("quantum", null))],
      }),
    );
    expect(places.map((place) => place.hostLabel)).toEqual(["Rowan", "Alder"]);
    expect(places[0]!.decisions.map(({ id }) => id)).toEqual(["i1"]);
    expect(needsYouPlaces(input({}))).toEqual([]);
  });

  it("gives what has no host the place it belongs to, Home Assistant's own updates with it", () => {
    const device = task("device", {
      hostId: null,
      hostLabel: null,
      priority: "high",
      resource: { kind: "zigbee", id: "z1", label: "Porch light" },
    });
    const link = task("link", {
      hostId: null,
      hostLabel: null,
      priority: "high",
      resource: { kind: "network", id: "n1", label: "Office TV" },
    });
    const places = needsYouPlaces(
      input(
        { needsYou: [taskCard(device), taskCard(link)] },
        { homeAssistantUpdates: [{ title: "Core", installed: "1", latest: "2", releaseUrl: null }] },
      ),
    );
    const home = places.find((place) => place.kind === "home-assistant")!;
    expect(home.problems.map(({ id }) => id)).toEqual(["device"]);
    expect(home.homeAssistantUpdates).toHaveLength(1);
    expect(places.find((place) => place.kind === "network")!.problems.map(({ id }) => id)).toEqual(["link"]);
  });

  it("lets a host's package list stand for its updates task, and shows a reboot beside it", () => {
    const upgrades = task("upgrades", { hostId: "h1", labels: ["packages"], about: TASK_ABOUT.osUpdates });
    const reboot = task("reboot", { hostId: "h1", labels: ["packages"], about: TASK_ABOUT.reboot });
    const listed = { packages: [{ name: "openssl", security: true }], automatic: [] } as unknown as HostPackagesView;
    const board = { needsYou: [taskCard(upgrades), taskCard(reboot)] };
    const [withList] = needsYouPlaces(input(board, { packages: new Map([["h1", listed]]) }));
    expect(withList!.updates?.hostTasks.map(({ id }) => id)).toEqual(["reboot"]);
    expect(withList!.updates?.packages).toBe(listed);
    const [withoutList] = needsYouPlaces(input(board));
    expect(withoutList!.updates?.hostTasks.map(({ id }) => id)).toEqual(["upgrades", "reboot"]);
  });
});

describe("what waits for a look, and what was put off", () => {
  const camera = task("camera", {
    hostId: null,
    hostLabel: null,
    resource: { kind: "watched", id: "w1", label: "Camera" },
  });
  const plug = task("plug", { hostId: null, hostLabel: null, resource: { kind: "watched", id: "w2", label: "Plug" } });
  const usage = task("usage", { hostId: "h1", hostLabel: "Alder" });
  const battery = task("battery", { snoozedUntil: Date.UTC(2027, 4, 2) });
  const sooner = task("sooner", { snoozedUntil: Date.UTC(2027, 0, 2) });
  const board = {
    noticed: [usage, camera, plug, battery, sooner, updateTask("quantum", null)].map(taskCard),
  };

  it("groups what was noticed by place, the place with most first, leaving out updates and what was put off", () => {
    const places = lookAtPlaces({ ...emptyBoard, ...board });
    expect(places.map((place) => [place.kind, place.tasks.map(({ id }) => id)])).toEqual([
      ["home-assistant", ["camera", "plug"]],
      ["host", ["usage"]],
    ]);
  });

  it("lists what was put off, the soonest back first", () => {
    expect(snoozedTasks({ ...emptyBoard, ...board }).map(({ id }) => id)).toEqual(["sooner", "battery"]);
  });
});

describe("the fleet's few numbers", () => {
  it("counts hosts online and containers running, and finds the fullest disk and its host", () => {
    const disk = (usedBytes: number) => ({ path: "/", totalBytes: 100, usedBytes, availableBytes: 100 - usedBytes });
    const health = (usedBytes: number) => ({ disks: [disk(usedBytes)] }) as never;
    const counts = fleetCounts([
      { ...alder, health: health(40), runningCount: 3, containerCount: 4 },
      { ...rowan, state: "silent", health: health(96), runningCount: 2, containerCount: 2 },
    ]);
    expect(counts).toMatchObject({ online: 1, total: 2, running: 5, containers: 6 });
    expect(counts.fullest?.host.label).toBe("Rowan");
    expect(fleetCounts([]).fullest).toBeNull();
  });

  it("knows when the next image check is due from each host's newest check, and nothing once one is overdue", () => {
    const now = Date.UTC(2026, 10, 25, 12);
    const checked = (hostId: string, minutesAgo: number) =>
      waitingImage(`app-${hostId}-${minutesAgo}`, {
        hostId,
        update: { status: "current", checkedAt: now - minutesAgo * 60_000, policy: "ask", remote: null, reason: null },
      });
    const containers = [checked("h1", 50), checked("h1", 10), checked("h2", 30)];
    expect(nextImageCheckIn(containers, now)).toBe(UPDATE_CHECK_INTERVAL_MILLISECONDS - 30 * 60_000);
    expect(nextImageCheckIn([checked("h1", 90)], now)).toBeNull();
    expect(nextImageCheckIn([], now)).toBeNull();
  });

  it("counts what Autoheal healed and the updates that went in by themselves in the last day", () => {
    const healed = incidentCard({ ...handedOver, verdict: "restarted" } as never);
    const settledOtherwise = incidentCard({ ...handedOver, id: "i2", verdict: "dismissed" } as never);
    const byAutoheal = taskCard({
      ...updateTask("quantum", null),
      assignee: { kind: "agent", id: "autoheal", name: "Autoheal" },
    });
    const byPerson = taskCard(updateTask("radicale", null));
    expect(doneByItself({ ...emptyBoard, done: [healed, settledOtherwise, byAutoheal, byPerson] })).toEqual({
      healed: 1,
      updated: 1,
    });
  });
});

describe("what the title says", () => {
  it("counts what needs a person and on how many hosts, then what waits for a look, or that all is in hand", () => {
    const { lede } = TEXT.attention;
    expect(lede(8, 3, 6)).toBe("8 things need you, on 3 hosts. 6 more wait for a look when you have time.");
    expect(lede(1, 0, 1)).toBe("1 thing needs you. 1 more waits for a look when you have time.");
    expect(lede(2, 1, 0)).toBe("2 things need you, on 1 host. Everything else is running or already in hand.");
    expect(lede(0, 0, 12)).toBe("Nothing needs you. 12 things wait for a look when you have time.");
    expect(lede(0, 0, 0)).toBe("Nothing needs you. Everything is running or already in hand.");
  });
});
