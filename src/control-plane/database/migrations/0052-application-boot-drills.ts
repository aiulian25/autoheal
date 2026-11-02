export const applicationBootDrillsMigration = {
  version: 52,
  name: "application_boot_drills",
  sql: `
-- The image a backup was made with, and when the application last started from a restored copy of it.
ALTER TABLE application_backup_artifacts ADD COLUMN image_id TEXT;
ALTER TABLE application_backup_artifacts ADD COLUMN boot_verified_at INTEGER;
`,
};
