export const reportTrimmedMigration = {
  version: 69,
  name: "report_trimmed",
  sql: `
-- What a host's latest report left out to fit, as a JSON list; null when it left out nothing.
ALTER TABLE hosts ADD COLUMN report_trimmed_json TEXT;
`,
};
