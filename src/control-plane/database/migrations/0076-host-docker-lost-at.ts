export const dockerLostMigration = {
  version: 76,
  name: "docker_lost",
  sql: `
-- Since when a host that had Docker has reported without it: nothing in its containers is watched or healed meanwhile.
-- Null while it reports Docker, and for a host that never had it.
ALTER TABLE hosts ADD COLUMN docker_lost_at INTEGER;
`,
};
