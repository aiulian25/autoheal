import { describe, expect, it } from "vitest";
import { TREND, type TrendPoint } from "../../shared/metric-trends.js";
import { baselineOf } from "./anomaly-baseline.js";
const mib = 1024 ** 2;
const fixture = (values: number[], metric: "cpu" | "memory" | "io" = "cpu") =>
  values.map((value, index): TrendPoint => ({
    at: index * TREND.interval,
    identity: "one",
    excluded: false,
    cpu: 10,
    memory: 100 * mib,
    io: 1000,
    cpuSamples: 60,
    memorySamples: 60,
    ioSamples: 60,
    [metric]: value,
  }));
describe("robust sustained anomaly baselines", () => {
  it("learns stable and noisy series without flagging ordinary noise", () => {
    for (const values of [Array(27).fill(10), Array.from({ length: 27 }, (_, i) => 10 + (i % 5) * 2)])
      expect(baselineOf(fixture(values), "cpu", 27 * TREND.interval)).toMatchObject({
        elevated: false,
        baselineBuckets: 24,
        recentSamples: 180,
      });
  });
  it("ignores a single spike and requires three sustained high buckets", () => {
    expect(baselineOf(fixture([...Array(26).fill(10), 90]), "cpu", 27 * TREND.interval)?.elevated).toBe(false);
    expect(baselineOf(fixture([...Array(24).fill(10), 60, 65, 70]), "cpu", 27 * TREND.interval)).toMatchObject({
      elevated: true,
      median: 10,
      threshold: 25,
    });
  });
  it("describes a sustained rising memory fixture without calling it a diagnosis", () => {
    expect(
      baselineOf(
        fixture([...Array(24).fill(100 * mib), 200 * mib, 240 * mib, 280 * mib], "memory"),
        "memory",
        27 * TREND.interval,
      ),
    ).toMatchObject({ elevated: true, pattern: "rising" });
  });
  it("rejects gaps, maintenance, insufficient coverage and short training", () => {
    const points = fixture([...Array(24).fill(10), 60, 65, 70]);
    expect(baselineOf(points.slice(1), "cpu", 27 * TREND.interval)).toBeNull();
    for (const patch of [{ excluded: true }, { cpuSamples: 35 }, { cpu: null }])
      expect(
        baselineOf([...points.slice(0, -1), { ...points.at(-1)!, ...patch }], "cpu", 27 * TREND.interval),
      ).toBeNull();
    expect(
      baselineOf(
        points.filter((_, index) => index !== 25),
        "cpu",
        27 * TREND.interval,
      ),
    ).toBeNull();
    expect(
      baselineOf(
        points.map((point, index) => (index < 2 ? { ...point, excluded: true } : point)),
        "cpu",
        27 * TREND.interval,
      ),
    ).toBeNull();
  });
});
