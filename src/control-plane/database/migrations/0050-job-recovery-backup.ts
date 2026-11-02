export const jobRecoveryBackupMigration = {
  version: 50,
  name: "job_recovery_backup",
  sql: `
-- The safety copy a restore made, by name; null for every other job.
ALTER TABLE jobs ADD COLUMN recovery_backup_id TEXT;
`,
};
