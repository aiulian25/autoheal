export const applicationBackupFailureMigration = {
  version: 33,
  name: "application-backup-failure",
  sql: `
ALTER TABLE application_backup_runs ADD COLUMN failure TEXT;
`,
};
