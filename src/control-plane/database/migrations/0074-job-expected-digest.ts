export const jobExpectedDigestMigration = {
  version: 74,
  name: "job_expected_digest",
  sql: `
-- The registry digest of the image a person said yes to, for an update its runner carries out only to that image;
-- null where the newest behind the tag will do.
ALTER TABLE jobs ADD COLUMN expected_digest TEXT;
`,
};
