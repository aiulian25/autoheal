export const networksMigration = {
  version: 40,
  name: "networks",
  sql: `
-- The host's Docker networks, as its runner last reported them; null until it does.
ALTER TABLE hosts ADD COLUMN networks_json TEXT;
-- Whether the host's nightly clean-up also removes the networks removed apps left behind.
ALTER TABLE hosts ADD COLUMN clear_left_networks INTEGER NOT NULL DEFAULT 0;
-- The network a job makes, or the ones it removes; null for every other job.
ALTER TABLE jobs ADD COLUMN network_json TEXT;
`,
};
