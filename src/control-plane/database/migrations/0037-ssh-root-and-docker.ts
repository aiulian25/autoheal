// Whether a host's last report had Docker (an SSH host may have none), and an SSH host's root password, kept
// sealed, with how it is used: through sudo (the user's own password) or su (root's).
export const sshRootAndDockerMigration = {
  version: 37,
  name: "ssh-root-and-docker",
  sql: `
ALTER TABLE hosts ADD COLUMN docker INTEGER NOT NULL DEFAULT 1;
ALTER TABLE hosts ADD COLUMN ssh_root_password TEXT;
ALTER TABLE hosts ADD COLUMN ssh_root_method TEXT;
`,
};
