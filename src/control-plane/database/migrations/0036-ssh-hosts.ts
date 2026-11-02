// Hosts the control plane reaches over SSH, with the user's own keys (or one it made), kept sealed.
export const sshHostsMigration = {
  version: 36,
  name: "ssh-hosts",
  sql: `
CREATE TABLE ssh_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  public_line TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  private_key TEXT NOT NULL,
  passphrase TEXT,
  made_by_autoheal INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
ALTER TABLE hosts ADD COLUMN kind TEXT NOT NULL DEFAULT 'runner';
ALTER TABLE hosts ADD COLUMN ssh_address TEXT;
ALTER TABLE hosts ADD COLUMN ssh_port INTEGER;
ALTER TABLE hosts ADD COLUMN ssh_user TEXT;
ALTER TABLE hosts ADD COLUMN ssh_key_id TEXT REFERENCES ssh_keys(id);
ALTER TABLE hosts ADD COLUMN ssh_host_key TEXT;
ALTER TABLE hosts ADD COLUMN ssh_host_key_fingerprint TEXT;
ALTER TABLE hosts ADD COLUMN ssh_runner_token TEXT;
ALTER TABLE hosts ADD COLUMN ssh_settings_json TEXT;
`,
};
