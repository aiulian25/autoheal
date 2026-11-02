export const topologyMigration = {
  version: 25,
  name: "topology-and-operation-previews",
  sql: `
ALTER TABLE hosts ADD COLUMN topology_json TEXT;
ALTER TABLE hosts ADD COLUMN operation_previews INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN expected_resources_fingerprint TEXT;
ALTER TABLE update_runs ADD COLUMN expected_resources_json TEXT;
`,
};
