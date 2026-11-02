import { describe, expect, it } from "vitest";
import type { ContainerUsageView } from "./api.js";
import { BYTES_PER_GIBIBYTE, BYTES_PER_MEBIBYTE } from "./constants.js";
import { renderUsage, sampledUsage } from "./prompt-sections.js";

const point = (at: number, overrides: Partial<ContainerUsageView> = {}): ContainerUsageView => ({
  at,
  cpuPercent: 10,
  cpuLimitCores: null,
  throttledPercent: null,
  memoryBytes: 512 * BYTES_PER_MEBIBYTE,
  memoryPercent: 5,
  memoryLimitBytes: null,
  cacheBytes: 0,
  readBytesPerSecond: 0,
  writeBytesPerSecond: 0,
  receiveBytesPerSecond: null,
  transmitBytesPerSecond: null,
  droppedPackets: null,
  processes: null,
  ...overrides,
});

describe("the usage the model reads", () => {
  it("summarises memory rising to its limit, and how its CPU limit held it back", () => {
    const limited = { memoryLimitBytes: 2 * BYTES_PER_GIBIBYTE, cpuLimitCores: 2 };
    const text = renderUsage([
      point(1, {
        ...limited,
        memoryBytes: 1.62 * BYTES_PER_GIBIBYTE,
        memoryPercent: 81,
        cpuPercent: 20,
        throttledPercent: 10,
      }),
      point(2, {
        ...limited,
        memoryBytes: 1.99 * BYTES_PER_GIBIBYTE,
        memoryPercent: 99.4,
        cpuPercent: 60,
        throttledPercent: 30,
      }),
    ]);
    expect(text).toBe(
      [
        "Its usage in the 30 minutes before Autoheal looked (Autoheal's own measurements, every 5 seconds):",
        "- Memory: 1.62 GiB → 1.99 GiB of its 2.00 GiB limit (peak 99%).",
        "- CPU: average 40%, peak 60% of its 2-core limit.",
        "- Its CPU limit held it back 20% of the time on average.",
      ].join("\n"),
    );
  });

  it("says when no limit is set, leaves out throttling without one, and says nothing from one reading", () => {
    const text = renderUsage([point(1), point(2, { memoryBytes: 700 * BYTES_PER_MEBIBYTE, memoryPercent: 7 })]);
    expect(text).toContain("- Memory: 512 MiB → 700 MiB, no limit set (peak 7% of the host).");
    expect(text).toContain("- CPU: average 10%, peak 10% of the host.");
    expect(text).not.toContain("held it back");
    expect(renderUsage([point(1)])).toBeNull();
  });

  it("keeps at most 60 readings, evenly spread, and always the last", () => {
    const points = Array.from({ length: 360 }, (_, index) => point(index));
    const kept = sampledUsage(points);
    expect(kept.length).toBeLessThanOrEqual(60);
    expect(kept[0]).toBe(points[0]);
    expect(kept.at(-1)).toBe(points.at(-1));
    expect(sampledUsage(points.slice(0, 10))).toEqual(points.slice(0, 10));
  });
});
