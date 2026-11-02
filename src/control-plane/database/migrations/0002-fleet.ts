export const fleetMigration = {
  version: 2,
  name: "fleet",
  sql: `
CREATE TABLE hosts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL COLLATE NOCASE UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  enrolled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  enrolled_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_heartbeat_at INTEGER,
  agent_version TEXT,
  dry_run INTEGER,
  event_stream_connected INTEGER NOT NULL DEFAULT 0,
  protected_containers_json TEXT NOT NULL DEFAULT '[]',
  restart_budget_json TEXT NOT NULL DEFAULT '{}',
  silent_since INTEGER
) STRICT;

CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id),
  container_name TEXT NOT NULL,
  image TEXT NOT NULL,
  trigger_event TEXT NOT NULL CHECK (trigger_event IN ('die', 'oom', 'unhealthy')),
  detected_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('deciding', 'decided', 'awaiting_approval', 'approved', 'resolved', 'dismissed', 'cancelled')
  ),
  decided_by TEXT CHECK (decided_by IN ('model', 'agent_fallback', 'human')),
  action TEXT CHECK (action IN ('restart', 'restart_dependency', 'escalate')),
  target TEXT,
  diagnosis TEXT,
  verdict TEXT,
  outcome TEXT,
  prompt_hash TEXT,
  model_name TEXT,
  model_digest TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX incidents_created ON incidents(created_at);
CREATE INDEX incidents_host ON incidents(host_id, created_at);
CREATE INDEX incidents_status ON incidents(status);

CREATE TABLE incident_reports (
  incident_id TEXT PRIMARY KEY REFERENCES incidents(id) ON DELETE CASCADE,
  report_json TEXT NOT NULL
) STRICT;

CREATE TABLE incident_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX incident_events_incident ON incident_events(incident_id, id);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  decided_by TEXT NOT NULL REFERENCES users(id),
  choice TEXT NOT NULL CHECK (choice IN ('restart', 'restart_dependency', 'dismiss')),
  target TEXT,
  note TEXT,
  decided_at INTEGER NOT NULL
) STRICT;
CREATE INDEX approvals_incident ON approvals(incident_id);

CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id),
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  approval_id TEXT NOT NULL REFERENCES approvals(id),
  action TEXT NOT NULL CHECK (action IN ('restart', 'restart_dependency')),
  target TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'done', 'expired', 'cancelled')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  delivered_at INTEGER,
  completed_at INTEGER,
  result_json TEXT
) STRICT;
CREATE INDEX work_items_host_status ON work_items(host_id, status);
`,
};
