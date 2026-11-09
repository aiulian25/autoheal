export const clockSkewMigration = {
  version: 67,
  name: "clock_skew",
  sql: `
-- How far a host's clock is from the control plane's while that pauses its runner's automatic actions; null otherwise.
ALTER TABLE hosts ADD COLUMN clock_skew_seconds INTEGER;
`,
};
