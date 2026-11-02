import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeDockerEngine, containerIdOf, exitedContainer } from "../../test/fakes/fake-docker-engine.js";
import { ContainerInventory } from "./container-inventory.js";
import { DockerClient } from "./docker-client.js";

const MEBIBYTE = 1024 ** 2;
const GIBIBYTE = 1024 ** 3;

const runningContainer = (name: string, health?: string, limits: { NanoCpus?: number; Memory?: number } = {}) =>
  exitedContainer(name, {
    RestartCount: 2,
    State: {
      Status: "running",
      Running: true,
      ExitCode: 0,
      StartedAt: "2026-10-20T09:00:00.000000000Z",
      FinishedAt: "0001-01-01T00:00:00Z",
      ...(health === undefined ? {} : { Health: { Status: health } }),
    },
    Config: {
      Image: `example/${name}:1`,
      Labels: { "com.docker.compose.project": "paperless", "com.docker.compose.service": name },
    },
    HostConfig: { RestartPolicy: { Name: "unless-stopped" }, ...limits },
  });

interface Counters {
  cpu: number;
  system: number;
  read: number;
  written: number;
  received: number;
  sent: number;
  dropped: number;
  periods: number;
  throttled: number;
}

const START: Counters = {
  cpu: 1_000_000_000,
  system: 100_000_000_000,
  read: 0,
  written: 0,
  received: 0,
  sent: 0,
  dropped: 0,
  periods: 100,
  throttled: 10,
};

// A one-shot `docker stats` answer; without networks it is a container on the host's network.
const statsSample = (counters: Counters, memoryLimit: number, networks = true) => ({
  cpu_stats: {
    cpu_usage: { total_usage: counters.cpu },
    system_cpu_usage: counters.system,
    online_cpus: 4,
    throttling_data: { periods: counters.periods, throttled_periods: counters.throttled },
  },
  memory_stats: { usage: 3 * GIBIBYTE, limit: memoryLimit, stats: { inactive_file: GIBIBYTE, file: 1.5 * GIBIBYTE } },
  blkio_stats: {
    io_service_bytes_recursive: [
      { major: 259, minor: 0, op: "read", value: counters.read },
      { major: 259, minor: 0, op: "write", value: counters.written },
    ],
  },
  ...(networks
    ? { networks: { eth0: { rx_bytes: counters.received, tx_bytes: counters.sent, rx_dropped: counters.dropped } } }
    : {}),
  pids_stats: { current: 12 },
});

describe("ContainerInventory", () => {
  let engine: FakeDockerEngine;
  let inventory: ContainerInventory;
  let now: number;

  it("reports persistent recovery and keeps the rollback target visible during a rename gap", async () => {
    engine.remove("paperless");
    engine.add(exitedContainer("paperless-autoheal-old"));
    const projected = new ContainerInventory(new DockerClient(engine.socketPath), () => now, null, {
      pending: async () => [
        {
          version: 1,
          id: "00000000-0000-4000-8000-000000000001",
          owner: "paperless",
          phase: "prepared",
          at: null,
          members: [
            {
              name: "paperless",
              id: containerIdOf("paperless-autoheal-old"),
              replacementId: "replacement",
              running: true,
              restore: true,
            },
          ],
        },
      ],
    });
    const snapshot = await projected.snapshot();
    expect(snapshot.find(({ name }) => name === "paperless")).toMatchObject({
      recovery: { owner: "paperless" },
      state: "exited",
    });
    expect(snapshot.some(({ name }) => name === "paperless-autoheal-old")).toBe(false);
  });

  beforeEach(async () => {
    engine = await FakeDockerEngine.start();
    now = Date.UTC(2026, 9, 21, 12);
    inventory = new ContainerInventory(new DockerClient(engine.socketPath), () => now);
    engine.add(runningContainer("paperless", "healthy"));
    engine.add(
      exitedContainer("tika", {
        // Docker keeps the last health status after a container stops.
        State: {
          Status: "exited",
          Running: false,
          ExitCode: 1,
          FinishedAt: "2026-10-20T10:00:00Z",
          Health: { Status: "unhealthy" },
        },
      }),
    );
  });

  afterEach(() => engine.close());

  it("reports every container with its state, health, compose project and restart policy", async () => {
    const [paperless, tika] = await inventory.snapshot();
    expect(paperless).toEqual({
      name: "paperless",
      containerId: containerIdOf("paperless").slice(0, 12),
      image: "example/paperless:1",
      state: "running",
      health: "healthy",
      startedAt: Date.UTC(2026, 9, 20, 9),
      finishedAt: null,
      exitCode: null,
      oomKilled: false,
      restartCount: 2,
      restartPolicy: "unless-stopped",
      composeProject: "paperless",
      composeService: "paperless",
      link: null,
      version: null,
      updatePolicy: null,
      update: null,
      ports: [],
      hostNetwork: false,
    });
    expect(tika).toMatchObject({
      state: "exited",
      health: "none",
      exitCode: 1,
      finishedAt: Date.UTC(2026, 9, 20, 10),
      restartPolicy: "no",
      composeProject: null,
    });
  });

  it("reports the ports a container publishes once each, lowest first, and one on the host's own network", async () => {
    engine.ports.set("paperless", [
      { IP: "0.0.0.0", PrivatePort: 8000, PublicPort: 8010, Type: "tcp" },
      { IP: "::", PrivatePort: 8000, PublicPort: 8010, Type: "tcp" },
      // Exposed by its image, published nowhere.
      { PrivatePort: 6379, Type: "tcp" },
      { IP: "0.0.0.0", PrivatePort: 53, PublicPort: 5353, Type: "udp" },
    ]);
    const plex = runningContainer("plex");
    engine.add({ ...plex, HostConfig: { ...plex.HostConfig, NetworkMode: "host" } });

    const snapshots = await inventory.snapshot();
    expect(snapshots.find((snapshot) => snapshot.name === "paperless")).toMatchObject({
      ports: [
        { published: 5353, target: 53, protocol: "udp" },
        { published: 8010, target: 8000, protocol: "tcp" },
      ],
      hostNetwork: false,
    });
    expect(snapshots.find((snapshot) => snapshot.name === "plex")).toMatchObject({ ports: [], hostNetwork: true });
  });

  it("inspects a container again only when its state or health changes, or after one of its events", async () => {
    await inventory.snapshot();
    expect(engine.inspected.sort()).toEqual(["paperless", "tika"]);
    engine.inspected.length = 0;
    await inventory.snapshot();
    expect(engine.inspected).toEqual([]);

    engine.add(runningContainer("paperless", "unhealthy"));
    expect((await inventory.snapshot())[0]?.health).toBe("unhealthy");
    expect(engine.inspected).toEqual(["paperless"]);

    engine.inspected.length = 0;
    inventory.invalidate("tika");
    await inventory.snapshot();
    expect(engine.inspected).toEqual(["tika"]);
  });

  it("reads a container's web link and update policy from its labels, and its image's update check", async () => {
    const check = {
      status: "available" as const,
      checkedAt: now,
      remoteDigest: `sha256:${"a".repeat(64)}`,
      remote: { version: "v1.120.2", revision: null, source: "https://github.com/immich-app/immich", createdAt: now },
      reason: null,
    };
    inventory = new ContainerInventory(new DockerClient(engine.socketPath), () => now, { resultFor: () => check });
    const labelled = runningContainer("immich");
    labelled.Config.Labels = { "homepage.href": "https://photos.home.lan", "autoheal.update": "auto" };
    engine.add(labelled);
    const scripted = runningContainer("trap");
    scripted.Config.Labels = { "homepage.href": "javascript:alert(1)", "autoheal.update": "sometimes" };
    engine.add(scripted);
    const byName = Object.fromEntries((await inventory.snapshot()).map((container) => [container.name, container]));
    expect(byName.immich).toMatchObject({ link: "https://photos.home.lan", updatePolicy: "auto", update: check });
    expect(byName.trap).toMatchObject({ link: null, updatePolicy: null });
  });

  it("looks up each container's configured reference even when immutable image IDs match", async () => {
    const id = `sha256:${"d".repeat(64)}`;
    const seen: [string | undefined, string][] = [];
    inventory = new ContainerInventory(new DockerClient(engine.socketPath), () => now, {
      resultFor: (imageId, reference) => {
        seen.push([imageId, reference]);
        return {
          status: reference.endsWith(":canary") ? "available" : "current",
          checkedAt: now,
          remoteDigest: null,
          remote: null,
          reason: null,
        };
      },
    });
    for (const tag of ["stable", "canary"]) {
      const container = runningContainer(tag);
      container.Image = id;
      container.Config.Image = `ghcr.io/example/app:${tag}`;
      engine.add(container);
    }
    const byName = Object.fromEntries((await inventory.snapshot()).map((container) => [container.name, container]));
    expect(byName.stable.update?.status).toBe("current");
    expect(byName.canary.update?.status).toBe("available");
    expect(seen).toContainEqual([id, "ghcr.io/example/app:stable"]);
    expect(seen).toContainEqual([id, "ghcr.io/example/app:canary"]);
  });

  it("reads the version its image's labels name, asking Docker once per image", async () => {
    const imageId = `sha256:${"b".repeat(64)}`;
    engine.imageLabels.set(imageId, { "org.opencontainers.image.version": " v1.120.1 " });
    const immich = runningContainer("immich");
    immich.Image = imageId;
    engine.add(immich);
    const versionOf = async (name: string) =>
      (await inventory.snapshot()).find((container) => container.name === name)?.version;
    expect(await versionOf("immich")).toBe("v1.120.1");
    expect(await versionOf("immich")).toBe("v1.120.1");
    expect(engine.imagesInspected).toEqual([imageId]);
    // Its image's id unknown, or the image gone from Docker: no version.
    expect(await versionOf("paperless")).toBeNull();
    engine.imageLabels.clear();
    const forgotten = runningContainer("forgotten");
    forgotten.Image = `sha256:${"c".repeat(64)}`;
    engine.add(forgotten);
    expect(await versionOf("forgotten")).toBeNull();
  });

  it("drops a container once it is removed", async () => {
    await inventory.snapshot();
    engine.remove("tika");
    expect((await inventory.snapshot()).map((container) => container.name)).toEqual(["paperless"]);
  });

  it("works out a running container's usage from two samples, as a share of the whole host", async () => {
    engine.stats.set("paperless", statsSample(START, 16 * GIBIBYTE));
    expect(await inventory.sampleUsage()).toEqual([]);

    // 10 s later: 2 CPU-seconds of the 40 that passed on 4 CPUs is a fifth of one CPU, 5% of the host.
    now += 10_000;
    engine.stats.set(
      "paperless",
      statsSample(
        {
          ...START,
          cpu: START.cpu + 2_000_000_000,
          system: START.system + 40_000_000_000,
          read: 10 * MEBIBYTE,
          written: 20 * MEBIBYTE,
          received: MEBIBYTE,
          sent: 2 * MEBIBYTE,
          dropped: 3,
        },
        16 * GIBIBYTE,
      ),
    );
    expect(await inventory.sampleUsage()).toEqual([
      {
        name: "paperless",
        cpuPercent: 5,
        cpuLimitCores: null,
        throttledPercent: null,
        memoryBytes: 2 * GIBIBYTE,
        memoryPercent: 12.5,
        memoryLimitBytes: null,
        cacheBytes: 1.5 * GIBIBYTE,
        readBytesPerSecond: MEBIBYTE,
        writeBytesPerSecond: 2 * MEBIBYTE,
        receiveBytesPerSecond: MEBIBYTE / 10,
        transmitBytesPerSecond: (2 * MEBIBYTE) / 10,
        droppedPackets: 3,
        processes: 12,
      },
    ]);
  });

  it("measures a container with limits against them, throttling included, and leaves host networking out", async () => {
    engine.remove("paperless");
    engine.add(runningContainer("limited", undefined, { NanoCpus: 500_000_000, Memory: 4 * GIBIBYTE }));
    engine.stats.set("limited", statsSample(START, 4 * GIBIBYTE, false));
    await inventory.sampleUsage();

    // 0.4 of a CPU against a limit of half a CPU; held back in 25 of 100 periods.
    now += 10_000;
    const later = { ...START, cpu: START.cpu + 4_000_000_000, system: START.system + 40_000_000_000 };
    engine.stats.set("limited", statsSample({ ...later, periods: 200, throttled: 35 }, 4 * GIBIBYTE, false));
    expect((await inventory.sampleUsage())[0]).toMatchObject({
      cpuPercent: 80,
      cpuLimitCores: 0.5,
      throttledPercent: 25,
      memoryPercent: 50,
      memoryLimitBytes: 4 * GIBIBYTE,
      receiveBytesPerSecond: null,
      transmitBytesPerSecond: null,
      droppedPackets: null,
    });
  });

  it("starts a container that ran again from a fresh baseline", async () => {
    engine.stats.set("paperless", statsSample(START, 16 * GIBIBYTE));
    await inventory.sampleUsage();
    engine.remove("paperless");
    await inventory.sampleUsage();
    engine.add(runningContainer("paperless", "healthy"));
    now += 10_000;
    expect(await inventory.sampleUsage()).toEqual([]);
  });
});
