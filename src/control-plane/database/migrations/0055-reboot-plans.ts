export const rebootPlansMigration = {
  version: 55,
  name: "reboot_plans",
  sql: `
-- An approved plan, with each host's reboot job and where it stands, so a restart carries on without asking again.
CREATE TABLE reboot_plans (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  state_json TEXT NOT NULL
);
`,
};
