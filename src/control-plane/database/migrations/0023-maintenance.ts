export const maintenanceMigration = {
  version: 23,
  name: "maintenance",
  sql: `
ALTER TABLE hosts ADD COLUMN maintenance_generation INTEGER;
CREATE TABLE maintenance_revision (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL);
INSERT INTO maintenance_revision VALUES (1, 0);
CREATE TABLE maintenance_windows (
  id TEXT PRIMARY KEY NOT NULL,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  container_name TEXT,
  owner TEXT NOT NULL,
  reason TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > starts_at AND expires_at - starts_at <= 86400000)
) STRICT;
CREATE INDEX maintenance_host_expiry ON maintenance_windows(host_id, expires_at);
`,
};
