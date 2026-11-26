import { describe, expect, it } from "vitest";
import type { ContainerView, HostMetricsView, HostView } from "../../src/shared/api.js";
import { METRICS_HISTORY_MILLISECONDS, METRICS_HISTORY_POINTS } from "../../src/shared/constants.js";
import { withContainerUsage, withHistoryPoint, withHostMetrics } from "./live-patches.js";

const point = (at: number) => ({ at }) as HostMetricsView;

describe("a chart's live points", () => {
  it("adds a newer point at the end and lets go of the ones older than its window", () => {
    const now = 2 * METRICS_HISTORY_MILLISECONDS;
    const edge = now - METRICS_HISTORY_MILLISECONDS;
    expect(withHistoryPoint([point(edge - 1), point(edge), point(now - 1)], point(now))).toEqual([
      point(edge),
      point(now - 1),
      point(now),
    ]);
  });

  it("keeps no more points than its chart shows", () => {
    const full = Array.from({ length: METRICS_HISTORY_POINTS }, (_, index) => point(index + 1));
    const next = withHistoryPoint(full, point(METRICS_HISTORY_POINTS + 1))!;
    expect(next).toHaveLength(METRICS_HISTORY_POINTS);
    expect(next[0]).toEqual(point(2));
    expect(next.at(-1)).toEqual(point(METRICS_HISTORY_POINTS + 1));
  });

  it("changes nothing for a point it has or an older one, nor for a chart nobody read yet", () => {
    const points = [point(1), point(2)];
    expect(withHistoryPoint(points, point(2))).toBeUndefined();
    expect(withHistoryPoint(points, point(1))).toBeUndefined();
    expect(withHistoryPoint(undefined, point(3))).toBeUndefined();
    expect(withHistoryPoint([], point(3))).toEqual([point(3)]);
  });
});

describe("readings put into lists", () => {
  it("leaves a list without the hosts that sent them as it is", () => {
    const hosts = [{ id: "b", metrics: null } as HostView];
    const containers = [{ hostId: "b", name: "web", usage: null } as ContainerView];
    expect(withHostMetrics(hosts, new Map([["a", point(1)]]))).toBeUndefined();
    expect(withContainerUsage(containers, new Map([["a", {}]]))).toBeUndefined();
    expect(withHostMetrics(undefined, new Map([["a", point(1)]]))).toBeUndefined();
    expect(withContainerUsage(undefined, new Map([["a", {}]]))).toBeUndefined();
  });

  it("says a host's readings are gone when they are too old to stand for now", () => {
    const hosts = [{ id: "a", metrics: point(1) } as HostView];
    expect(withHostMetrics(hosts, new Map([["a", null]]))).toEqual([{ id: "a", metrics: null }]);
  });
});
