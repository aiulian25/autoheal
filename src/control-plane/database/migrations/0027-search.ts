export const searchMigration = {
  version: 27,
  name: "bounded-prefix-search",
  sql: `
CREATE INDEX search_tasks_title ON tasks(title COLLATE NOCASE);
CREATE INDEX search_tasks_host_title ON tasks(host_id, title COLLATE NOCASE);
CREATE INDEX search_incidents_container ON incidents(container_name COLLATE NOCASE);
CREATE INDEX search_incidents_host_container ON incidents(host_id, container_name COLLATE NOCASE);
CREATE INDEX search_runbooks_title ON runbooks(title COLLATE NOCASE) WHERE archived_at IS NULL;
CREATE INDEX search_changes_container ON host_changes(container_name COLLATE NOCASE, at DESC);
CREATE INDEX search_changes_host_container ON host_changes(host_id, container_name COLLATE NOCASE, at DESC);
CREATE INDEX search_hosts_recent ON hosts(status, last_heartbeat_at DESC);
`,
};
