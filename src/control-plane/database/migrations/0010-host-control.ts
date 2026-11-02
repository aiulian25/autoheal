export const hostControlMigration = {
  version: 10,
  name: "host-control",
  sql: `
-- What each host's page lets Autoheal do there on its own. A host added from now on asks first for
-- everything; the hosts already here keep what they did: restart a failed container on its own.
ALTER TABLE hosts ADD COLUMN container_default TEXT NOT NULL DEFAULT 'ask';
UPDATE hosts SET container_default = 'restart';
-- Removing the images no container uses: off, weekly, fortnightly or monthly; the build cache too, or not.
ALTER TABLE hosts ADD COLUMN image_cleanup TEXT NOT NULL DEFAULT 'off';
ALTER TABLE hosts ADD COLUMN clear_build_cache INTEGER NOT NULL DEFAULT 0;

-- A container's own ticks, once someone changed them; until then it takes its host's default.
CREATE TABLE container_controls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  container_name TEXT NOT NULL,
  restart_by_itself INTEGER NOT NULL,
  update_by_itself INTEGER NOT NULL,
  changed_at INTEGER NOT NULL,
  UNIQUE (host_id, container_name)
);
`,
};
