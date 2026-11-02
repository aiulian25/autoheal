import { join } from "node:path";
import {
  GPU_LIMIT,
  HOST_TEXT_LIMIT,
  MILLIDEGREES_PER_DEGREE,
  PERCENT,
  SYS_ROOT,
  SYSFS_GPU,
} from "../shared/constants.js";
import type { HostMetrics } from "../shared/protocol.js";
import { GPU_NAMES } from "./gpu-names.js";
import { LOCAL_HOST_FILES, numberIn, type HostFiles } from "./host-files.js";
import { clampShare, shareOf } from "./rates.js";

type GpuMetrics = HostMetrics["gpus"][number];
type Load = Pick<GpuMetrics, "utilizationPercent" | "clockShare" | "memoryUsedBytes" | "memoryTotalBytes">;

interface Card {
  directory: string;
  driver: string;
  slot: string;
  vendor: string;
  device: string;
}

const NO_LOAD: Load = { utilizationPercent: 0, memoryUsedBytes: 0, memoryTotalBytes: 0 };
const { drivers } = SYSFS_GPU;
const KNOWN_DRIVERS: readonly string[] = Object.values(drivers);

function cardOf(directory: string, uevent: string | null): Card | null {
  const fields = new Map((uevent ?? "").split("\n").map((line) => line.split("=") as [string, string]));
  const driver = fields.get("DRIVER");
  const slot = fields.get("PCI_SLOT_NAME");
  const [vendor, device] = (fields.get("PCI_ID") ?? "").toLowerCase().split(":");
  if (driver === undefined || slot === undefined || !vendor || !device || !KNOWN_DRIVERS.includes(driver)) return null;
  return { directory, driver, slot, vendor, device };
}

/** A card's name from the host's list of PCI devices; a host without it, or a card too new for it, keeps its number. */
export function nameInPciIds(list: string | null, vendor: string, device: string): string | null {
  const lines = (list ?? "").split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${vendor}  `));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^[0-9a-f]{4} {2}/.test(line));
  const found = lines.slice(start + 1, end < 0 ? undefined : end).find((line) => line.startsWith(`\t${device}  `));
  return found === undefined ? null : found.slice(device.length + 3).trim();
}

/** "Battlemage G21 [Arc Pro B50]" is sold as an Arc Pro B50; "Arrow Lake-U [Intel Graphics]" has no name of its own. */
export function marketName(listed: string) {
  const sold = listed.match(/\[(.+)\]/)?.[1];
  const chip = listed.replace(/\s*\[.*\]/, "");
  return sold === undefined || sold === SYSFS_GPU.genericName ? chip : sold;
}

/**
 * Intel and AMD GPUs, found and read from the kernel's files. A card asleep is not read at all, since reading would
 * wake it, and shows as idle. Each driver gives only what holds up on it: an Intel card on the xe driver has idle and
 * energy counters that jump (seen on an Arc Pro on Linux 7.0), so its dial is its clock, with no power or memory.
 * NVIDIA's cards are nvidia-smi's, and a display adapter with no driver here is no GPU to watch.
 */
export class SysfsGpus {
  private readonly names = new Map<string, string>();
  // Per card, what its idle counters said last.
  private readonly idle = new Map<string, { at: number; counters: Map<string, number> }>();

  constructor(
    private readonly hostRoot: string,
    private readonly files: HostFiles = LOCAL_HOST_FILES,
    private readonly sysRoot: string = SYS_ROOT,
    private readonly clock: () => number = Date.now,
  ) {}

  async read(): Promise<GpuMetrics[]> {
    const directory = join(this.sysRoot, SYSFS_GPU.cards);
    const entries = (await this.files.list(directory)).filter((entry) => SYSFS_GPU.cardPattern.test(entry));
    const cards = await Promise.all(
      entries.map(async (entry) => {
        const card = join(directory, entry);
        return cardOf(card, await this.files.readText(join(card, SYSFS_GPU.uevent)));
      }),
    );
    const known = cards
      .filter((card) => card !== null)
      .sort((left, right) => left.slot.localeCompare(right.slot))
      .slice(0, GPU_LIMIT);
    return Promise.all(known.map((card) => this.reading(card)));
  }

  private text(...path: string[]) {
    return this.files.readText(join(...path));
  }

  private async reading(card: Card): Promise<GpuMetrics> {
    const name = await this.nameOf(card);
    const status = await this.text(card.directory, SYSFS_GPU.runtimeStatus);
    if (status?.trim() === SYSFS_GPU.asleep) {
      // Its counters stood still while it slept, which would read as busy.
      this.idle.delete(card.slot);
      const clockShare = card.driver === drivers.xe ? { clockShare: true } : {};
      return { name, ...NO_LOAD, ...clockShare, powerWatts: null, temperatureCelsius: null };
    }
    const [load, sensors] = await Promise.all([this.loadOf(card), this.sensorsOf(card)]);
    return { name, ...load, ...sensors };
  }

  private async nameOf(card: Card) {
    const known = this.names.get(card.slot);
    if (known !== undefined) return known;
    const vendor = SYSFS_GPU.vendors[card.vendor as keyof typeof SYSFS_GPU.vendors] ?? card.vendor;
    let name: string | null = GPU_NAMES[card.vendor]?.[card.device] ?? null;
    for (const file of SYSFS_GPU.nameFiles) {
      name ??= nameInPciIds(await this.text(this.hostRoot, file), card.vendor, card.device);
    }
    const named = (name === null ? SYSFS_GPU.unknownName(vendor, card.device) : `${vendor} ${marketName(name)}`).slice(
      0,
      HOST_TEXT_LIMIT,
    );
    this.names.set(card.slot, named);
    return named;
  }

  private loadOf(card: Card): Promise<Load> {
    if (card.driver === drivers.amd) return this.amdLoad(card);
    return card.driver === drivers.xe ? this.xeLoad(card) : this.i915Load(card);
  }

  private async amdLoad({ directory }: Card): Promise<Load> {
    const { busy, memoryUsed, memoryTotal } = SYSFS_GPU.amd;
    const [share, used, total] = await Promise.all(
      [busy, memoryUsed, memoryTotal].map(async (file) => numberIn(await this.text(directory, file))),
    );
    return { utilizationPercent: clampShare(share ?? 0), memoryUsedBytes: used ?? 0, memoryTotalBytes: total ?? 0 };
  }

  // Busy is the time its busiest engine group spent out of its idle state since the last look; the first look has none.
  private async i915Load({ directory, slot }: Card): Promise<Load> {
    const { units, unitPattern, idle, olderIdle } = SYSFS_GPU.i915;
    const found = (await this.files.list(join(directory, units))).filter((unit) => unitPattern.test(unit));
    const paths = found.length > 0 ? found.map((unit) => join(units, unit, idle)) : [olderIdle];
    const at = this.clock();
    const read = await Promise.all(
      paths.map(async (path) => [path, numberIn(await this.text(directory, path))] as const),
    );
    const counters = new Map(read.filter((entry): entry is [string, number] => entry[1] !== null));
    const previous = this.idle.get(slot);
    this.idle.set(slot, { at, counters });
    if (previous === undefined || at <= previous.at) return NO_LOAD;
    const shares = [...counters].map(([path, value]) => {
      const before = previous.counters.get(path) ?? value;
      return clampShare(PERCENT - shareOf(Math.max(0, value - before), at - previous.at));
    });
    return { ...NO_LOAD, utilizationPercent: Math.max(0, ...shares) };
  }

  private async xeLoad({ directory }: Card): Promise<Load> {
    const { tilePattern, unitPattern, actualClock, topClock } = SYSFS_GPU.xe;
    const device = join(directory, SYSFS_GPU.device);
    const tiles = (await this.files.list(device)).filter((entry) => tilePattern.test(entry));
    const units = await Promise.all(
      tiles.map(async (tile) =>
        (await this.files.list(join(device, tile)))
          .filter((entry) => unitPattern.test(entry))
          .map((unit) => join(device, tile, unit)),
      ),
    );
    const shares = await Promise.all(
      units.flat().map(async (unit) => {
        const [actual, top] = await Promise.all([this.text(unit, actualClock), this.text(unit, topClock)]);
        return shareOf(numberIn(actual) ?? 0, numberIn(top) ?? 0);
      }),
    );
    return { ...NO_LOAD, utilizationPercent: Math.max(0, ...shares), clockShare: true };
  }

  private async sensorsOf({ directory }: Card): Promise<Pick<GpuMetrics, "powerWatts" | "temperatureCelsius">> {
    const monitors = join(directory, SYSFS_GPU.hardwareMonitors);
    const [monitor] = await this.files.list(monitors);
    if (monitor === undefined) return { powerWatts: null, temperatureCelsius: null };
    const folder = join(monitors, monitor);
    const [entries, power] = await Promise.all([this.files.list(folder), this.powerOf(folder)]);
    return { powerWatts: power, temperatureCelsius: await this.temperatureOf(folder, entries) };
  }

  private async powerOf(folder: string) {
    for (const file of SYSFS_GPU.powerFiles) {
      const microwatts = numberIn(await this.text(folder, file));
      if (microwatts !== null) return Math.max(0, microwatts / SYSFS_GPU.microwattsPerWatt);
    }
    return null;
  }

  private async temperatureOf(folder: string, entries: readonly string[]) {
    const inputs = entries
      .filter((entry) => SYSFS_GPU.temperaturePattern.test(entry))
      .sort((left, right) => Number(left.match(/\d+/)?.[0]) - Number(right.match(/\d+/)?.[0]));
    const labels = await Promise.all(
      inputs.map(async (input) => (await this.text(folder, input.replace("input", "label")))?.trim() ?? null),
    );
    const wanted = SYSFS_GPU.temperatureLabels.map((label) => labels.indexOf(label)).find((index) => index >= 0);
    const input = inputs[wanted ?? 0];
    if (input === undefined) return null;
    const millidegrees = numberIn(await this.text(folder, input));
    return millidegrees === null ? null : millidegrees / MILLIDEGREES_PER_DEGREE;
  }
}
