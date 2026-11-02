import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostMetrics, hostHealth, containerSnapshot, containerUsage } from "../../../test/support/inventory.js";
import { TREND } from "../../shared/metric-trends.js";
import type { MaintenancePolicy } from "../../shared/maintenance.js";
import { AuditLog } from "../audit/audit-log.js";
import { DatabaseHandle } from "../database/connection.js";
import { hosts, users, jobs, workItems } from "../database/schema.js";
import { MetricRollups } from "./metric-rollups.js";
import { metricRollups, metricSeries, metricAnomalies } from "./metric-rollups-schema.js";
import { TasksService } from "../tasks/tasks-service.js";
import { TASK_LABEL_PATTERN } from "../../shared/constants.js";
import { TREND_METRICS } from "../../shared/metric-trends.js";
import { AnomalyDetector, anomalyFinding } from "../tasks/anomaly-detector.js";
import { MetricsStore } from "./metrics-store.js";
const roots: string[] = [];
const handles: DatabaseHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0))
    try {
      h.close();
    } catch {}
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function fixture(limits?: { series: number; rows: number }) {
  const directory = mkdtempSync(join(tmpdir(), "autoheal-trends-"));
  roots.push(directory);
  let databaseHandle = new DatabaseHandle(join(directory, "state.sqlite"));
  handles.push(databaseHandle);
  let now = Date.UTC(2026, 9, 20, 12);
  const start = now;
  const hostId = randomUUID(),
    userId = randomUUID();
  const auditLines: string[] = [];
  let windows: MaintenancePolicy["windows"] = [];
  databaseHandle.database
    .insert(users)
    .values({ id: userId, username: "reviewer", passwordHash: "fixture", role: "admin", createdAt: now })
    .run();
  databaseHandle.database
    .insert(hosts)
    .values({ id: hostId, label: "lab", tokenHash: randomUUID(), tokenHint: "test", enrolledAt: now })
    .run();
  const dependencies = () => ({
    databaseHandle,
    auditLog: new AuditLog(databaseHandle, (line) => auditLines.push(line)),
    clock: () => now,
    maintenance: vi.fn(() => windows),
    ...(limits ? { limits } : {}),
  });
  let deps = dependencies();
  let rollups = new MetricRollups(deps);
  function heartbeat(overrides = {}) {
    databaseHandle.database
      .update(hosts)
      .set({
        lastHeartbeatAt: now,
        healthJson: JSON.stringify(hostHealth({ bootId: "12345678-1234-1234-1234-123456789abc" })),
        containersJson: JSON.stringify([containerSnapshot()]),
        ...overrides,
      })
      .where(eq(hosts.id, hostId))
      .run();
  }
  function sample(cpu = 10, memory = 100 * 1024 ** 2) {
    heartbeat();
    rollups.record(hostId, {
      host: hostMetrics({
        cpu: { ...hostMetrics().cpu, busyPercent: cpu },
        memory: { ...hostMetrics().memory, usedBytes: memory },
      }),
      containers: [containerUsage({ cpuPercent: cpu, memoryBytes: memory })],
    });
  }
  return {
    hostId,
    userId,
    start,
    auditLines,
    get db() {
      return databaseHandle.database;
    },
    get handle() {
      return databaseHandle;
    },
    get rollups() {
      return rollups;
    },
    get deps() {
      return deps;
    },
    get now() {
      return now;
    },
    set now(value) {
      now = value;
    },
    set windows(value: MaintenancePolicy["windows"]) {
      windows = value;
    },
    sample,
    heartbeat,
    reopen() {
      rollups.flush();
      databaseHandle.close();
      handles.splice(handles.indexOf(databaseHandle), 1);
      databaseHandle = new DatabaseHandle(join(directory, "state.sqlite"));
      handles.push(databaseHandle);
      deps = dependencies();
      rollups = new MetricRollups(deps);
    },
    buckets(values: number[]) {
      for (const value of values) {
        for (let index = 0; index < 60; index++) {
          sample(value);
          now += TREND.cadence;
        }
      }
      sample(values.at(-1));
      rollups.flush();
    },
  };
}
describe("durable bounded metric history and observations", () => {
  it("persists coarse history and partial sample cadence across reconstruction", () => {
    const f = fixture();
    f.sample();
    f.now += TREND.cadence;
    f.sample();
    f.rollups.flush();
    expect(f.rollups.trends(f.hostId).points[0]).toMatchObject({ cpu: 10, cpuSamples: 2 });
    f.reopen();
    f.sample(90);
    f.rollups.flush();
    expect(f.rollups.trends(f.hostId).points[0]?.cpuSamples).toBe(2);
    f.now += TREND.cadence;
    f.sample(40);
    f.rollups.flush();
    expect(f.rollups.trends(f.hostId).points[0]).toMatchObject({ cpu: 20, cpuSamples: 3 });
  });
  it("learns a stable baseline, detects a sustained excursion, and creates only human observations", () => {
    const f = fixture();
    f.buckets([...Array(24).fill(10), 60, 65, 70]);
    f.rollups.evaluate();
    const views = f.rollups.anomalies(f.hostId);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      state: "active",
      metric: "cpu",
      baseline: 10,
      baselineSamples: 1440,
      recentSamples: 180,
    });
    const detector = new AnomalyDetector({ rollups: f.rollups, owner: () => ({ kind: "user", id: f.userId }) });
    expect(detector.detect().problems).toHaveLength(2);
    expect(detector.detect().problems[0]).toMatchObject({
      assignee: { kind: "user", id: f.userId },
      labels: ["anomaly", "anomaly-cpu"],
    });
    expect(f.db.select().from(jobs).all()).toEqual([]);
    expect(f.db.select().from(workItems).all()).toEqual([]);
    f.reopen();
    expect(f.rollups.anomalies(f.hostId)[0]).toMatchObject({ state: "active" });
  });
  it("excludes maintenance and missing intervals, then resets training on restarts and limits", () => {
    const f = fixture();
    f.buckets([...Array(24).fill(10), 60, 65, 70]);
    f.rollups.evaluate();
    const initial = f.rollups.trends(f.hostId).identity;
    f.windows = [{ containerName: null, startsAt: f.now, expiresAt: f.now + TREND.interval }];
    f.now += TREND.cadence;
    f.sample(90);
    f.rollups.flush();
    f.rollups.evaluate();
    expect(f.rollups.trends(f.hostId).status).toBe("maintenance");
    expect(f.rollups.anomalies(f.hostId)[0]?.state).toBe("unknown");
    f.windows = [];
    f.now += 3 * TREND.interval;
    f.sample();
    f.rollups.flush();
    expect(f.rollups.trends(f.hostId).baselines).toEqual([]);
    f.now += TREND.cadence;
    f.heartbeat({ healthJson: JSON.stringify(hostHealth({ bootId: "abcdefab-1234-1234-1234-123456789abc" })) });
    f.rollups.record(f.hostId, { host: hostMetrics(), containers: [containerUsage({ memoryLimitBytes: 1024 ** 3 })] });
    f.rollups.flush();
    expect(f.rollups.trends(f.hostId).identity).not.toBe(initial);
    expect(f.rollups.trends(f.hostId, "paperless").baselines).toEqual([]);
  });
  it("produces anomaly labels that obey the normal task API label contract for every metric", () => {
    const f = fixture();
    f.buckets([...Array(24).fill(10), 60, 65, 70]);
    f.rollups.evaluate();
    const observation = f.rollups.anomalies(f.hostId)[0]!;
    for (const metric of TREND_METRICS) {
      const finding = anomalyFinding({ ...observation, metric }, { kind: "user", id: f.userId });
      expect(finding.labels.every((label) => TASK_LABEL_PATTERN.test(label))).toBe(true);
    }
  });
  it("deduplicates normal review tasks and resolves them only after a measured recovery", () => {
    const f = fixture();
    f.buckets([...Array(24).fill(10), 60, 65, 70]);
    const detector = new AnomalyDetector({ rollups: f.rollups, owner: () => ({ kind: "user", id: f.userId }) });
    const tasks = new TasksService(f.handle, new AuditLog(f.handle, () => {}), { containers: () => [] }, () => f.now);
    const problem = detector
      .detect()
      .problems.find((problem) => problem.hostId === f.hostId && problem.resource?.kind === "host")!;
    const first = tasks.openOrJoin(problem);
    expect(first.outcome).toBe("created");
    expect(tasks.openOrJoin(problem).task.id).toBe(first.task.id);
    expect(first.task.description).toContain("learned typical");
    f.now += TREND.freshness + 1;
    detector.detect();
    expect(f.rollups.judges(problem.key)).toBe(false);
    f.now = Math.ceil(f.now / TREND.interval) * TREND.interval;
    f.buckets([10, 10, 10]);
    detector.detect();
    expect(f.rollups.judges(problem.key)).toBe(true);
    expect(tasks.clear(problem.key)?.closed).toBe(true);
  });
  it("expires offline/revoked series without more reports and enforces global series/row caps", () => {
    const f = fixture({ series: 1, rows: 2 });
    f.buckets([10, 10, 10]);
    expect(f.rollups.trends(f.hostId).health).toMatchObject({
      capacityLimited: true,
      retainedSeries: 1,
      retainedRows: 2,
    });
    f.now += TREND.retention + 1;
    f.rollups.sweep();
    expect(f.db.select().from(metricSeries).all()).toEqual([]);
    expect(f.db.select().from(metricRollups).all()).toEqual([]);
    f.sample();
    f.rollups.flush();
    f.db.update(hosts).set({ status: "revoked" }).where(eq(hosts.id, f.hostId)).run();
    f.now += TREND.flush;
    f.rollups.sweep();
    expect(f.db.select().from(metricSeries).all()).toEqual([]);
  });
  it("records auditable feedback for a reviewed observation and rejects a changed review", () => {
    const f = fixture();
    f.buckets([...Array(24).fill(10), 60, 65, 70]);
    f.rollups.evaluate();
    const view = f.rollups.anomalies(f.hostId)[0]!;
    expect(() =>
      f.rollups.feedback({ userId: f.userId, username: "reviewer", ip: "127.0.0.1", requestId: "review" }, view.id, {
        observedAt: view.observedAt - 1,
        assessment: "useful",
      }),
    ).toThrow();
    f.rollups.feedback({ userId: f.userId, username: "reviewer", ip: "127.0.0.1", requestId: "review" }, view.id, {
      observedAt: view.observedAt,
      assessment: "false_positive",
    });
    expect(f.db.select().from(metricAnomalies).where(eq(metricAnomalies.id, view.id)).get()?.feedback).toBe(
      "false_positive",
    );
    expect(f.auditLines.join(" ")).toContain("metric");
  });
  it("bounds failed batches through a long storage outage and excludes the affected interval", () => {
    const f = fixture();
    f.sample();
    f.rollups.flush();
    const transaction = vi.spyOn(f.db, "transaction").mockImplementation(() => {
      throw Error("fixture write outage");
    });
    for (let minute = 0; minute < 240; minute++) {
      f.now += TREND.flush;
      f.sample();
    }
    expect(f.rollups.trends(f.hostId).health.unavailable).toBe(true);
    transaction.mockRestore();
    f.now += TREND.flush;
    f.sample();
    f.rollups.flush();
    expect(f.db.select().from(metricRollups).all().length).toBeLessThanOrEqual(4);
    expect(f.rollups.trends(f.hostId).baselines).toEqual([]);
  });
  it("never blocks live metric collection on durable storage failure", () => {
    const f = fixture();
    f.handle.sqlite.exec("DROP TABLE metric_rollups");
    const live = new MetricsStore(
      () => f.now,
      undefined,
      () => true,
      f.rollups,
    );
    f.heartbeat();
    expect(() => live.record(f.hostId, { host: hostMetrics(), containers: [] })).not.toThrow();
    expect(live.latestHost(f.hostId)).not.toBeNull();
    expect(f.rollups.flush()).toBe(false);
  });
});
