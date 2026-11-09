export const clockOffsetMigration = {
  version: 71,
  name: "clock_offset",
  sql: `
-- How far a host's clock is from the control plane's, in seconds, as its last full report found it; null when unknown.
ALTER TABLE hosts ADD COLUMN clock_offset_seconds INTEGER;
`,
};
