export const rolloutsMigration = {
  version: 30,
  name: "rollouts",
  sql: `
ALTER TABLE hosts ADD COLUMN rollouts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN rollout_json TEXT;
CREATE TABLE rollouts (id TEXT PRIMARY KEY NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, state_json TEXT NOT NULL) STRICT;
CREATE INDEX rollouts_created ON rollouts(created_at);
`,
};
