export const incidentEvidenceMigration = {
  version: 18,
  name: "incident-evidence",
  sql: `
-- What the control plane added to an incident's prompt besides its report (its earlier incidents), as the
-- sections it sent; null for incidents from before. Replays send the same.
ALTER TABLE incident_reports ADD COLUMN evidence_json TEXT;
`,
};
