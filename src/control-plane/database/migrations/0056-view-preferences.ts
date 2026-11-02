export const viewPreferencesMigration = {
  version: 56,
  name: "user_view_preferences",
  sql: `
-- A person's own saved views and board layout. It goes with them, and it grants nothing.
CREATE TABLE user_view_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferences_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`,
};
