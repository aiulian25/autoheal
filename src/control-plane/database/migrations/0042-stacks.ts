export const stacksMigration = {
  version: 42,
  name: "stacks",
  sql: `
-- The Compose project a job acts on; null for every other job.
ALTER TABLE jobs ADD COLUMN stack_json TEXT;
`,
};
