export const restartSafetyMigration = {
  version: 34,
  name: "restart-safety",
  sql: `
ALTER TABLE hosts ADD COLUMN restart_wait_json TEXT;
ALTER TABLE hosts ADD COLUMN restart_resets_json TEXT NOT NULL DEFAULT '{}';
`,
};
