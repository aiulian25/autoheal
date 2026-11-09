export const editSettingsMigration = {
  version: 66,
  name: "edit_settings",
  sql: `
-- An edit's new settings, sealed, for its runner to fetch once; emptied then, or once the job has an outcome.
ALTER TABLE jobs ADD COLUMN edit_settings TEXT;
`,
};
