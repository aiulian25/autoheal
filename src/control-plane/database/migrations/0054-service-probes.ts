export const serviceProbesMigration = {
  version: 54,
  name: "service_probes",
  sql: `
-- Checks made from Autoheal itself: apart from Docker's health, and what they saw, bounded by the service.
CREATE TABLE service_probes (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id),
  body_json TEXT NOT NULL,
  state TEXT NOT NULL,
  state_since INTEGER NOT NULL,
  failures INTEGER NOT NULL,
  answers INTEGER NOT NULL,
  last_checked_at INTEGER,
  last_latency_milliseconds INTEGER,
  last_problem TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX service_probes_host ON service_probes(host_id);
CREATE TABLE service_probe_samples (
  probe_id TEXT NOT NULL REFERENCES service_probes(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  latency_milliseconds INTEGER,
  PRIMARY KEY (probe_id, at)
);
CREATE TABLE service_probe_hours (
  probe_id TEXT NOT NULL REFERENCES service_probes(id) ON DELETE CASCADE,
  hour INTEGER NOT NULL,
  up INTEGER NOT NULL,
  down INTEGER NOT NULL,
  maintenance INTEGER NOT NULL,
  PRIMARY KEY (probe_id, hour)
);
`,
};
