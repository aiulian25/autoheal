// Whether a host's runner may put a new app on it, as its .env says.
export const hostDeployMigration = {
  version: 39,
  name: "host-deploy",
  sql: `
ALTER TABLE hosts ADD COLUMN host_deploy INTEGER;
`,
};
