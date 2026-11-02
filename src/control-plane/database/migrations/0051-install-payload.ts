export const installPayloadMigration = {
  version: 51,
  name: "install_payload",
  sql: `
-- An install's details, sealed, for its runner to fetch; emptied once the job has an outcome.
ALTER TABLE jobs ADD COLUMN install_payload TEXT;
`,
};
