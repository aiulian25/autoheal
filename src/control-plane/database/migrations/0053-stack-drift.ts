export const stackDriftMigration = {
  version: 53,
  name: "stack_drift",
  sql: `
-- How a stack differs from its files, by name alone: what its runner last said, and since when.
CREATE TABLE stack_drift (
  host_id TEXT NOT NULL REFERENCES hosts(id),
  project TEXT NOT NULL,
  drift_json TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_observed_at INTEGER NOT NULL,
  PRIMARY KEY (host_id, project)
);
`,
};
