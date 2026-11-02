// Whether a host's runner may open a shell on the host itself, as its .env says; null from runners before it.
export const hostTerminalMigration = {
  version: 38,
  name: "host-terminal",
  sql: `
ALTER TABLE hosts ADD COLUMN host_terminal INTEGER;
`,
};
