export const replayMigration = {
  version: 4,
  name: "replay",
  sql: `
CREATE TABLE replay_runs (
  id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('running', 'finished')),
  model_name TEXT NOT NULL,
  model_digest TEXT,
  draft_version_ids_json TEXT NOT NULL DEFAULT '[]',
  incident_count INTEGER NOT NULL
) STRICT;

CREATE TABLE replay_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  replay_run_id TEXT NOT NULL REFERENCES replay_runs(id) ON DELETE CASCADE,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  original_action TEXT,
  original_target TEXT,
  replay_action TEXT,
  replay_target TEXT,
  replay_diagnosis TEXT,
  changed INTEGER NOT NULL,
  error TEXT
) STRICT;
CREATE INDEX replay_results_run ON replay_results(replay_run_id, id);
`,
};
