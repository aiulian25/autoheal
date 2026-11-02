export const containerBackupsMigration = {
  version: 46,
  name: "container_backups",
  sql: `
ALTER TABLE jobs ADD COLUMN backup_json TEXT;
`,
};
