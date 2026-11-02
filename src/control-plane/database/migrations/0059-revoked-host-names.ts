export const revokedHostNamesMigration = {
  version: 59,
  name: "revoked_host_names",
  sql: `
-- A revoked host gives its name back. Those revoked before this kept theirs, which blocked it for good.
UPDATE hosts SET label = label || '-revoked-' || substr(id, 1, 8) WHERE status = 'revoked';
`,
};
