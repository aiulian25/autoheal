import { integer, primaryKey, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { TREND_METRICS } from "../../shared/metric-trends.js";
export const metricSeries = sqliteTable("metric_series", {
  id: text("id").primaryKey(),
  hostId: text("host_id").notNull(),
  containerName: text("container_name"),
  identity: text("identity").notNull(),
  lastAt: integer("last_at").notNull(),
  stateJson: text("state_json").notNull(),
});
export const metricRollups = sqliteTable(
  "metric_rollups",
  {
    seriesId: text("series_id")
      .notNull()
      .references(() => metricSeries.id, { onDelete: "cascade" }),
    at: integer("at").notNull(),
    identity: text("identity").notNull(),
    excluded: integer("excluded", { mode: "boolean" }).notNull(),
    cpu: real("cpu"),
    memory: real("memory"),
    io: real("io"),
    cpuSamples: integer("cpu_samples").notNull(),
    memorySamples: integer("memory_samples").notNull(),
    ioSamples: integer("io_samples").notNull(),
  },
  (table) => [primaryKey({ columns: [table.seriesId, table.at] })],
);
export const metricAnomalies = sqliteTable(
  "metric_anomalies",
  {
    id: text("id").primaryKey(),
    seriesId: text("series_id")
      .notNull()
      .references(() => metricSeries.id, { onDelete: "cascade" }),
    metric: text("metric", { enum: TREND_METRICS }).notNull(),
    identity: text("identity").notNull(),
    state: text("state", { enum: ["active", "clear", "unknown"] }).notNull(),
    observedAt: integer("observed_at").notNull(),
    baseline: real("baseline").notNull(),
    mad: real("mad").notNull(),
    threshold: real("threshold").notNull(),
    observed: real("observed").notNull(),
    baselineBuckets: integer("baseline_buckets").notNull(),
    baselineSamples: integer("baseline_samples").notNull(),
    recentSamples: integer("recent_samples").notNull(),
    pattern: text("pattern", { enum: ["elevated", "rising"] }).notNull(),
    feedback: text("feedback", { enum: ["useful", "expected", "false_positive"] }),
    feedbackAt: integer("feedback_at"),
    feedbackBy: text("feedback_by"),
  },
  (table) => [unique().on(table.seriesId, table.metric)],
);
