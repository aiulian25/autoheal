import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { API_ERRORS } from "../../shared/api.js";
import {
  AUDIT_ACTIONS,
  BOOT_ID_PATTERN,
  HOST_SILENT_AFTER_MILLISECONDS,
  HOST_STATUS_ACTIVE,
  HOST_STATUS_REVOKED,
  REPORT_LIMITS,
} from "../../shared/constants.js";
import { sha256Hex } from "../../shared/hash.js";
import { log } from "../../shared/log.js";
import type { MaintenancePolicy } from "../../shared/maintenance.js";
import {
  anomalyFeedbackSchema,
  anomalyTaskKey,
  TREND,
  TREND_METRICS,
  type AnomalyFeedback,
  type MetricAnomalyView,
  type MetricTrendView,
  type TrendMetric,
  type TrendPoint,
} from "../../shared/metric-trends.js";
import type { MetricsReport } from "../../shared/protocol.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { hosts } from "../database/schema.js";
import { DomainError } from "../domain-error.js";
import { baselineOf } from "../tasks/anomaly-baseline.js";
import { metricAnomalies, metricRollups, metricSeries } from "./metric-rollups-schema.js";

const valuesSchema = z
  .object({
    cpu: z.number().finite().nonnegative(),
    memory: z.number().finite().nonnegative(),
    io: z.number().finite().nonnegative(),
  })
  .strict();
const aggregateSchema = z
  .object({
    at: z.number().int().nonnegative(),
    sums: valuesSchema,
    counts: z
      .object({
        cpu: z.number().int().min(0).max(60),
        memory: z.number().int().min(0).max(60),
        io: z.number().int().min(0).max(60),
      })
      .strict(),
    excluded: z.boolean(),
  })
  .strict();
type Aggregate = z.infer<typeof aggregateSchema>;
interface Series {
  id: string;
  hostId: string;
  containerName: string | null;
  identity: string;
  lastAt: number;
  aggregate: Aggregate;
  dirty: boolean;
}
const bucketAt = (at: number) => Math.floor(at / TREND.interval) * TREND.interval;
const aggregateAt = (at: number, excluded = false): Aggregate => ({
  at: bucketAt(at),
  sums: { cpu: 0, memory: 0, io: 0 },
  counts: { cpu: 0, memory: 0, io: 0 },
  excluded,
});
const numeric = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const seriesId = (hostId: string, containerName: string | null) => sha256Hex(JSON.stringify([hostId, containerName]));
const pointOf = (entry: Series): TrendPoint => ({
  at: entry.aggregate.at,
  identity: entry.identity,
  excluded: entry.aggregate.excluded,
  cpu: entry.aggregate.counts.cpu ? entry.aggregate.sums.cpu / entry.aggregate.counts.cpu : null,
  memory: entry.aggregate.counts.memory ? entry.aggregate.sums.memory / entry.aggregate.counts.memory : null,
  io: entry.aggregate.counts.io ? entry.aggregate.sums.io / entry.aggregate.counts.io : null,
  cpuSamples: entry.aggregate.counts.cpu,
  memorySamples: entry.aggregate.counts.memory,
  ioSamples: entry.aggregate.counts.io,
});
export interface MetricRollupDependencies {
  databaseHandle: DatabaseHandle;
  auditLog: AuditLog;
  maintenance: (hostId: string) => MaintenancePolicy["windows"];
  clock?: () => number;
  limits?: { series: number; rows: number };
}

/** Bounded minute-batched coarse metrics; failure never prevents the independent live metrics path. */
export class MetricRollups {
  private readonly cache = new Map<string, Series>();
  private readonly pending = new Map<string, { seriesId: string; point: TrendPoint }>();
  private readonly lastHostSample = new Map<string, number>();
  private readonly clock: () => number;
  private readonly limits: { series: number; rows: number };
  private loaded = false;
  private lastFlush = -Infinity;
  private lastSweep = -Infinity;
  private failedAt: number | null = null;
  private pressure = false;
  private rowCount = 0;
  private cursor = 0;
  private observations = new Map<string, MetricAnomalyView>();
  constructor(private readonly dependencies: MetricRollupDependencies) {
    this.clock = dependencies.clock ?? Date.now;
    this.limits = dependencies.limits ?? { series: TREND.series, rows: TREND.rows };
    if (
      !Number.isSafeInteger(this.limits.series) ||
      !Number.isSafeInteger(this.limits.rows) ||
      this.limits.series <= 0 ||
      this.limits.rows < this.limits.series
    )
      throw new RangeError("Invalid durable metric retention limits.");
  }
  private get db() {
    return this.dependencies.databaseHandle.database;
  }
  reset() {
    this.cache.clear();
    this.pending.clear();
    this.lastHostSample.clear();
    this.observations.clear();
    this.loaded = false;
    this.lastFlush = -Infinity;
    this.lastSweep = -Infinity;
    this.failedAt = null;
    this.pressure = false;
    this.rowCount = 0;
    this.cursor = 0;
  }
  private failed() {
    if (this.failedAt === null) log("Durable trend collection failed; review storage health. Live metrics continue.");
    this.failedAt = this.clock();
    // Failed batches cannot become an unbounded in-memory history during a long storage outage.
    this.pending.clear();
    for (const entry of this.cache.values()) {
      entry.aggregate.excluded = true;
      entry.dirty = true;
    }
  }
  private load() {
    if (this.loaded) return;
    const records = this.db
      .select()
      .from(metricSeries)
      .orderBy(desc(metricSeries.lastAt), asc(metricSeries.id))
      .limit(this.limits.series + 1)
      .all();
    if (records.length > this.limits.series) {
      const kept = records.slice(0, this.limits.series).map(({ id }) => id);
      this.db.delete(metricSeries).where(notInArray(metricSeries.id, kept)).run();
      this.pressure = true;
    }
    for (const row of records.slice(0, this.limits.series)) {
      let aggregate: Aggregate;
      try {
        aggregate = aggregateSchema.parse(JSON.parse(row.stateJson));
      } catch {
        aggregate = aggregateAt(row.lastAt, true);
      }
      this.cache.set(row.id, {
        id: row.id,
        hostId: row.hostId,
        containerName: row.containerName,
        identity: row.identity,
        lastAt: row.lastAt,
        aggregate,
        dirty: false,
      });
    }
    this.rowCount = this.db
      .select({ count: sql<number>`count(*)` })
      .from(metricRollups)
      .get()!.count;
    this.enforceRows();
    this.loaded = true;
  }
  record(hostId: string, report: MetricsReport) {
    const now = this.clock();
    if (this.failedAt !== null && now - this.failedAt < TREND.flush) return;
    const previous = this.lastHostSample.get(hostId);
    if (previous !== undefined && now - previous < TREND.cadence) return;
    try {
      this.load();
      const host = this.db.select().from(hosts).where(eq(hosts.id, hostId)).get();
      if (
        !host ||
        host.status !== HOST_STATUS_ACTIVE ||
        host.lastHeartbeatAt === null ||
        now < host.lastHeartbeatAt ||
        now - host.lastHeartbeatAt > HOST_SILENT_AFTER_MILLISECONDS
      )
        return;
      const health = host.healthJson === null ? {} : (JSON.parse(host.healthJson) as Record<string, unknown>);
      const snapshots = JSON.parse(host.containersJson) as {
        name: string;
        containerId: string;
        startedAt: number | null;
      }[];
      if (!Array.isArray(snapshots) || snapshots.length > REPORT_LIMITS.containers) return;
      const byName = new Map(snapshots.map((container) => [container.name, container]));
      const windows = this.dependencies.maintenance(hostId);
      const maintained = (name: string | null) =>
        windows.some(
          (window) =>
            window.startsAt <= now &&
            now < window.expiresAt &&
            (name === null || window.containerName === null || window.containerName === name),
        );
      for (const entry of this.cache.values())
        if (entry.hostId === hostId && maintained(entry.containerName)) {
          entry.aggregate.excluded = true;
          entry.dirty = true;
        }
      const bootId = typeof health.bootId === "string" && BOOT_ID_PATTERN.test(health.bootId) ? health.bootId : null;
      const cpuCount = numeric(health.cpuCount);
      const totalMemory = numeric(report.host?.memory.totalBytes ?? health.memoryTotalBytes);
      if (report.host !== null && bootId !== null && cpuCount && totalMemory)
        this.capture(hostId, null, sha256Hex(JSON.stringify([bootId, cpuCount, totalMemory])), now, maintained(null), {
          cpu: numeric(report.host.cpu.busyPercent),
          memory: numeric(report.host.memory.usedBytes),
          io:
            report.host.disk === null
              ? null
              : numeric(report.host.disk.readBytesPerSecond + report.host.disk.writeBytesPerSecond),
        });
      for (const usage of report.containers) {
        const snapshot = byName.get(usage.name);
        if (
          bootId === null ||
          !snapshot?.containerId ||
          snapshot.startedAt === null ||
          !Number.isFinite(snapshot.startedAt) ||
          (usage.cpuLimitCores === null && !cpuCount) ||
          (usage.memoryLimitBytes === null && !totalMemory)
        )
          continue;
        const identity = sha256Hex(
          JSON.stringify([
            bootId,
            snapshot.containerId,
            snapshot.startedAt,
            usage.cpuLimitCores,
            usage.memoryLimitBytes,
            cpuCount,
            totalMemory,
          ]),
        );
        this.capture(hostId, usage.name, identity, now, maintained(usage.name), {
          cpu: numeric(usage.cpuPercent),
          memory: numeric(usage.memoryBytes),
          io: numeric(usage.readBytesPerSecond + usage.writeBytesPerSecond),
        });
      }
      this.lastHostSample.delete(hostId);
      this.lastHostSample.set(hostId, now);
      if (this.lastHostSample.size > this.limits.series)
        this.lastHostSample.delete(this.lastHostSample.keys().next().value!);
      if (now - this.lastFlush >= TREND.flush && !this.flush()) return;
      this.failedAt = null;
    } catch {
      this.failed();
    }
  }
  private capture(
    hostId: string,
    containerName: string | null,
    identity: string,
    now: number,
    excluded: boolean,
    values: Record<TrendMetric, number | null>,
  ) {
    const id = seriesId(hostId, containerName);
    let entry = this.cache.get(id);
    if (entry === undefined) {
      if (excluded) return;
      if (this.cache.size >= this.limits.series) {
        this.pressure = true;
        return;
      }
      entry = {
        id,
        hostId,
        containerName,
        identity,
        lastAt: now - TREND.cadence,
        aggregate: aggregateAt(now),
        dirty: true,
      };
      this.cache.set(id, entry);
    }
    if (entry.identity === identity && now - entry.lastAt < TREND.cadence) return;
    if (entry.aggregate.at !== bucketAt(now)) {
      this.pending.set(`${id}:${entry.aggregate.at}`, { seriesId: id, point: pointOf(entry) });
      entry.aggregate = aggregateAt(now);
    }
    if (entry.identity !== identity) {
      entry.identity = identity;
      entry.aggregate = aggregateAt(now, true);
    }
    entry.aggregate.excluded ||= excluded;
    entry.lastAt = now;
    entry.dirty = true;
    if (!excluded)
      for (const metric of TREND_METRICS) {
        const value = values[metric];
        if (value !== null) {
          entry.aggregate.sums[metric] += value;
          entry.aggregate.counts[metric]++;
        }
      }
  }
  flush(): boolean {
    try {
      this.flushBatch();
      return true;
    } catch {
      this.failed();
      return false;
    }
  }
  private flushBatch() {
    this.load();
    const dirty = [...this.cache.values()].filter((entry) => entry.dirty);
    this.db.transaction(() => {
      for (const entry of dirty) {
        const values = {
          id: entry.id,
          hostId: entry.hostId,
          containerName: entry.containerName,
          identity: entry.identity,
          lastAt: entry.lastAt,
          stateJson: JSON.stringify(entry.aggregate),
        };
        this.db.insert(metricSeries).values(values).onConflictDoUpdate({ target: metricSeries.id, set: values }).run();
        this.db
          .update(metricAnomalies)
          .set({ state: "unknown" })
          .where(and(eq(metricAnomalies.seriesId, entry.id), ne(metricAnomalies.identity, entry.identity)))
          .run();
        this.pending.set(`${entry.id}:${entry.aggregate.at}`, { seriesId: entry.id, point: pointOf(entry) });
      }
      for (const { seriesId, point } of this.pending.values()) {
        const value = { seriesId, ...point };
        this.db
          .insert(metricRollups)
          .values(value)
          .onConflictDoUpdate({ target: [metricRollups.seriesId, metricRollups.at], set: value })
          .run();
      }
    });
    dirty.forEach((entry) => {
      entry.dirty = false;
    });
    this.pending.clear();
    this.lastFlush = this.clock();
    this.rowCount = this.db
      .select({ count: sql<number>`count(*)` })
      .from(metricRollups)
      .get()!.count;
    this.enforceRows();
  }
  private enforceRows() {
    if (this.rowCount <= this.limits.rows) return;
    this.pressure = true;
    this.db
      .delete(metricRollups)
      .where(sql`rowid IN (SELECT rowid FROM metric_rollups ORDER BY at ASC LIMIT ${this.rowCount - this.limits.rows})`)
      .run();
    this.rowCount = this.limits.rows;
  }
  sweep() {
    const now = this.clock();
    if (now - this.lastSweep < TREND.flush) return;
    try {
      if (!this.flush()) return;
      this.db
        .delete(metricSeries)
        .where(
          or(
            lt(metricSeries.lastAt, now - TREND.retention),
            sql`EXISTS (SELECT 1 FROM hosts WHERE hosts.id = ${metricSeries.hostId} AND hosts.status = ${HOST_STATUS_REVOKED})`,
          ),
        )
        .run();
      this.db
        .delete(metricRollups)
        .where(lt(metricRollups.at, now - TREND.retention))
        .run();
      const count = this.db
        .select({ count: sql<number>`count(*)` })
        .from(metricRollups)
        .get()!.count;
      if (count > this.limits.rows) {
        this.pressure = true;
        this.db
          .delete(metricRollups)
          .where(sql`rowid IN (SELECT rowid FROM metric_rollups ORDER BY at ASC LIMIT ${count - this.limits.rows})`)
          .run();
      }
      const ids = new Set(
        this.db
          .select({ id: metricSeries.id })
          .from(metricSeries)
          .all()
          .map(({ id }) => id),
      );
      for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
      this.rowCount = Math.min(count, this.limits.rows);
      this.lastSweep = now;
      this.failedAt = null;
    } catch {
      this.failed();
    }
  }
  private points(entry: Series, since: number) {
    return this.db
      .select()
      .from(metricRollups)
      .where(
        and(eq(metricRollups.seriesId, entry.id), gte(metricRollups.at, since), lt(metricRollups.at, this.clock() + 1)),
      )
      .orderBy(asc(metricRollups.at))
      .limit(Math.ceil(TREND.retention / TREND.interval) + 1)
      .all()
      .map(({ seriesId: _seriesId, ...point }) => point);
  }
  evaluate() {
    if (this.failedAt !== null) return;
    try {
      this.load();
      this.sweep();
      if (this.failedAt !== null) return;
      const entries = [...this.cache.values()].sort((a, b) => a.id.localeCompare(b.id));
      for (let index = 0; index < Math.min(TREND.evaluationBatch, entries.length); index++) {
        const entry = entries[(this.cursor + index) % entries.length]!;
        const now = this.clock();
        if (entry.aggregate.excluded || now < entry.lastAt || now - entry.lastAt > TREND.freshness) continue;
        const points = this.points(entry, now - TREND.baselineWindow - TREND.interval).filter(
          (point) => point.identity === entry.identity,
        );
        for (const metric of TREND_METRICS) {
          const baseline = baselineOf(points, metric, now);
          const previous = this.db
            .select()
            .from(metricAnomalies)
            .where(and(eq(metricAnomalies.seriesId, entry.id), eq(metricAnomalies.metric, metric)))
            .get();
          if (baseline === null) {
            if (previous?.state === "active")
              this.db
                .update(metricAnomalies)
                .set({ state: "unknown" })
                .where(eq(metricAnomalies.id, previous.id))
                .run();
            continue;
          }
          if (!baseline.elevated && previous === undefined) continue;
          const episodeChanged =
            previous === undefined ||
            previous.identity !== entry.identity ||
            (previous.state === "clear" && baseline.elevated);
          const values = {
            id: episodeChanged ? randomUUID() : previous.id,
            seriesId: entry.id,
            metric,
            identity: entry.identity,
            state: baseline.elevated ? ("active" as const) : ("clear" as const),
            observedAt: baseline.observedAt,
            baseline: baseline.median,
            mad: baseline.mad,
            threshold: baseline.threshold,
            observed: baseline.observed,
            baselineBuckets: baseline.baselineBuckets,
            baselineSamples: baseline.baselineSamples,
            recentSamples: baseline.recentSamples,
            pattern: baseline.pattern,
            feedback: episodeChanged ? null : previous.feedback,
            feedbackAt: episodeChanged ? null : previous.feedbackAt,
            feedbackBy: episodeChanged ? null : previous.feedbackBy,
          };
          this.db
            .insert(metricAnomalies)
            .values(values)
            .onConflictDoUpdate({ target: [metricAnomalies.seriesId, metricAnomalies.metric], set: values })
            .run();
        }
      }
      this.cursor = entries.length ? (this.cursor + TREND.evaluationBatch) % entries.length : 0;
      this.observations = new Map(this.allObservations().map((observation) => [observation.taskKey, observation]));
    } catch {
      this.failed();
    }
  }
  allObservations(): MetricAnomalyView[] {
    this.load();
    const now = this.clock();
    const policies = new Map<string, MaintenancePolicy["windows"]>();
    const maintained = (hostId: string, name: string | null) => {
      if (!policies.has(hostId)) policies.set(hostId, this.dependencies.maintenance(hostId));
      return policies
        .get(hostId)!
        .some(
          (window) =>
            window.startsAt <= now &&
            now < window.expiresAt &&
            (name === null || window.containerName === null || window.containerName === name),
        );
    };
    return this.db
      .select({ anomaly: metricAnomalies, series: metricSeries, hostLabel: hosts.label, hostStatus: hosts.status })
      .from(metricAnomalies)
      .innerJoin(metricSeries, eq(metricSeries.id, metricAnomalies.seriesId))
      .innerJoin(hosts, eq(hosts.id, metricSeries.hostId))
      .limit(this.limits.series * 3)
      .all()
      .map(({ anomaly, series, hostLabel, hostStatus }) => {
        const current = this.cache.get(series.id);
        const valid =
          this.failedAt === null &&
          !maintained(series.hostId, series.containerName) &&
          hostStatus === HOST_STATUS_ACTIVE &&
          current?.identity === anomaly.identity &&
          !current.aggregate.excluded &&
          now >= current.lastAt &&
          now - current.lastAt <= TREND.freshness &&
          now - anomaly.observedAt <= 3 * TREND.interval;
        return {
          ...anomaly,
          state: valid ? anomaly.state : ("unknown" as const),
          hostId: series.hostId,
          hostLabel,
          containerName: series.containerName,
          taskKey: anomalyTaskKey(series.id, anomaly.metric, anomaly.identity),
        };
      });
  }
  judges(key: string) {
    if (this.failedAt !== null || !key.startsWith("anomaly|")) return false;
    const [, id, , identity] = key.split("|");
    const entry = this.cache.get(id!);
    return entry === undefined || entry.identity !== identity || this.observations.get(key)?.state === "clear";
  }
  anomalies(hostId: string, containerName: string | null = null) {
    return this.allObservations().filter((item) => item.hostId === hostId && item.containerName === containerName);
  }
  feedback(actor: Actor, id: string, value: AnomalyFeedback) {
    const request = anomalyFeedbackSchema.parse(value);
    const existing = this.db.select().from(metricAnomalies).where(eq(metricAnomalies.id, id)).get();
    if (!existing) throw new DomainError(API_ERRORS.anomalyNotFound);
    if (existing.observedAt !== request.observedAt) throw new DomainError(API_ERRORS.anomalyChanged);
    this.db.transaction(() => {
      this.db
        .update(metricAnomalies)
        .set({ feedback: request.assessment, feedbackAt: this.clock(), feedbackBy: actor.userId })
        .where(eq(metricAnomalies.id, id))
        .run();
      this.dependencies.auditLog.recordUserAction(
        actor,
        AUDIT_ACTIONS.metricAnomalyFeedback,
        { kind: "anomaly", id },
        { assessment: request.assessment, observedAt: request.observedAt },
      );
    });
    return { assessment: request.assessment, recordedAt: this.clock() };
  }
  trends(hostId: string, containerName: string | null = null): MetricTrendView {
    this.load();
    const host = this.db.select().from(hosts).where(eq(hosts.id, hostId)).get();
    if (!host) throw new DomainError(API_ERRORS.hostNotFound);
    const entry = this.cache.get(seriesId(hostId, containerName));
    const now = this.clock();
    const health = {
      capacityLimited: this.pressure,
      unavailable: this.failedAt !== null,
      retainedSeries: this.cache.size,
      retainedRows: this.rowCount,
    };
    const result: MetricTrendView = {
      hostId,
      containerName,
      interval: TREND.interval,
      retention: TREND.retention,
      status: this.failedAt !== null ? "unavailable" : this.pressure && !entry ? "capacity" : "learning",
      lastSampleAt: entry?.lastAt ?? null,
      identity: entry?.identity ?? null,
      points: [],
      baselines: [],
      anomalies: [],
      health,
      explanation:
        "Learning requires 24 well-covered five-minute baseline buckets plus three consecutive recent buckets. Missing data is not filled with zero.",
    };
    if (!entry) return result;
    result.points = this.points(entry, now - TREND.retention);
    result.anomalies = this.anomalies(hostId, containerName);
    if (now < entry.lastAt || now - entry.lastAt > TREND.freshness || host.status !== HOST_STATUS_ACTIVE) {
      result.status = "stale";
      result.explanation = "No fresh identifiable samples; previous history is retained until expiry.";
      return result;
    }
    if (
      this.dependencies
        .maintenance(hostId)
        .some(
          (window) =>
            window.startsAt <= now &&
            now < window.expiresAt &&
            (containerName === null || window.containerName === null || window.containerName === containerName),
        )
    ) {
      result.status = "maintenance";
      result.explanation = "Maintenance samples are excluded from baseline learning and anomaly assessment.";
      return result;
    }
    result.baselines = TREND_METRICS.flatMap((metric) => {
      const value = baselineOf(
        result.points.filter((point) => point.identity === entry.identity),
        metric,
        now,
      );
      return value === null ? [] : [value];
    });
    if (result.baselines.length) {
      result.status = "ready";
      result.explanation =
        "Median/MAD baselines describe observed data, not a prediction. Sustained deviations create observations for a person; no recovery action is triggered.";
    }
    return result;
  }
}
