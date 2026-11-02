export const incidentUsageMigration = {
  version: 19,
  name: "incident-usage",
  sql: `
-- The failed container's usage in the half hour before its incident was decided, at most 60 readings;
-- null for incidents from before and for containers that sent none.
ALTER TABLE incident_reports ADD COLUMN usage_json TEXT;
`,
};
