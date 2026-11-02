export const stackRestartsMigration = {
  version: 49,
  name: "stack_restarts",
  sql: `
-- A stack's containers restarted one at a time: the plan, and where it has got to.
CREATE TABLE stack_restarts (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id),
  stack TEXT NOT NULL,
  names_json TEXT NOT NULL,
  status TEXT NOT NULL,
  current TEXT,
  done_json TEXT NOT NULL,
  failed TEXT,
  outcome TEXT,
  refusal TEXT,
  current_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  actor_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- One going per host, whatever asks at once.
CREATE UNIQUE INDEX stack_restarts_one_running ON stack_restarts(host_id) WHERE status = 'running';
CREATE INDEX stack_restarts_latest ON stack_restarts(host_id, created_at);
`,
};
