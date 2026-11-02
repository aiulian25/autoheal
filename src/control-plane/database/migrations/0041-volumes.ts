export const volumesMigration = {
  version: 41,
  name: "volumes",
  sql: `
-- The host's Docker volumes, as its runner last reported them; null until it does.
ALTER TABLE hosts ADD COLUMN volumes_json TEXT;
-- The volume a job makes, or the ones it removes; null for every other job.
ALTER TABLE jobs ADD COLUMN volume_json TEXT;
`,
};
