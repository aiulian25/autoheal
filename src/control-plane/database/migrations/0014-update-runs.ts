export const updateRunsMigration = {
  version: 14,
  name: "update-runs",
  sql: `
-- Several containers' new images on one host, applied one at a time in the order a person ticked them.
-- The ones before done_count are done; while running, current_job_id is the one updating now; once
-- stopped, the one at done_count did not come back healthy and the ones after it wait.
CREATE TABLE update_runs (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id),
  names_json TEXT NOT NULL,
  status TEXT NOT NULL,
  done_count INTEGER NOT NULL DEFAULT 0,
  current_job_id TEXT REFERENCES jobs(id),
  requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX update_runs_host ON update_runs(host_id, created_at);
CREATE INDEX update_runs_job ON update_runs(current_job_id);
`,
};
