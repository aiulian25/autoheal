export const availabilityGroupsMigration = {
  version: 64,
  name: "availability_groups",
  sql: `
-- An application's replicas across the fleet, and how much of it must keep serving through a reboot or a rollout.
CREATE TABLE availability_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  minimum_available INTEGER NOT NULL,
  evidence_fresh_seconds INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- One replica: its container on its host, what it shares its fate with, and the check that shows it is serving.
-- A member goes when its group does, and when its host leaves the fleet.
CREATE TABLE availability_group_members (
  group_id TEXT NOT NULL REFERENCES availability_groups(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  container_name TEXT NOT NULL,
  failure_domain TEXT,
  probe_id TEXT,
  PRIMARY KEY (group_id, host_id, container_name)
);
CREATE INDEX availability_group_members_host ON availability_group_members (host_id);
`,
};
