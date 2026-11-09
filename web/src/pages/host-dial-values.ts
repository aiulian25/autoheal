import { type HostHealthView, type HostMetricsView } from "../../../src/shared/api.js";
import { PERCENT } from "../../../src/shared/constants.js";
import { type Tone } from "../components/charts.js";
import { BYTES_PER_MEGABIT, METER_DANGER_PERCENT, METER_WARNING_PERCENT, RATE_DIAL_SCALE, TEXT } from "../constants.js";
import { percentOf, precisePercent, rate } from "../format.js";

export type HostMemory = HostMetricsView["memory"];

export type HostDisk = NonNullable<HostMetricsView["disk"]>;

export type HostNetwork = NonNullable<HostMetricsView["network"]>;

// Calm until a share runs high: amber from 75%, red from 90%, like the usage meters.
function shareTone(value: number, calm: Tone): Tone {
  if (value >= METER_DANGER_PERCENT) {
    return "danger";
  }
  return value >= METER_WARNING_PERCENT ? "warning" : calm;
}

// On a log scale from the lowest rate worth showing up to the highest: a network's link speed when known.
function rateFraction(bytesPerSecond: number, highestBytesPerSecond: number): number {
  const { lowestBytesPerSecond } = RATE_DIAL_SCALE;
  const above = Math.max(bytesPerSecond, lowestBytesPerSecond) / lowestBytesPerSecond;
  return Math.log(above) / Math.log(highestBytesPerSecond / lowestBytesPerSecond);
}

/** What a host's network cards can carry together, in bytes a second; the dial's default when no speed is known. */
export function networkCeiling(network: HostNetwork): number {
  const megabits = network.interfaces.reduce((total, card) => total + (card.speedMegabitsPerSecond ?? 0), 0);
  return megabits === 0 ? RATE_DIAL_SCALE.highestBytesPerSecond : megabits * BYTES_PER_MEGABIT;
}

export const shareDial = (value: number, unit: string, calm: Tone) => ({
  fraction: value / PERCENT,
  value: precisePercent(value),
  unit,
  tone: shareTone(value, calm),
  rate: false,
});

export const rateDial = (
  bytesPerSecond: number,
  unit: string,
  tone: Tone,
  highestBytesPerSecond: number = RATE_DIAL_SCALE.highestBytesPerSecond,
) => ({
  fraction: rateFraction(bytesPerSecond, highestBytesPerSecond),
  value: rate(bytesPerSecond),
  unit,
  tone,
  rate: true,
});

export const orMissing = <Value>(value: Value | null, format: (value: Value) => string) =>
  value === null ? TEXT.none : format(value);

export type FileSystem = HostHealthView["disks"][number];

// Used as df counts it: blocks reserved for root are neither used nor available.
export const diskUsedPercent = (disk: FileSystem) => percentOf(disk.usedBytes, disk.usedBytes + disk.availableBytes);

// The fullest filesystem is the one that will cause trouble first.
export const fullestDisk = (health: HostHealthView | null) =>
  [...(health?.disks ?? [])].sort((first, second) => diskUsedPercent(second) - diskUsedPercent(first))[0];
