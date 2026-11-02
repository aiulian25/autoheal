export const metricRollupsMigration = {
  version: 28,
  name: "metric-rollups",
  sql: `
CREATE TABLE metric_series (id TEXT PRIMARY KEY NOT NULL, host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE, container_name TEXT, identity TEXT NOT NULL, last_at INTEGER NOT NULL, state_json TEXT NOT NULL) STRICT;
CREATE INDEX metric_series_host ON metric_series(host_id);
CREATE INDEX metric_series_recency ON metric_series(last_at);
CREATE TABLE metric_rollups (series_id TEXT NOT NULL REFERENCES metric_series(id) ON DELETE CASCADE, at INTEGER NOT NULL, identity TEXT NOT NULL, excluded INTEGER NOT NULL, cpu REAL, memory REAL, io REAL, cpu_samples INTEGER NOT NULL, memory_samples INTEGER NOT NULL, io_samples INTEGER NOT NULL, PRIMARY KEY(series_id, at)) STRICT;
CREATE INDEX metric_rollup_retention ON metric_rollups(at);
CREATE INDEX metric_rollup_baseline ON metric_rollups(series_id, identity, at);
CREATE TABLE metric_anomalies (id TEXT PRIMARY KEY NOT NULL, series_id TEXT NOT NULL REFERENCES metric_series(id) ON DELETE CASCADE, metric TEXT NOT NULL, identity TEXT NOT NULL, state TEXT NOT NULL, observed_at INTEGER NOT NULL, baseline REAL NOT NULL, mad REAL NOT NULL, threshold REAL NOT NULL, observed REAL NOT NULL, baseline_buckets INTEGER NOT NULL, baseline_samples INTEGER NOT NULL, recent_samples INTEGER NOT NULL, pattern TEXT NOT NULL, feedback TEXT, feedback_at INTEGER, feedback_by TEXT REFERENCES users(id) ON DELETE SET NULL, UNIQUE(series_id, metric)) STRICT;
`,
};
