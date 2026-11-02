import { describe, expect, it } from "vitest";
import { hostMetrics, containerUsage } from "../../../test/support/inventory.js";
import { METRICS_HISTORY_MILLISECONDS } from "../../shared/constants.js";
import { MetricsStore } from "./metrics-store.js";

it("expires dormant host and container history without another report", () => {
  let now = Date.UTC(2026, 9, 26);
  const store = new MetricsStore(() => now);
  for (const id of ["a", "b"]) store.record(id, { host: hostMetrics(), containers: [containerUsage()] });
  now += METRICS_HISTORY_MILLISECONDS + 1;
  expect(store.hostHistory("a")).toEqual([]);
  expect(store.containerHistory("b", "paperless")).toEqual([]);
});

describe("metrics retention and fleet limits", () => {
  const report = () => ({ host: hostMetrics(), containers: [containerUsage()] });
  it("sweeps multiple dormant hosts without reading or reporting them again", () => {
    let now = 1_800_000;
    const store = new MetricsStore(() => now);
    store.record("a", report());
    store.record("b", report());
    expect(store.retained).toEqual({ hosts: 2, points: 4 });
    now += METRICS_HISTORY_MILLISECONDS + 1;
    store.sweep();
    expect(store.retained).toEqual({ hosts: 0, points: 0 });
    store.sweep();
    expect(store.latestHost("a")).toBeNull();
    expect(store.latestContainers("b").size).toBe(0);
  });

  it("keeps the inclusive history boundary, then reclaims only expired series", () => {
    let now = 1_800_000;
    const start = now;
    const store = new MetricsStore(() => now);
    store.record("a", report());
    now += 1000;
    store.record("a", { host: null, containers: [containerUsage({ name: "new" })] });
    now = start + METRICS_HISTORY_MILLISECONDS;
    expect(store.hostHistory("a")).toHaveLength(1);
    now++;
    expect(store.hostHistory("a")).toEqual([]);
    expect(store.containerHistory("a", "paperless")).toEqual([]);
    expect(store.containerHistory("a", "new")).toHaveLength(1);
    expect(store.retained).toEqual({ hosts: 1, points: 1 });
    now += 1000;
    store.sweep();
    expect(store.retained).toEqual({ hosts: 0, points: 0 });
  });

  it("evicts the least recently reporting host under a fleet host limit; reads do not renew it", () => {
    let now = 1_800_000;
    const store = new MetricsStore(() => now, { hosts: 2, points: 100 });
    store.record("a", report());
    now++;
    store.record("b", report());
    store.hostHistory("a");
    now++;
    store.record("c", report());
    expect(store.hostHistory("a")).toEqual([]);
    expect(store.retained).toEqual({ hosts: 2, points: 4 });
    now++;
    store.record("b", report());
    now++;
    store.record("d", report());
    expect(store.hostHistory("c")).toEqual([]);
    expect(store.latestHost("b")).not.toBeNull();
  });

  it("bounds aggregate points and shortens a single wide host while preserving its latest data", () => {
    let now = 1_800_000;
    const store = new MetricsStore(() => now, { hosts: 10, points: 4 });
    store.record("a", report());
    now++;
    store.record("a", report());
    now++;
    store.record("b", report());
    expect(store.hostHistory("a")).toEqual([]);
    expect(store.retained).toEqual({ hosts: 1, points: 2 });
    now++;
    store.record("b", report());
    now++;
    store.record("b", report());
    expect(store.retained).toEqual({ hosts: 1, points: 4 });
    expect(store.hostHistory("b")).toHaveLength(2);
    expect(store.containerHistory("b", "paperless")).toHaveLength(2);
    expect(store.latestHost("b")?.at).toBe(now);
    expect(store.latestContainers("b").get("paperless")?.at).toBe(now);
    store.clear();
    expect(store.retained).toEqual({ hosts: 0, points: 0 });
    store.record("c", report());
    expect(store.retained).toEqual({ hosts: 1, points: 2 });
  });

  it("reclaims revoked hosts and refuses a report admitted before revocation", () => {
    const active = new Set(["a", "b"]);
    const store = new MetricsStore(
      () => 1_800_000,
      undefined,
      (id) => active.has(id),
    );
    store.record("a", report());
    store.record("b", report());
    active.delete("a");
    store.remove("a");
    store.record("a", report());
    expect(store.hostHistory("a")).toEqual([]);
    expect(store.retained).toEqual({ hosts: 1, points: 2 });
    active.delete("b");
    store.sweep();
    expect(store.retained).toEqual({ hosts: 0, points: 0 });
  });

  it("does not retain empty host metadata or treat future samples after clock rollback as current", () => {
    let now = 1_800_000;
    const store = new MetricsStore(() => now);
    for (let index = 0; index < 200; index++) store.record(String(index), { host: null, containers: [] });
    expect(store.retained).toEqual({ hosts: 0, points: 0 });
    store.record("a", report());
    now--;
    expect(store.latestHost("a")).toBeNull();
    expect(store.hostHistory("a")).toEqual([]);
    expect(store.retained).toEqual({ hosts: 0, points: 0 });
  });
});
