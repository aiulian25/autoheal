export const settingsMigration = {
  version: 8,
  name: "settings",
  sql: `
-- A host added without a name takes the one its runner reports first.
ALTER TABLE hosts ADD COLUMN named_by_runner INTEGER NOT NULL DEFAULT 0;

-- What the dashboard sets rather than the environment: notification channels, Home Assistant, and
-- a few remembered choices. One JSON value per key.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`,
};
