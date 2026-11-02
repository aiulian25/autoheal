export const tasksMigration = {
  version: 7,
  name: "tasks",
  sql: `
-- A silent host is a task now, opened and closed by its detector.
ALTER TABLE hosts DROP COLUMN silent_since;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  source TEXT NOT NULL,
  detector_key TEXT,
  assignee_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  assignee_agent TEXT,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  host_id TEXT REFERENCES hosts(id),
  resource_kind TEXT,
  resource_id TEXT,
  resource_label TEXT,
  labels_json TEXT NOT NULL DEFAULT '[]',
  incident_id TEXT REFERENCES incidents(id),
  occurrences INTEGER NOT NULL DEFAULT 1,
  checked_out_by TEXT,
  checked_out_at INTEGER,
  closed_by_detector INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  closed_at INTEGER
);
-- One open task per problem: a detector that sees it again joins that task.
CREATE UNIQUE INDEX tasks_open_detector_key ON tasks(detector_key)
  WHERE detector_key IS NOT NULL AND status NOT IN ('done', 'cancelled');
CREATE INDEX tasks_detector_key ON tasks(detector_key);
CREATE INDEX tasks_status ON tasks(status);
CREATE INDEX tasks_parent ON tasks(parent_id);

CREATE TABLE task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_agent TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX task_comments_task ON task_comments(task_id);

CREATE TABLE task_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX task_activity_task ON task_activity(task_id);

CREATE TABLE task_blockers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  blocked_by_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE (task_id, blocked_by_id)
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id),
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  container_name TEXT NOT NULL,
  action TEXT NOT NULL,
  requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  requested_by_agent TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  delivered_at INTEGER,
  completed_at INTEGER,
  outcome TEXT,
  output TEXT
);
CREATE INDEX jobs_host_status ON jobs(host_id, status);
CREATE INDEX jobs_task ON jobs(task_id);

CREATE TABLE widget_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_hint TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
`,
};
