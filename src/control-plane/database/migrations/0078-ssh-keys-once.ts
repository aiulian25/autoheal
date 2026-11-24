export const sshKeysOnceMigration = {
  version: 78,
  name: "ssh_keys_once",
  sql: `
-- A key is kept once: hosts signing in with a copy of one (the same fingerprint) sign in with its oldest copy.
UPDATE hosts SET ssh_key_id = (
  SELECT kept.id FROM ssh_keys AS kept
  WHERE kept.fingerprint = (SELECT own.fingerprint FROM ssh_keys AS own WHERE own.id = hosts.ssh_key_id)
  ORDER BY kept.created_at, kept.id
  LIMIT 1
)
WHERE ssh_key_id IS NOT NULL;
-- A host taken off the dashboard lets go of its key, and a key no host signs in with goes: copies, and keys left over.
UPDATE hosts SET ssh_key_id = NULL WHERE status <> 'active';
DELETE FROM ssh_keys WHERE id NOT IN (SELECT ssh_key_id FROM hosts WHERE ssh_key_id IS NOT NULL);
`,
};
