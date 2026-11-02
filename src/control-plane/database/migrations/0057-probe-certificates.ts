export const probeCertificatesMigration = {
  version: 57,
  name: "probe_certificates",
  sql: `
-- The certificate a TLS check last saw: its public facts only, one per check.
ALTER TABLE service_probes ADD COLUMN certificate_json TEXT;
`,
};
