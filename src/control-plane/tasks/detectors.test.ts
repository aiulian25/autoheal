import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
  runnerTokenOf,
} from "../../../test/support/control-plane.js";
import { containerSnapshot, heartbeatWith, hostHealth, hostMetrics } from "../../../test/support/inventory.js";
import { fillNotificationQueue } from "../../../test/support/notifications.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import {
  API_ERRORS,
  API_ROUTES,
  UNKNOWN_HOME_ASSISTANT_SYSTEM,
  apiPath,
  type EnrolledHostView,
  type HomeAssistantView,
  type OllamaStatusView,
  type TaskDetailView,
  type TaskSummaryView,
  type ZigbeeDeviceView,
} from "../../shared/api.js";
import {
  BYTES_PER_GIBIBYTE,
  DETECTOR_GRACE_MILLISECONDS,
  DETECTOR_KEY_SEPARATOR,
  DETECTOR_KEYS,
  HOST_SILENT_AFTER_MILLISECONDS,
  METRICS_INTERVAL_MILLISECONDS,
  NOTIFY_TEXT,
  TASK_SNOOZE,
} from "../../shared/constants.js";
import {
  RUNNER_ROUTES,
  type ContainerSnapshot,
  type DriveHealth,
  type Heartbeat,
  type HostHealth,
} from "../../shared/protocol.js";
import { DetectorService, type DetectorDependencies } from "./detector-service.js";
import type { NotifiedTask } from "../notifications/notifier.js";

const MINUTE = 60_000;

const ollamaStatus = (overrides: Partial<OllamaStatusView> = {}): OllamaStatusView => ({
  reachable: true,
  checkedAt: 1,
  error: null,
  version: "0.12.0",
  model: "qwen3:4b-instruct",
  modelPresent: true,
  facts: null,
  models: [],
  loaded: [],
  ...overrides,
});

const zigbeeDevice = (id: string, overrides: Partial<ZigbeeDeviceView> = {}): ZigbeeDeviceView => ({
  id,
  name: `Sensor ${id}`,
  area: "Kitchen",
  manufacturer: "SONOFF",
  model: "SNZB-02D",
  role: "end_device",
  available: true,
  batteryPercent: 80,
  linkQuality: 120,
  lastSeen: 1,
  problems: [],
  ...overrides,
});

const homeAssistantView = (overrides: Partial<HomeAssistantView> = {}): HomeAssistantView => ({
  status: { configured: true, connected: true, version: "2026.10.2", error: null, connectedSince: 1 },
  system: UNKNOWN_HOME_ASSISTANT_SYSTEM,
  zigbee: [],
  safety: [],
  watched: [],
  entities: 0,
  unavailableEntities: 0,
  ...overrides,
});

describe("detectors", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let token: string;
  let hostId: string;
  let opened: [string, boolean][];
  let resolved: string[];
  let homeAssistant: HomeAssistantView | null;
  let ollama: OllamaStatusView;
  let detector: DetectorService;
  let dependencies: DetectorDependencies;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    token = runnerTokenOf(enrolled);
    hostId = enrolled.host.id;
    opened = [];
    resolved = [];
    homeAssistant = null;
    ollama = ollamaStatus();
    const { services } = controlPlane;
    dependencies = {
      tasks: services.tasksService,
      inventory: services.inventoryService,
      metrics: services.metricsStore,
      homeAssistant: { view: () => homeAssistant! },
      ollama: { status: () => ollama },
      notifier: {
        taskOpened: async (task: NotifiedTask, reopened: boolean) => void opened.push([task.title, reopened]),
        taskResolved: async (task: NotifiedTask) => void resolved.push(task.title),
      },
      packages: services.hostPackages,
      hostControl: services.hostControl,
      clock: () => controlPlane.clock.now,
    };
    detector = new DetectorService(dependencies);
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
    vi.restoreAllMocks();
  });

  const report = async (containers: ContainerSnapshot[], overrides: Partial<Heartbeat> = {}, runnerToken = token) => {
    const response = await controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      payload: heartbeatWith({ containers, dryRun: false, ...overrides }),
      headers: { authorization: `Bearer ${runnerToken}` },
    });
    expect(response.statusCode).toBe(200);
  };
  const later = (milliseconds: number) => {
    controlPlane.clock.now += milliseconds;
  };
  const tasks = async (query = "?status=open") =>
    (await admin.get(`${API_ROUTES.tasks}${query}`)).json<TaskSummaryView[]>();
  const detail = async (taskId: string) =>
    (await admin.get(apiPath(API_ROUTES.task, { taskId }))).json<TaskDetailView>();
  const crashed = containerSnapshot({ name: "tika", state: "exited", exitCode: 1, health: "none" });
  const running = containerSnapshot({ name: "tika" });

  it("opens a task once a container has been down for its grace period, and closes it when it recovers", async () => {
    await report([crashed]);
    await detector.run();
    expect(await tasks()).toEqual([]);

    later(2 * MINUTE);
    await report([crashed]);
    await detector.run();
    const [task] = await tasks();
    expect(task).toMatchObject({
      title: "tika crashed on Alder",
      priority: "medium",
      source: "detector",
      hostLabel: "Alder",
    });
    expect(task!.assignee).toMatchObject({ kind: "user", name: "admin" });
    expect(opened).toEqual([["tika crashed on Alder", false]]);

    await detector.run();
    expect(opened).toHaveLength(1);

    await report([running]);
    await detector.run();
    expect(await tasks()).toEqual([]);
    const closed = await detail(task!.id);
    expect(closed).toMatchObject({ status: "done" });
    expect(closed.activity.map((entry) => entry.kind)).toContain("cleared");
    // The notifier decides by priority whether it is worth saying.
    expect(resolved).toEqual(["tika crashed on Alder"]);

    later(MINUTE);
    await report([crashed]);
    await detector.run();
    later(2 * MINUTE);
    await detector.run();
    expect((await tasks()).map((entry) => [entry.id, entry.occurrences])).toEqual([[task!.id, 2]]);
    expect(opened).toEqual([
      ["tika crashed on Alder", false],
      ["tika crashed on Alder", true],
    ]);
  });

  it("leaves a task a person closed alone while its problem goes on, and opens a new one if it comes back", async () => {
    await report([crashed]);
    await detector.run();
    later(2 * MINUTE);
    await detector.run();
    const [task] = await tasks();
    await admin.request({
      method: "PATCH",
      url: apiPath(API_ROUTES.task, { taskId: task!.id }),
      payload: { status: "cancelled" },
    });

    later(MINUTE);
    await report([crashed]);
    await detector.run();
    expect(await tasks()).toEqual([]);

    await report([running]);
    await detector.run();
    later(20 * MINUTE);
    await report([crashed]);
    await detector.run();
    later(2 * MINUTE);
    await report([crashed]);
    await detector.run();
    const [again] = await tasks();
    expect(again!.id).not.toBe(task!.id);
  });

  it("comments instead of closing when someone is working on the task, and counts it when it comes back", async () => {
    await report([crashed]);
    await detector.run();
    later(2 * MINUTE);
    await detector.run();
    const [task] = await tasks();
    await admin.request({
      method: "PATCH",
      url: apiPath(API_ROUTES.task, { taskId: task!.id }),
      payload: { status: "in_progress" },
    });

    await report([running]);
    await detector.run();
    await detector.run();
    const cleared = await detail(task!.id);
    expect(cleared.status).toBe("in_progress");
    expect(cleared.activity.filter((entry) => entry.kind === "cleared")).toHaveLength(1);

    // Back for longer than a blip: it waits out its grace period again, then counts.
    later(MINUTE);
    await report([crashed]);
    await detector.run();
    expect((await detail(task!.id)).occurrences).toBe(1);
    later(2 * MINUTE);
    await report([crashed]);
    await detector.run();
    const again = await detail(task!.id);
    expect(again.occurrences).toBe(2);
    expect(again.activity.at(-1)?.kind).toBe("happened_again");
  });

  it("opens a high task when a host goes silent, and says so when it is back", async () => {
    await report([running]);
    later(HOST_SILENT_AFTER_MILLISECONDS + 1);
    await detector.run();
    const [silent] = await tasks();
    expect(silent).toMatchObject({ title: "The runner on Alder stopped reporting", priority: "high" });

    await report([running]);
    await detector.run();
    expect(await tasks()).toEqual([]);
    expect(resolved).toEqual(["The runner on Alder stopped reporting"]);
  });

  it("opens and closes every task in a pass while no alert can be queued, and logs each one it lost", async () => {
    const delta = runnerTokenOf((await admin.post(API_ROUTES.hosts, { label: "Delta" })).json<EnrolledHostView>());
    const telling = new DetectorService({ ...dependencies, notifier: controlPlane.services.notifier });
    const printed = vi.spyOn(console, "log").mockImplementation(() => {});
    fillNotificationQueue(controlPlane.services.databaseHandle, controlPlane.clock.now);
    await report([running]);
    await report([running], {}, delta);
    later(HOST_SILENT_AFTER_MILLISECONDS + 1);
    await telling.run();
    expect((await tasks()).map((task) => task.title).sort()).toEqual([
      "The runner on Alder stopped reporting",
      "The runner on Delta stopped reporting",
    ]);

    await report([running]);
    await report([running], {}, delta);
    await telling.run();
    expect(await tasks()).toEqual([]);
    expect(controlPlane.services.notificationDeliveries.rules().overflowCount).toBe(4);
    const lost = NOTIFY_TEXT.notQueued(API_ERRORS.notificationQueueFull);
    expect(printed.mock.calls.filter(([line]) => String(line).endsWith(lost))).toHaveLength(4);
  });

  it("opens a high task while a runner's recovery hold waits for a fix, and none for the hour after a new install", async () => {
    await report([running], { recoveryHold: { reason: "no_saved_state", until: controlPlane.clock.now + MINUTE } });
    await detector.run();
    expect(await tasks()).toEqual([]);

    await report([running], { recoveryHold: { reason: "save_failed", until: null } });
    await detector.run();
    expect(await tasks()).toMatchObject([
      {
        title: "Automatic recovery is held on Alder",
        priority: "high",
        hostId,
        resource: { kind: "host", id: hostId, label: "Alder" },
      },
    ]);

    await report([running]);
    await detector.run();
    expect(await tasks()).toEqual([]);
    expect(resolved).toEqual(["Automatic recovery is held on Alder"]);
  });

  it("opens a high task when a reporting host's runner has lost Docker's events, and closes it when they are back", async () => {
    const lost = { eventStreamConnected: false };
    await report([running], lost);
    await detector.run();
    later(DETECTOR_GRACE_MILLISECONDS.healingPaused / 2);
    await report([running], lost);
    await detector.run();
    expect(await tasks()).toEqual([]);

    later(DETECTOR_GRACE_MILLISECONDS.healingPaused / 2);
    await report([running], lost);
    await detector.run();
    expect(await tasks()).toMatchObject([
      {
        title: "Healing is paused on Alder",
        priority: "high",
        hostId,
        resource: { kind: "host", id: hostId, label: "Alder" },
      },
    ]);

    await report([running]);
    await detector.run();
    expect(await tasks()).toEqual([]);
    expect(resolved).toEqual(["Healing is paused on Alder"]);
  });

  describe("a disk that is almost full", () => {
    const path = "/mnt/storage/disk1";
    const disk = {
      path,
      totalBytes: 100 * BYTES_PER_GIBIBYTE,
      usedBytes: 99 * BYTES_PER_GIBIBYTE,
      availableBytes: 1 * BYTES_PER_GIBIBYTE,
    };
    const reportFullDisk = async () => {
      const response = await controlPlane.runnerApp.inject({
        method: "POST",
        url: RUNNER_ROUTES.heartbeat,
        payload: heartbeatWith({ dryRun: false, host: hostHealth({ disks: [disk] }) }),
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
    };

    it("stays quiet when a snoozed disk goes under its limit and back, and the task stays snoozed", async () => {
      await reportFullDisk();
      await detector.run();
      expect(opened).toHaveLength(1);
      const [task] = await tasks();
      await admin.request({
        method: "PATCH",
        url: apiPath(API_ROUTES.task, { taskId: task!.id }),
        payload: { snoozed: TASK_SNOOZE.oneMonth },
      });

      await controlPlane.runnerApp.inject({
        method: "POST",
        url: RUNNER_ROUTES.heartbeat,
        payload: heartbeatWith({
          dryRun: false,
          host: hostHealth({
            disks: [{ ...disk, usedBytes: 50 * BYTES_PER_GIBIBYTE, availableBytes: 50 * BYTES_PER_GIBIBYTE }],
          }),
        }),
        headers: { authorization: `Bearer ${token}` },
      });
      await detector.run();
      expect(await tasks()).toEqual([]);

      await reportFullDisk();
      await detector.run();
      expect(opened).toHaveLength(1);
      expect((await tasks())[0]?.snoozedUntil).not.toBeNull();
    });

    it("opens a task about that disk on its host", async () => {
      await reportFullDisk();
      await detector.run();
      expect(await tasks()).toMatchObject([
        {
          title: `${path} on Alder is 99% full`,
          priority: "high",
          hostId,
          resource: { kind: "disk", id: path, label: path },
        },
      ]);
    });

    it("names the disk on a task opened before disk tasks named it", async () => {
      controlPlane.services.tasksService.openOrJoin({
        key: [DETECTOR_KEYS.disk, hostId, path].join(DETECTOR_KEY_SEPARATOR),
        title: `${path} on Alder is 99% full`,
        description: "",
        priority: "high",
        labels: [],
        hostId,
        resource: null,
        assignee: null,
        source: "detector",
      });
      await reportFullDisk();
      await detector.run();
      const [task] = await tasks();
      expect(task?.resource).toEqual({ kind: "disk", id: path, label: path });
    });

    describe("and the one Docker keeps its images on", () => {
      const root = {
        path: "/",
        totalBytes: 100 * BYTES_PER_GIBIBYTE,
        usedBytes: 93 * BYTES_PER_GIBIBYTE,
        availableBytes: 7 * BYTES_PER_GIBIBYTE,
      };
      const image = (digit: string, sizeBytes: number, keptByUpdate: boolean) => ({
        id: `sha256:${digit.repeat(64)}`,
        tags: [],
        repository: "ghcr.io/paperless-ngx/paperless-ngx",
        sizeBytes,
        createdAt: 1,
        keptByUpdate,
      });
      // The one kept for rolling back is never removed, so it is not counted.
      const reportImages = (dryRun: boolean) =>
        report([], {
          dryRun,
          host: hostHealth({ disks: [root, disk], imageStore: "/var/lib/containerd" }),
          unusedImages: [image("a", 14_200_000_000, false), image("b", 5_000_000_000, true)],
        });
      const cleanImages = async (imageCleanup: string) =>
        expect((await admin.put(apiPath(API_ROUTES.hostControl, { hostId }), { imageCleanup })).statusCode).toBe(200);
      const taskOn = async (diskPath: string) =>
        (await tasks()).find((candidate) => candidate.resource?.id === diskPath)!;

      it("says what the images no container uses take there, and nothing of them on another disk", async () => {
        await reportImages(false);
        await detector.run();
        const rootTask = await taskOn("/");
        expect(rootTask).toMatchObject({ title: "/ on Alder is 93% full", labels: ["disk"] });
        expect((await detail(rootTask.id)).description).toBe(
          "7 GB left. Images no container uses take up to 14.2 GB here; without them it would be about 80% full. The host's page lists them under Old images.",
        );
        expect((await detail((await taskOn(path)).id)).description).toBe(
          "1 GB left. Docker images, logs and backups are the usual suspects.",
        );
        // Image clean-up is off on the host's page: a person decides.
        expect(rootTask.assignee).toMatchObject({ kind: "user", name: "admin" });
      });

      it("counts what a nearly full small disk has left in megabytes", async () => {
        const boot = {
          path: "/boot",
          totalBytes: 2 * BYTES_PER_GIBIBYTE,
          usedBytes: 1900 * 1024 ** 2,
          availableBytes: 148 * 1024 ** 2,
        };
        await report([], { host: hostHealth({ disks: [boot] }) });
        await detector.run();
        expect((await detail((await taskOn("/boot")).id)).description).toBe(
          "148 MB left. Docker images, logs and backups are the usual suspects.",
        );
      });

      it("gives the task to Autoheal when the host's page lets it clean images, and the host is not dry-run", async () => {
        await cleanImages("weekly");
        await reportImages(false);
        await detector.run();
        expect((await taskOn("/")).assignee).toMatchObject({ kind: "agent", id: "autoheal" });
        expect((await taskOn(path)).assignee).toMatchObject({ kind: "user", name: "admin" });
      });

      it("keeps it with a person on a dry-run host", async () => {
        await cleanImages("monthly");
        await reportImages(true);
        await detector.run();
        expect((await taskOn("/")).assignee).toMatchObject({ kind: "user", name: "admin" });
      });
    });
  });

  describe("a host's drives and GPUs", () => {
    const DAY = 24 * 60 * MINUTE;
    const drive = (overrides: Partial<DriveHealth> = {}): DriveHealth => ({
      device: "nvme0n1",
      kind: "nvme",
      readAt: controlPlane.clock.now,
      reallocatedSectors: 0,
      pendingSectors: 0,
      uncorrectableSectors: 0,
      selfTestErrors: 0,
      errorLogEntries: 0,
      percentageUsed: 2,
      availableSpare: 100,
      warnings: [],
      ...overrides,
    });
    const reportHealth = async (health: Partial<HostHealth>) => {
      const response = await controlPlane.runnerApp.inject({
        method: "POST",
        url: RUNNER_ROUTES.heartbeat,
        payload: heartbeatWith({ dryRun: false, host: hostHealth(health) }),
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
    };
    const opened = async () => (await tasks()).map((task) => [task.title, task.priority]);

    it("opens a high task for a failing drive, a medium one for a worn one, none for an error log alone", async () => {
      const warning = { kind: "Health", count: 22, lastAt: controlPlane.clock.now - DAY };
      await reportHealth({
        drives: [
          drive({ device: "sda", kind: "ata", pendingSectors: 3, percentageUsed: null, availableSpare: null }),
          drive({ device: "nvme0n1", warnings: [warning], errorLogEntries: 5 }),
          drive({ device: "nvme1n1", percentageUsed: 85 }),
          drive({ device: "nvme2n1", errorLogEntries: 5 }),
          drive({ device: "nvme3n1", warnings: [{ ...warning, lastAt: controlPlane.clock.now - 8 * DAY }] }),
        ],
      });
      await detector.run();
      expect(await opened()).toEqual([
        ["Drive sda on Alder shows signs of wear or failure", "high"],
        ["Drive nvme0n1 on Alder shows signs of wear or failure", "high"],
        ["Drive nvme1n1 on Alder shows signs of wear or failure", "medium"],
      ]);
      const warned = (await tasks()).find((task) => task.title.includes("nvme0n1"))!;
      expect((await detail(warned.id)).description).toBe(
        "smartd raised 22 warnings (Health), the last on 2026-10-19 12:00 UTC; 5 entries in its error log. " +
          "As smartd last read it, on 2026-10-20 12:00 UTC. Back up what is on it and plan its replacement.",
      );

      await admin.post(apiPath(API_ROUTES.hostRevoke, { hostId }));
      await detector.run();
      expect(await tasks()).toEqual([]);
    });

    it("takes an NVMe drive's warnings for heat when its attribute log saw no other critical warning", async () => {
      const warnings = [{ kind: "Health", count: 22, lastAt: controlPlane.clock.now - DAY }];
      await reportHealth({
        drives: [
          drive({ device: "nvme0n1", warnings, criticalWarnings: 0b10, errorLogEntries: 5 }),
          // Its spare running out, besides the heat: failing.
          drive({ device: "nvme1n1", warnings, criticalWarnings: 0b11 }),
        ],
      });
      await detector.run();
      expect(await opened()).toEqual([["Drive nvme1n1 on Alder shows signs of wear or failure", "high"]]);
    });

    it("opens a task for a drive above its own temperature limit for ten minutes, not for a moment", async () => {
      const hot = { driveTemperatures: [{ device: "nvme0n1", celsius: 84, maximumCelsius: 82.85 }] };
      await reportHealth(hot);
      await detector.run();
      expect(await tasks()).toEqual([]);
      later(DETECTOR_GRACE_MILLISECONDS.driveHeat);
      await reportHealth(hot);
      await detector.run();
      expect(await opened()).toEqual([["Drive nvme0n1 on Alder is at 84 °C, above its 83 °C limit", "high"]]);
      // A drive that declares no limit is held to the usual one.
      await reportHealth({ driveTemperatures: [{ device: "nvme0n1", celsius: 60, maximumCelsius: null }] });
      await detector.run();
      expect(await tasks()).toEqual([]);
    });

    it("opens a task when a GPU stays above 85 °C for five minutes", async () => {
      const gpu = {
        name: "RTX 3060",
        utilizationPercent: 99,
        memoryUsedBytes: 1,
        memoryTotalBytes: 2,
        powerWatts: null,
      };
      const send = (celsius: number) =>
        controlPlane.runnerApp.inject({
          method: "POST",
          url: RUNNER_ROUTES.metrics,
          payload: { host: hostMetrics({ gpus: [{ ...gpu, temperatureCelsius: celsius }] }), containers: [] },
          headers: { authorization: `Bearer ${token}` },
        });
      for (let elapsed = 0; elapsed <= 5 * MINUTE; elapsed += 30 * METRICS_INTERVAL_MILLISECONDS) {
        await send(90);
        await report([running]);
        later(30 * METRICS_INTERVAL_MILLISECONDS);
      }
      controlPlane.clock.now -= 30 * METRICS_INTERVAL_MILLISECONDS;
      await detector.run();
      expect(await opened()).toEqual([["GPU RTX 3060 on Alder above 85 °C for 5 minutes", "high"]]);
    });
  });

  it("does not judge a silent host's containers: their tasks wait for the host to report again", async () => {
    await report([crashed]);
    await detector.run();
    later(2 * MINUTE);
    await detector.run();
    later(HOST_SILENT_AFTER_MILLISECONDS + 1);
    await detector.run();
    expect((await tasks()).map((task) => task.title).sort()).toEqual([
      "The runner on Alder stopped reporting",
      "tika crashed on Alder",
    ]);
  });

  it("gives an image update to Autoheal when the label says auto, and to the owner otherwise", async () => {
    const update = { status: "available" as const, checkedAt: 1, remoteDigest: `sha256:${"b".repeat(64)}` };
    await report(
      [
        containerSnapshot({ name: "whoami", update, updatePolicy: "auto" }),
        containerSnapshot({ name: "immich", update }),
        containerSnapshot({ name: "postgres", update, updatePolicy: "off" }),
        containerSnapshot({ name: "newt", update, updatePolicy: "auto" }),
        // What an update of whoami keeps aside for rolling back: no task of its own, whatever its label says.
        containerSnapshot({
          name: "whoami-autoheal-old",
          update,
          updatePolicy: "auto",
          state: "exited",
          exitCode: 143,
        }),
      ],
      { protectedContainers: ["newt"] },
    );
    await detector.run();
    const byTitle = Object.fromEntries((await tasks()).map((task) => [task.title, task]));
    expect(Object.keys(byTitle).sort()).toEqual([
      "Update immich on Alder",
      "Update newt on Alder",
      "Update whoami on Alder",
    ]);
    expect(byTitle["Update whoami on Alder"]).toMatchObject({ priority: "low", labels: ["update"] });
    expect(byTitle["Update whoami on Alder"]!.assignee).toEqual({ kind: "agent", id: "autoheal", name: "Autoheal" });
    expect(byTitle["Update immich on Alder"]!.assignee).toMatchObject({ kind: "user", name: "admin" });
    // Protected on its host: whatever the label says, a person updates it, and the task says how.
    const newt = await detail(byTitle["Update newt on Alder"]!.id);
    expect(newt.assignee).toMatchObject({ kind: "user", name: "admin" });
    expect(newt.description).toContain("newt is protected on Alder, so Autoheal never changes it.");

    // A restarted runner knows nothing until it checks again: the tasks stay.
    await report(
      [
        containerSnapshot({ name: "whoami", updatePolicy: "auto" }),
        containerSnapshot({ name: "immich" }),
        containerSnapshot({ name: "newt", updatePolicy: "auto" }),
      ],
      { protectedContainers: ["newt"] },
    );
    await detector.run();
    expect(await tasks()).toHaveLength(3);

    // Once the host's check has run, a container it gave no answer for cannot be checked (recreated from an image
    // id): no update waits for it, and its task closes with the one now current.
    const current = { ...update, status: "current" as const, checkedAt: 2 };
    await report(
      [
        containerSnapshot({ name: "whoami", update: current, updatePolicy: "auto" }),
        containerSnapshot({ name: "immich" }),
        containerSnapshot({ name: "newt", update, updatePolicy: "auto" }),
      ],
      { protectedContainers: ["newt"] },
    );
    await detector.run();
    expect((await tasks()).map((task) => task.title)).toEqual(["Update newt on Alder"]);
  });

  it("closes an image update once it waits no more, even while someone is on it: nothing is left to do", async () => {
    const update = { status: "available" as const, checkedAt: 1, remoteDigest: `sha256:${"b".repeat(64)}` };
    await report([containerSnapshot({ name: "immich", update })]);
    await detector.run();
    const [task] = await tasks();
    await admin.request({
      method: "PATCH",
      url: apiPath(API_ROUTES.task, { taskId: task!.id }),
      payload: { status: "in_progress" },
    });

    // Updated by hand: the host's check finds it on the newest image.
    await report([containerSnapshot({ name: "immich", update: { ...update, status: "current", checkedAt: 2 } })]);
    await detector.run();
    expect(await detail(task!.id)).toMatchObject({ status: "done" });
    expect(await tasks()).toEqual([]);
  });

  it("gives a reopened update to whoever has it now, after its container's choice changed to Autoheal applying it", async () => {
    const update = { status: "available" as const, checkedAt: 1, remoteDigest: `sha256:${"b".repeat(64)}` };
    await report([containerSnapshot({ name: "immich", update })]);
    await detector.run();
    const [first] = await tasks();
    expect(first!.assignee).toMatchObject({ kind: "user", name: "admin" });

    // Updated: the task closes. Then its owner hands its updates to Autoheal, and a newer image comes.
    await report([containerSnapshot({ name: "immich", update: { ...update, status: "current", checkedAt: 2 } })]);
    await detector.run();
    expect(await tasks()).toEqual([]);
    const newer = { ...update, checkedAt: 3, remoteDigest: `sha256:${"c".repeat(64)}` };
    await report([containerSnapshot({ name: "immich", update: newer, updatePolicy: "auto" })]);
    await detector.run();

    const [reopened] = await tasks();
    expect(reopened!.id).toBe(first!.id);
    expect(reopened!.assignee).toEqual({ kind: "agent", id: "autoheal", name: "Autoheal" });
  });

  it("names both versions in an update's title once the images say them, and only when they differ", async () => {
    const update = (version: string | null) => ({
      status: "available" as const,
      checkedAt: 1,
      remoteDigest: `sha256:${"b".repeat(64)}`,
      remote: { version, revision: null, source: null, createdAt: null },
      reason: null,
    });
    await report([
      containerSnapshot({ name: "immich", version: "v1.120.1", update: update(null) }),
      containerSnapshot({ name: "ollama", version: "24.04", update: update("24.04") }),
    ]);
    await detector.run();
    expect((await tasks()).map((task) => task.title).sort()).toEqual([
      "Update immich on Alder",
      "Update ollama on Alder",
    ]);

    await report([
      containerSnapshot({ name: "immich", version: "v1.120.1", update: update("v1.120.2") }),
      containerSnapshot({ name: "ollama", version: "24.04", update: update("24.04") }),
    ]);
    await detector.run();
    expect((await tasks()).map((task) => task.title).sort()).toEqual([
      "Update immich on Alder: v1.120.1 → v1.120.2",
      "Update ollama on Alder",
    ]);
  });

  it("tells of a newer version than a container's tag once per version, and lets the last one go", async () => {
    const checked = (newerTag?: string) => ({
      status: "current" as const,
      checkedAt: 1,
      remoteDigest: `sha256:${"b".repeat(64)}`,
      ...(newerTag === undefined ? {} : { newerTag }),
    });
    await report([
      containerSnapshot({ name: "paperless", update: checked("2.14") }),
      containerSnapshot({ name: "postgres", image: "postgres:16", update: checked("17"), updatePolicy: "off" }),
    ]);
    await detector.run();
    const [first] = await tasks();
    expect((await tasks()).map((task) => task.title)).toEqual(["2.14 is out for paperless on Alder"]);
    expect((await detail(first!.id)).description).toContain("ghcr.io/paperless-ngx/paperless-ngx:2.14");
    expect(first!.assignee).toMatchObject({ kind: "user", name: "admin" });

    // A later release is news of its own: a task of its own, and the earlier one closes.
    await report([containerSnapshot({ name: "paperless", update: checked("2.15") })]);
    await detector.run();
    expect((await tasks()).map((task) => task.title)).toEqual(["2.15 is out for paperless on Alder"]);
    expect(await detail(first!.id)).toMatchObject({ status: "done" });

    // Moved to it by hand: nothing newer is out, and the task closes.
    await report([
      containerSnapshot({ name: "paperless", image: "ghcr.io/paperless-ngx/paperless-ngx:2.15", update: checked() }),
    ]);
    await detector.run();
    expect(await tasks()).toEqual([]);
  });

  it("lists Home Assistant's own updates in one task that follows them, and closes it once none is left", async () => {
    const waiting = (...updates: [string, string, string][]) =>
      homeAssistantView({
        system: {
          ...UNKNOWN_HOME_ASSISTANT_SYSTEM,
          updates: updates.map(([title, installed, latest]) => ({ title, installed, latest, releaseUrl: null })),
        },
      });
    homeAssistant = waiting(["Home Assistant Core", "2026.10.2", "2026.10.3"], ["button-card", "v4.1.2", "v4.2.0"]);
    await detector.run();
    later(5 * MINUTE);
    await detector.run();
    const [task] = await tasks();
    expect(task).toMatchObject({
      title: "Home Assistant has 2 updates",
      priority: "low",
      labels: ["update"],
      hostId: null,
      resource: { kind: "home_assistant", id: "updates", label: "Home Assistant" },
    });
    expect((await detail(task!.id)).description).toBe(
      "Home Assistant Core 2026.10.2 → 2026.10.3; button-card v4.1.2 → v4.2.0. Install them in Home Assistant: Settings → System → Updates.",
    );

    homeAssistant = waiting(["button-card", "v4.1.2", "v4.2.0"]);
    await detector.run();
    expect((await tasks()).map((open) => open.title)).toEqual(["Home Assistant has 1 update"]);
    // Away, Home Assistant says nothing of its updates: the task stays as it was.
    homeAssistant = homeAssistantView({ status: { ...homeAssistantView().status, connected: false } });
    await detector.run();
    expect(await tasks()).toHaveLength(1);
    homeAssistant = waiting();
    await detector.run();
    expect(await tasks()).toEqual([]);
  });

  it("opens one task for a Zigbee outage, not one per device, and leaves Zigbee alone while Home Assistant is away", async () => {
    homeAssistant = homeAssistantView({
      zigbee: ["1", "2", "3", "4", "5"].map((id) => zigbeeDevice(id, { available: false, problems: ["unavailable"] })),
    });
    await detector.run();
    later(5 * MINUTE);
    await detector.run();
    expect((await tasks()).map((task) => task.title)).toEqual(["5 Zigbee devices are unavailable at once"]);

    // The outage grows: the same task, telling how big it is now.
    homeAssistant = homeAssistantView({
      zigbee: ["1", "2", "3", "4", "5", "6", "7"].map((id) =>
        zigbeeDevice(id, { available: false, problems: ["unavailable"] }),
      ),
    });
    await detector.run();
    expect((await tasks()).map((task) => task.title)).toEqual(["7 Zigbee devices are unavailable at once"]);
    expect(opened).toHaveLength(1);

    homeAssistant = homeAssistantView({ status: { ...homeAssistantView().status, connected: false } });
    await detector.run();
    expect(await tasks()).toHaveLength(1);
  });

  it("opens an urgent task for a safety device and a battery task by how low it is", async () => {
    homeAssistant = homeAssistantView({
      zigbee: [
        zigbeeDevice("kitchen", { name: "Kitchen Temp", batteryPercent: 9, problems: ["low_battery"] }),
        zigbeeDevice("porch", { name: "Porch Sensor", batteryPercent: 10, problems: ["low_battery"] }),
        // Exactly 20% is not low yet: its own page shows no problem, so no task either.
        zigbeeDevice("hall", { name: "Hall Sensor", batteryPercent: 20, problems: [] }),
      ],
      safety: [
        {
          id: "hall",
          name: "Hallway Smoke",
          area: "Hallway",
          model: "XS01-M",
          available: true,
          alarm: true,
          online: true,
          batteryLow: false,
          fault: false,
          problems: ["alarm"],
        },
      ],
    });
    await detector.run();
    const byTitle = Object.fromEntries((await tasks()).map((task) => [task.title, task]));
    expect(byTitle["Hallway Smoke: alarm"]).toMatchObject({ priority: "urgent", labels: ["safety"] });
    expect(byTitle["Kitchen Temp battery at 9%"]).toMatchObject({ priority: "medium", labels: ["battery"] });
    expect(byTitle["Porch Sensor battery at 10%"]).toMatchObject({ priority: "low" });
    expect(byTitle["Hall Sensor battery at 20%"]).toBeUndefined();
    expect(opened.map(([title]) => title).sort()).toEqual([
      "Hallway Smoke: alarm",
      "Kitchen Temp battery at 9%",
      "Porch Sensor battery at 10%",
    ]);

    // Once a person words the task their way, Autoheal leaves the words alone.
    const battery = byTitle["Kitchen Temp battery at 9%"]!;
    const renamed = await admin.request({
      method: "PATCH",
      url: apiPath(API_ROUTES.task, { taskId: battery.id }),
      payload: { title: "Buy a CR2032 for the kitchen" },
    });
    expect(renamed.statusCode).toBe(200);
    homeAssistant = {
      ...homeAssistant!,
      zigbee: [zigbeeDevice("kitchen", { name: "Kitchen Temp", batteryPercent: 6, problems: ["low_battery"] })],
    };
    await detector.run();
    expect((await detail(battery.id)).title).toBe("Buy a CR2032 for the kitchen");
  });

  it("opens a task when CPU stays above 90% for 10 minutes, not for a spike", async () => {
    await report([running]);
    const busy = hostMetrics({ cpu: { ...hostMetrics().cpu, busyPercent: 97 } });
    const send = (metrics: ReturnType<typeof hostMetrics>) =>
      controlPlane.runnerApp.inject({
        method: "POST",
        url: RUNNER_ROUTES.metrics,
        payload: { host: metrics, containers: [] },
        headers: { authorization: `Bearer ${token}` },
      });
    for (let elapsed = 0; elapsed <= 10 * MINUTE; elapsed += 30 * METRICS_INTERVAL_MILLISECONDS) {
      await send(elapsed === 5 * MINUTE ? hostMetrics() : busy);
      await report([running]);
      later(30 * METRICS_INTERVAL_MILLISECONDS);
    }
    await detector.run();
    expect(await tasks()).toEqual([]);

    for (let elapsed = 0; elapsed <= 10 * MINUTE; elapsed += 30 * METRICS_INTERVAL_MILLISECONDS) {
      await send(busy);
      await report([running]);
      later(30 * METRICS_INTERVAL_MILLISECONDS);
    }
    controlPlane.clock.now -= 30 * METRICS_INTERVAL_MILLISECONDS;
    await detector.run();
    expect((await tasks()).map((task) => task.title)).toEqual(["CPU on Alder above 90% for 10 minutes"]);
  });

  it("closes a revoked host's tasks: its problems are nobody's any more", async () => {
    await report([crashed], { eventStreamConnected: false });
    await detector.run();
    later(2 * MINUTE);
    await detector.run();
    expect(await tasks()).toHaveLength(2);
    await admin.post(apiPath(API_ROUTES.hostRevoke, { hostId }));
    await detector.run();
    expect(await tasks()).toEqual([]);
  });

  it("opens a task for a watched device Home Assistant cannot reach", async () => {
    homeAssistant = homeAssistantView({
      watched: [
        {
          id: "nas",
          name: "Synology DS923+",
          integration: "synology_dsm",
          area: null,
          available: false,
          problems: [],
          updatesAvailable: 0,
        },
      ],
    });
    await detector.run();
    later(5 * MINUTE);
    await detector.run();
    const [task] = await tasks();
    expect(task).toMatchObject({ title: "Synology DS923+ (synology_dsm) reports a problem", priority: "medium" });
    expect((await detail(task!.id)).description).toBe("Seen through Home Assistant: unavailable.");
  });

  it("opens a task when Ollama stops answering for 3 minutes, or lacks the model", async () => {
    ollama = ollamaStatus({ reachable: false, error: "connect ECONNREFUSED" });
    await detector.run();
    later(3 * MINUTE);
    await detector.run();
    expect((await tasks()).map((task) => task.title)).toEqual(["Ollama is not answering"]);

    ollama = ollamaStatus({ modelPresent: false });
    await detector.run();
    expect((await tasks()).map((task) => task.title)).toEqual(["Ollama does not have qwen3:4b-instruct"]);
  });

  it("opens the container's task when the runner reports an incident, and links each one after it", async () => {
    await report([crashed]);
    const submitIncident = async () => {
      const submitted = await controlPlane.runnerApp.inject({
        method: "POST",
        url: RUNNER_ROUTES.handledIncidents,
        payload: {
          report: {
            containerName: "tika",
            image: "apache/tika:3",
            trigger: "die",
            stateSummary: "status=exited",
            healthOutputs: [],
            knownContainers: ["tika"],
            protectedContainers: [],
            logs: "",
          },
          detectedAt: controlPlane.clock.now,
          decision: { action: "restart", target: "tika", diagnosis: "It lost its connection." },
          result: { outcome: "Restarted tika.", verdict: "restarted", executed: true },
        },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(submitted.statusCode, submitted.body).toBe(200);
      return submitted.json<{ incidentId: string }>().incidentId;
    };
    const first = await submitIncident();
    const [task] = await tasks();
    expect(task).toMatchObject({ title: "tika stopped on Alder", source: "incident" });
    expect((await detail(task!.id)).incidentId).toBe(first);

    // The detector sees the same container: it joins that task instead of opening another, in the incident's words.
    later(2 * MINUTE);
    await detector.run();
    expect((await tasks()).map(({ title }) => title)).toEqual(["tika stopped on Alder"]);

    // It fails again: the task now shows the newest incident, and its timeline has both.
    const second = await submitIncident();
    const linked = await detail(task!.id);
    expect(linked.incidentId).toBe(second);
    expect(linked.activity.filter(({ kind }) => kind === "incident_linked").map(({ data }) => data)).toEqual([
      { incidentId: second },
    ]);
  });
});
