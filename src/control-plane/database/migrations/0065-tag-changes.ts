export const tagChangesMigration = {
  version: 65,
  name: "tag_changes",
  sql: `
-- The tag a change-tag job moves its container to.
ALTER TABLE jobs ADD COLUMN target_tag TEXT;
-- Whether the host's runner can move a container to a newer tag by its Compose files.
ALTER TABLE hosts ADD COLUMN tag_changes INTEGER NOT NULL DEFAULT 0;
-- The newer version a person ignores for one container: one tag, or '*' for every new version.
CREATE TABLE ignored_versions (
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  container_name TEXT NOT NULL,
  version TEXT NOT NULL,
  ignored_by TEXT NOT NULL,
  ignored_at INTEGER NOT NULL,
  PRIMARY KEY (host_id, container_name)
);
`,
};
