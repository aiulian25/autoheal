export const networkMigration = {
  version: 44,
  name: "network",
  sql: `
-- What the router says of the network. Each table is swept: see NetworkStore.sweep.
CREATE TABLE network_devices (
  mac TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  given_name TEXT,
  network TEXT,
  ip TEXT,
  wired INTEGER NOT NULL DEFAULT 0,
  uplink TEXT,
  uplink_port INTEGER,
  signal INTEGER,
  link_mbps INTEGER,
  best_link_mbps INTEGER,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  online INTEGER NOT NULL DEFAULT 1,
  known INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE network_usage_hours (
  mac TEXT NOT NULL,
  hour INTEGER NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mac, hour)
) WITHOUT ROWID;
CREATE TABLE network_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  mac TEXT,
  at INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX network_events_at ON network_events (at);
CREATE INDEX network_events_mac ON network_events (mac, kind, at);
-- One row a minute for each line while Autoheal watches: a minute with no row was not watched.
CREATE TABLE internet_samples (
  at INTEGER NOT NULL,
  wan TEXT NOT NULL,
  up INTEGER NOT NULL,
  latency INTEGER,
  state TEXT NOT NULL,
  PRIMARY KEY (at, wan)
) WITHOUT ROWID;
CREATE TABLE speed_tests (
  at INTEGER PRIMARY KEY,
  down_mbps REAL NOT NULL,
  up_mbps REAL NOT NULL,
  ping INTEGER,
  busy_mbps REAL,
  fair INTEGER NOT NULL
);
CREATE TABLE exposure_snapshots (
  at INTEGER PRIMARY KEY,
  hash TEXT NOT NULL,
  body_json TEXT NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0
);
-- What the router's log export says crossed it, or was stopped, by the hour.
CREATE TABLE network_flows (
  hour INTEGER NOT NULL,
  source TEXT NOT NULL,
  destination TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL,
  lines INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, source, destination, port, blocked)
) WITHOUT ROWID;
CREATE TABLE network_reports (
  at INTEGER PRIMARY KEY,
  body_json TEXT NOT NULL
);
`,
};
