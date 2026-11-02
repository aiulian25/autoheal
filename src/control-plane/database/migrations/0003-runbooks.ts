export const runbooksMigration = {
  version: 3,
  name: "runbooks",
  sql: `
CREATE TABLE runbooks (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'container', 'image')),
  pattern TEXT,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  archived_at INTEGER
) STRICT;

CREATE TABLE runbook_versions (
  id TEXT PRIMARY KEY,
  runbook_id TEXT NOT NULL REFERENCES runbooks(id),
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE (runbook_id, version)
) STRICT;

CREATE TABLE prompt_snapshots (
  hash TEXT PRIMARY KEY,
  system_prompt TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
`,
};
