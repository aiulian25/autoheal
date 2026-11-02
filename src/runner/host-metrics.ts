import { join } from "node:path";
import {
  CPU_DIRECTORY_PATTERN,
  CPU_FREQUENCY_FILE,
  CPU_TIME_COLUMNS,
  CPU_TOTAL_LINE_PREFIX,
  DISK_COUNTER_COLUMNS,
  DISK_SECTOR_BYTES,
  HARDWARE_DEVICE_LINK,
  KILOHERTZ_PER_MEGAHERTZ,
  MEMINFO_KEYS,
  METRICS_DEVICE_LIMIT,
  MILLISECONDS_PER_SECOND,
  NETWORK_COUNTER_FILES,
  PROC_FILES,
  PROC_ROOT,
  SYS_PATHS,
  SYS_ROOT,
} from "../shared/constants.js";
import type { HostMetrics } from "../shared/protocol.js";
import { LOCAL_HOST_FILES, numberIn, requiredText, type HostFiles } from "./host-files.js";
import { meminfoBytes } from "./host-health.js";
import { cpuTemperature } from "./host-sensors.js";
import { shareOf } from "./rates.js";

interface HostMetricsSettings {
  // The host's own filesystem, mounted read-only into the runner's container.
  hostRoot: string;
  readGpus: () => Promise<HostMetrics["gpus"]>;
  // /proc and /sys are the host's for everything here but the network; tests point them elsewhere.
  procRoot?: string;
  sysRoot?: string;
  // How the host's files are read; its mount here unless given.
  files?: HostFiles;
}

type CpuColumn = (typeof CPU_TIME_COLUMNS)[number];
type CpuTimes = Record<CpuColumn, number>;
type DiskCounters = Map<string, { read: number; written: number }>;
type NetworkCounters = Map<string, { received: number; transmitted: number; dropped: number }>;
type NetworkReading = { interfaces: NonNullable<HostMetrics["network"]>["interfaces"]; counters: NetworkCounters };

interface Reading {
  at: number;
  cpu: CpuTimes;
  disks: DiskCounters;
  network: NetworkCounters | null;
}

const average = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

function cpuTimesOf(stat: string): CpuTimes {
  const line = stat.split("\n").find((entry) => entry.startsWith(CPU_TOTAL_LINE_PREFIX)) ?? "";
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  return Object.fromEntries(CPU_TIME_COLUMNS.map((column, index) => [column, values[index] ?? 0])) as CpuTimes;
}

function cpuShares(previous: CpuTimes, current: CpuTimes) {
  const spent = (...columns: CpuColumn[]) =>
    columns.reduce((sum, column) => sum + Math.max(0, current[column] - previous[column]), 0);
  const total = spent(...CPU_TIME_COLUMNS);
  return {
    busyPercent: shareOf(total - spent("idle", "iowait"), total),
    userPercent: shareOf(spent("user", "nice"), total),
    systemPercent: shareOf(spent("system", "irq", "softirq"), total),
    ioWaitPercent: shareOf(spent("iowait"), total),
    stealPercent: shareOf(spent("steal"), total),
  };
}

function memoryOf(meminfo: string): HostMetrics["memory"] {
  const value = (key: string) => meminfoBytes(meminfo, key);
  const totalBytes = value(MEMINFO_KEYS.total);
  const swapTotalBytes = value(MEMINFO_KEYS.swapTotal);
  return {
    totalBytes,
    usedBytes: Math.max(0, totalBytes - value(MEMINFO_KEYS.available)),
    // What `free` calls buff/cache.
    cacheBytes: value(MEMINFO_KEYS.buffers) + value(MEMINFO_KEYS.cached) + value(MEMINFO_KEYS.reclaimableSlab),
    swapTotalBytes,
    swapUsedBytes: Math.max(0, swapTotalBytes - value(MEMINFO_KEYS.swapFree)),
  };
}

// Disks and network cards that are hardware: loop devices, device-mapper volumes, bridges and veths
// have no device link, and counting them would count the same bytes twice.
async function hardwareDevices(directory: string, files: HostFiles): Promise<string[]> {
  const names = (await files.list(directory)).sort();
  const hardware = await Promise.all(names.map((name) => files.exists(join(directory, name, HARDWARE_DEVICE_LINK))));
  return names.filter((_name, index) => hardware[index]).slice(0, METRICS_DEVICE_LIMIT);
}

async function diskCounters(procRoot: string, devices: readonly string[], files: HostFiles): Promise<DiskCounters> {
  const wanted = new Set(devices);
  const rows = (await requiredText(files, join(procRoot, PROC_FILES.diskCounters)))
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => wanted.has(columns[DISK_COUNTER_COLUMNS.name] ?? ""));
  return new Map(
    rows.map((columns) => [
      columns[DISK_COUNTER_COLUMNS.name] ?? "",
      {
        read: Number(columns[DISK_COUNTER_COLUMNS.sectorsRead]) * DISK_SECTOR_BYTES,
        written: Number(columns[DISK_COUNTER_COLUMNS.sectorsWritten]) * DISK_SECTOR_BYTES,
      },
    ]),
  );
}

async function networkReading(hostRoot: string, files: HostFiles): Promise<NetworkReading | null> {
  const directory = join(hostRoot, SYS_PATHS.networkInterfaces);
  const names = await hardwareDevices(directory, files);
  if (names.length === 0) {
    return null;
  }
  const cards = await Promise.all(
    names.map(async (name) => {
      const read = (file: string) => files.readText(join(directory, name, file)).then(numberIn);
      const [received, transmitted, receiveDropped, transmitDropped, speed] = await Promise.all([
        read(NETWORK_COUNTER_FILES.received),
        read(NETWORK_COUNTER_FILES.transmitted),
        read(NETWORK_COUNTER_FILES.receiveDropped),
        read(NETWORK_COUNTER_FILES.transmitDropped),
        // Unreadable for Wi-Fi and a card that is down; -1 on some drivers.
        read(NETWORK_COUNTER_FILES.speed),
      ]);
      const counters = {
        received: received ?? 0,
        transmitted: transmitted ?? 0,
        dropped: (receiveDropped ?? 0) + (transmitDropped ?? 0),
      };
      return { name, speed: speed !== null && speed > 0 ? speed : null, counters };
    }),
  );
  return {
    interfaces: cards.map(({ name, speed }) => ({ name, speedMegabitsPerSecond: speed })),
    counters: new Map(cards.map(({ name, counters }) => [name, counters])),
  };
}

async function frequencyMegahertz(sysRoot: string, files: HostFiles): Promise<number | null> {
  const directory = join(sysRoot, SYS_PATHS.cpus);
  const cpus = (await files.list(directory)).filter((name) => CPU_DIRECTORY_PATTERN.test(name));
  const readings = await Promise.all(
    cpus.map((cpu) => files.readText(join(directory, cpu, CPU_FREQUENCY_FILE)).then(numberIn)),
  );
  const kilohertz = readings.filter((value) => value !== null);
  return kilohertz.length === 0 ? null : average(kilohertz) / KILOHERTZ_PER_MEGAHERTZ;
}

/** How much a counter grew across the devices in both readings: a device that came or went adds nothing. */
function growth<Counters extends Record<string, number>>(
  previous: Map<string, Counters>,
  current: Map<string, Counters>,
  counter: keyof Counters,
): number {
  return [...current].reduce((sum, [name, counters]) => {
    const before = previous.get(name);
    return before === undefined ? sum : sum + Math.max(0, counters[counter] - before[counter]);
  }, 0);
}

function diskRates(
  devices: string[],
  previous: DiskCounters,
  current: DiskCounters,
  seconds: number,
): HostMetrics["disk"] {
  if (devices.length === 0) {
    return null;
  }
  return {
    devices,
    readBytesPerSecond: growth(previous, current, "read") / seconds,
    writeBytesPerSecond: growth(previous, current, "written") / seconds,
  };
}

function networkRates(
  network: NetworkReading | null,
  previous: NetworkCounters | null,
  seconds: number,
): HostMetrics["network"] {
  if (network === null || previous === null) {
    return null;
  }
  return {
    interfaces: network.interfaces,
    receiveBytesPerSecond: growth(previous, network.counters, "received") / seconds,
    transmitBytesPerSecond: growth(previous, network.counters, "transmitted") / seconds,
    droppedPackets: growth(previous, network.counters, "dropped"),
  };
}

/**
 * The host's CPU, memory, disk, network and GPU usage. Rates need two readings, so the first call
 * only takes a baseline and returns null.
 */
export class HostMetricsSampler {
  private previous: Reading | null = null;

  constructor(
    private readonly settings: HostMetricsSettings,
    private readonly clock: () => number = Date.now,
  ) {}

  async sample(): Promise<HostMetrics | null> {
    const procRoot = this.settings.procRoot ?? PROC_ROOT;
    const sysRoot = this.settings.sysRoot ?? SYS_ROOT;
    const files = this.settings.files ?? LOCAL_HOST_FILES;
    const at = this.clock();
    const disks = await hardwareDevices(join(sysRoot, SYS_PATHS.blockDevices), files);
    const [stat, meminfo, diskCounts, network, frequency, temperature, gpus] = await Promise.all([
      requiredText(files, join(procRoot, PROC_FILES.cpuTimes)),
      requiredText(files, join(procRoot, PROC_FILES.memory)),
      diskCounters(procRoot, disks, files),
      networkReading(this.settings.hostRoot, files),
      frequencyMegahertz(sysRoot, files),
      cpuTemperature(sysRoot, files),
      this.settings.readGpus(),
    ]);
    const previous = this.previous;
    const current: Reading = { at, cpu: cpuTimesOf(stat), disks: diskCounts, network: network?.counters ?? null };
    this.previous = current;
    if (previous === null || at <= previous.at) {
      return null;
    }
    const seconds = (at - previous.at) / MILLISECONDS_PER_SECOND;
    return {
      cpu: { ...cpuShares(previous.cpu, current.cpu), frequencyMegahertz: frequency, temperatureCelsius: temperature },
      memory: memoryOf(meminfo),
      disk: diskRates(disks, previous.disks, current.disks, seconds),
      network: networkRates(network, previous.network, seconds),
      gpus,
    };
  }
}
