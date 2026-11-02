export const passkeysMigration = {
  version: 12,
  name: "passkeys",
  sql: `
-- Passkeys: signing in with the device's own lock (fingerprint, face, PIN) instead of the password
-- and the code. Only the public key is kept; each works only for the address it was made for.
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relying_party_id TEXT NOT NULL,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  transports_json TEXT NOT NULL DEFAULT '[]',
  synced INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys(user_id);
`,
};
