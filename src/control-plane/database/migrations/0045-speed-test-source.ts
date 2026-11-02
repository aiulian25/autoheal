export const speedTestSourceMigration = {
  version: 45,
  name: "speed_test_source",
  sql: `
-- Who measured it: the router, or the machine Autoheal runs on when the router will not.
ALTER TABLE speed_tests ADD COLUMN source TEXT NOT NULL DEFAULT 'router';
`,
};
