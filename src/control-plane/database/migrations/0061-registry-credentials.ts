export const registryCredentialsMigration = {
  version: 61,
  name: "registry_credentials",
  sql: `
-- What a private registry wants, for the hosts allowed to use it. The password is sealed with the backup
-- passphrase, as every other secret here is. One credential per registry and repository scope.
CREATE TABLE registry_credentials (
  id TEXT PRIMARY KEY,
  registry TEXT NOT NULL,
  -- Null is the whole registry; otherwise the repository, or the path the covered ones start with.
  repository TEXT,
  username TEXT NOT NULL,
  sealed_password TEXT NOT NULL,
  -- Null is every host, now and later; otherwise a JSON array of host ids.
  host_ids_json TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX registry_credentials_scope ON registry_credentials (registry, ifnull(repository, ''));
`,
};
