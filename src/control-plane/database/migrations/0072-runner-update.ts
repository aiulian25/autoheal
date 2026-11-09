export const runnerUpdateMigration = {
  version: 72,
  name: "runner_update",
  sql: `
-- How a sidecar runner's last update from the dashboard went, as its last full report said; null when none is known.
ALTER TABLE hosts ADD COLUMN runner_update_json TEXT;
`,
};
