export const resourcePermissionsMigration = {
  version: 24,
  name: "resource-permissions",
  sql: `
ALTER TABLE hosts ADD COLUMN resource_permissions INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN operator_user_id TEXT;
CREATE TABLE resource_permissions (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0,
  grants_json TEXT NOT NULL DEFAULT '[]'
) STRICT;
`,
};
