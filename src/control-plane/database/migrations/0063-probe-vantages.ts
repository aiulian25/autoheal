export const probeVantagesMigration = {
  version: 63,
  name: "probe_vantages",
  sql: `
-- Whether a host's runner can make service checks from its own host. A runner from before this says nothing, so its
-- checks stay with Autoheal rather than being taken as made from there.
ALTER TABLE hosts ADD COLUMN service_probes INTEGER NOT NULL DEFAULT 0;
`,
};
