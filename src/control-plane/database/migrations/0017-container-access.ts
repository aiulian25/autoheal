export const containerAccessMigration = {
  version: 17,
  name: "container-access",
  sql: `
-- Whether the host's .env lets a person open shells, browse files and edit its containers, as its runner says.
ALTER TABLE hosts ADD COLUMN container_access INTEGER;
`,
};
