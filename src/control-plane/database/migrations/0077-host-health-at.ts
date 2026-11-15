export const healthReadMigration = {
  version: 77,
  name: "health_read",
  sql: `
-- When a host's system details were read: a report that could not read them keeps the ones before, with this time.
-- Details kept before this column have no time of their own: the report they came with is the latest they can be from.
ALTER TABLE hosts ADD COLUMN health_at INTEGER;
UPDATE hosts SET health_at = last_heartbeat_at WHERE health_json IS NOT NULL;
`,
};
