import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostMetrics } from "../shared/protocol.js";
import { CHASSIS_TYPE_PATH, NVIDIA_GPUS_PATH } from "../shared/constants.js";
import { NvidiaGpus, parseNvidiaSmi } from "./gpu-metrics.js";
import { HostMetricsSampler } from "./host-metrics.js";

const KIBIBYTE = 1024;
const MEBIBYTE = 1024 ** 2;
const SECTOR = 512;

const GPU: HostMetrics["gpus"][number] = {
  name: "NVIDIA GeForce RTX 3060",
  utilizationPercent: 37,
  memoryUsedBytes: 1024 * MEBIBYTE,
  memoryTotalBytes: 6144 * MEBIBYTE,
  powerWatts: 41.5,
  temperatureCelsius: 61,
};

// One line of /proc/diskstats: sectors read are the 6th column, sectors written the 10th.
const diskLine = (name: string, sectorsRead: number, sectorsWritten: number) =>
  `   1 0 ${name} 10 0 ${sectorsRead} 0 20 0 ${sectorsWritten} 0 0 0 0`;

const meminfo = [
  "MemTotal:       16000000 kB",
  "MemAvailable:    9000000 kB",
  "Buffers:          100000 kB",
  "Cached:          4000000 kB",
  "SReclaimable:     500000 kB",
  "SwapTotal:       2000000 kB",
  "SwapFree:        1500000 kB",
].join("\n");

describe("HostMetricsSampler", () => {
  let root: string;
  let now: number;
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const directory = (path: string) => mkdirSync(join(root, path), { recursive: true });
  const card = (name: string, received: number, transmitted: number, dropped: number) => {
    write(`host/sys/class/net/${name}/statistics/rx_bytes`, String(received));
    write(`host/sys/class/net/${name}/statistics/tx_bytes`, String(transmitted));
    write(`host/sys/class/net/${name}/statistics/rx_dropped`, String(dropped));
    write(`host/sys/class/net/${name}/statistics/tx_dropped`, "0");
  };
  const sampler = (hostRoot = join(root, "host")) =>
    new HostMetricsSampler(
      { hostRoot, procRoot: join(root, "proc"), sysRoot: join(root, "sys"), readGpus: async () => [GPU] },
      () => now,
    );

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "autoheal-host-metrics-"));
    now = Date.UTC(2026, 9, 21, 12);
    write("proc/stat", "cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 50 0 25 400 25 0 0 0 0 0\n");
    write("proc/meminfo", meminfo);
    write(
      "proc/diskstats",
      [
        diskLine("loop0", 0, 0),
        diskLine("nvme0n1", 1000, 1000),
        diskLine("nvme0n1p1", 1000, 1000),
        diskLine("sda", 500, 500),
      ].join("\n"),
    );
    // Hardware has a device link; the loop device does not.
    directory("sys/block/loop0");
    directory("sys/block/nvme0n1/device");
    directory("sys/block/sda/device");
    write("sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq", "4000000");
    write("sys/devices/system/cpu/cpu1/cpufreq/scaling_cur_freq", "4400000");
    directory("sys/devices/system/cpu/cpuidle");
    write("sys/class/hwmon/hwmon0/name", "acpitz\n");
    write("sys/class/hwmon/hwmon0/temp1_input", "40000");
    write("sys/class/hwmon/hwmon1/name", "coretemp\n");
    write("sys/class/hwmon/hwmon1/temp1_input", "67000");
    // The host's network cards, read through the host root: docker0 is a bridge, with no device link.
    directory("host/sys/class/net/eth0/device");
    write("host/sys/class/net/eth0/speed", "1000");
    directory("host/sys/class/net/wlan0/device");
    card("eth0", 5_000_000, 1_000_000, 4);
    card("wlan0", 0, 0, 0);
    card("docker0", 7_000_000, 7_000_000, 0);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("takes a baseline first, then reports usage since it, counting hardware only", async () => {
    const host = sampler();
    expect(await host.sample()).toBeNull();

    now += 10_000;
    // In 10 s: 300 ticks, 200 of them idle and 20 waiting for disks.
    write("proc/stat", "cpu  160 0 70 1000 70 0 0 0 0 0\n");
    write(
      "proc/diskstats",
      [
        diskLine("loop0", 9000, 9000),
        diskLine("nvme0n1", 1000 + 2048, 1000 + 4096),
        diskLine("nvme0n1p1", 9000, 9000),
        // A counter that went back (a reset) adds nothing.
        diskLine("sda", 100, 100),
      ].join("\n"),
    );
    card("eth0", 6_000_000, 1_500_000, 6);
    card("docker0", 9_000_000, 9_000_000, 0);

    expect(await host.sample()).toEqual({
      cpu: {
        busyPercent: (80 / 300) * 100,
        userPercent: 20,
        systemPercent: (20 / 300) * 100,
        ioWaitPercent: (20 / 300) * 100,
        stealPercent: 0,
        frequencyMegahertz: 4200,
        temperatureCelsius: 67,
      },
      memory: {
        totalBytes: 16_000_000 * KIBIBYTE,
        usedBytes: 7_000_000 * KIBIBYTE,
        cacheBytes: 4_600_000 * KIBIBYTE,
        swapTotalBytes: 2_000_000 * KIBIBYTE,
        swapUsedBytes: 500_000 * KIBIBYTE,
      },
      disk: {
        devices: ["nvme0n1", "sda"],
        readBytesPerSecond: (2048 * SECTOR) / 10,
        writeBytesPerSecond: (4096 * SECTOR) / 10,
      },
      network: {
        interfaces: [
          { name: "eth0", speedMegabitsPerSecond: 1000 },
          { name: "wlan0", speedMegabitsPerSecond: null },
        ],
        receiveBytesPerSecond: 100_000,
        transmitBytesPerSecond: 50_000,
        droppedPackets: 2,
      },
      gpus: [GPU],
    });
  });

  it("leaves the network out when the host's filesystem is not mounted", async () => {
    const host = sampler(join(root, "not-mounted"));
    await host.sample();
    now += 5_000;
    expect((await host.sample())?.network).toBeNull();
  });
});

describe("parseNvidiaSmi", () => {
  it("reads one GPU per line, with what a GPU does not report as null and commas in names kept", () => {
    const output = "0, 4, 6144, 6.45, 49, NVIDIA GeForce RTX 3060\n37, 1024, 8192, [N/A], [N/A], Tesla T4, rev B\n";
    expect(parseNvidiaSmi(output)).toEqual([
      {
        name: "NVIDIA GeForce RTX 3060",
        utilizationPercent: 0,
        memoryUsedBytes: 4 * MEBIBYTE,
        memoryTotalBytes: 6144 * MEBIBYTE,
        powerWatts: 6.45,
        temperatureCelsius: 49,
      },
      {
        name: "Tesla T4, rev B",
        utilizationPercent: 37,
        memoryUsedBytes: 1024 * MEBIBYTE,
        memoryTotalBytes: 8192 * MEBIBYTE,
        powerWatts: null,
        temperatureCelsius: null,
      },
    ]);
  });
});

describe("an NVIDIA card its runner was not given", () => {
  let hostRoot: string;

  beforeEach(() => {
    hostRoot = mkdtempSync(join(tmpdir(), "autoheal-gpu-host-"));
  });

  afterEach(() => rmSync(hostRoot, { recursive: true, force: true }));

  // The host's own files as the runner sees them: its cards, and its chassis type when it names one.
  const host = (cards: string[], chassis?: string) => {
    for (const card of cards) {
      mkdirSync(join(hostRoot, NVIDIA_GPUS_PATH, card), { recursive: true });
    }
    if (chassis !== undefined) {
      mkdirSync(dirname(join(hostRoot, CHASSIS_TYPE_PATH)), { recursive: true });
      writeFileSync(join(hostRoot, CHASSIS_TYPE_PATH), `${chassis}\n`);
    }
  };
  // No nvidia-smi in the container: the runner was not given the GPU.
  const notGiven = () => new NvidiaGpus("autoheal-test-no-nvidia-smi");

  it("is said of a desktop's card, or one on a machine naming no chassis, once nvidia-smi is not there", async () => {
    host(["0000:01:00.0"], "3");
    expect(await notGiven().notGiven(hostRoot)).toBe(true);
    rmSync(join(hostRoot, CHASSIS_TYPE_PATH));
    expect(await notGiven().notGiven(hostRoot)).toBe(true);
  });

  it("is not said of a laptop's card, of a host without one, or when nvidia-smi is there", async () => {
    host(["0000:01:00.0"], "10");
    expect(await notGiven().notGiven(hostRoot)).toBe(false);
    expect(await notGiven().notGiven(join(hostRoot, "elsewhere"))).toBe(false);
    host([], "3");
    // A command that answers stands in for a given card's nvidia-smi.
    expect(await new NvidiaGpus("true").notGiven(hostRoot)).toBe(false);
  });
});
