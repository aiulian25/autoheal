export const containersStaleMigration = {
  version: 68,
  name: "containers_stale",
  sql: `
-- When the containers kept for a host were reported, while its runner says Docker could not list them since; null
-- while the list is current.
ALTER TABLE hosts ADD COLUMN containers_stale_since INTEGER;
`,
};
