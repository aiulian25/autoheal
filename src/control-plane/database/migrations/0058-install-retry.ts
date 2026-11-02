export const installRetryMigration = {
  version: 58,
  name: "install_retry",
  sql: `
-- What an own-files install wrote, sealed, kept after its job ends: all a retry of that very install may be judged by.
ALTER TABLE jobs ADD COLUMN install_retry TEXT;
`,
};
