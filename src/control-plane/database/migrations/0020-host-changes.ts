export const hostChangesMigration = {
  version: 20,
  name: "host-changes",
  sql: `
-- What changed on a host between two of its reports: containers appearing, going, recreated, restarted by
-- Docker, stopping or starting; the host rebooting, Docker or its kernel changing. Kept two weeks.
CREATE TABLE host_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  container_name TEXT,
  details_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX host_changes_host_at ON host_changes(host_id, at);
`,
};
