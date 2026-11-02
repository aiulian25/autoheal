/** Durable application plans, independently encrypted artifact keys and replay-safe work. */
export const applicationBackupsMigration = {
  version: 29,
  name: "application-backups",
  sql: `
ALTER TABLE hosts ADD COLUMN application_backups INTEGER NOT NULL DEFAULT 0;
CREATE TABLE application_backup_plans (
 id TEXT PRIMARY KEY NOT NULL, host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, definition_json TEXT NOT NULL, enabled INTEGER NOT NULL,
 next_due_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX application_backup_plan_due ON application_backup_plans(enabled, next_due_at);
CREATE TABLE application_backup_runs (
 id TEXT PRIMARY KEY NOT NULL, plan_id TEXT NOT NULL REFERENCES application_backup_plans(id),
 host_id TEXT NOT NULL REFERENCES hosts(id), operation TEXT NOT NULL, status TEXT NOT NULL,
 task_json TEXT NOT NULL, requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
 request_key TEXT NOT NULL UNIQUE, artifact_id TEXT, safety_artifact_id TEXT,
 progress_json TEXT, result_json TEXT, created_at INTEGER NOT NULL, claimed_at INTEGER, finished_at INTEGER
) STRICT;
CREATE INDEX application_backup_run_delivery ON application_backup_runs(host_id, status, created_at);
CREATE TABLE application_backup_artifacts (
 id TEXT PRIMARY KEY NOT NULL, plan_id TEXT NOT NULL REFERENCES application_backup_plans(id),
 host_id TEXT NOT NULL REFERENCES hosts(id), capture_run_id TEXT NOT NULL REFERENCES application_backup_runs(id),
 key_ciphertext TEXT NOT NULL, recipient TEXT NOT NULL, status TEXT NOT NULL,
 payload_bytes INTEGER, payload_sha256 TEXT, metadata_json TEXT, created_at INTEGER NOT NULL,
 verified_at INTEGER, last_drill_at INTEGER, retained_by_run_id TEXT REFERENCES application_backup_runs(id)
) STRICT;
CREATE INDEX application_backup_artifact_retention ON application_backup_artifacts(plan_id, created_at);
`,
};
