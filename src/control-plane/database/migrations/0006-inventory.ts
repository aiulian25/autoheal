export const inventoryMigration = {
  version: 6,
  name: "inventory",
  sql: `
ALTER TABLE hosts RENAME COLUMN agent_version TO runner_version;
ALTER TABLE hosts ADD COLUMN health_json TEXT;
ALTER TABLE hosts ADD COLUMN containers_json TEXT NOT NULL DEFAULT '[]';
`,
};
