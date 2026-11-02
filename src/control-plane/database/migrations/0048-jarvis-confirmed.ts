export const jarvisConfirmedMigration = {
  version: 48,
  name: "jarvis_confirmed",
  sql: `
ALTER TABLE jarvis_items ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
`,
};
