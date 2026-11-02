export const hostPackagesMigration = {
  version: 9,
  name: "host-packages",
  sql: `
-- The packages a host upgrade names; null for every other job.
ALTER TABLE jobs ADD COLUMN packages_json TEXT;
-- The host's boot when a reboot was handed to its runner: a new one proves the reboot happened.
ALTER TABLE jobs ADD COLUMN delivered_boot_id TEXT;

-- Each host's latest package check: what an upgrade would change, as its runner's check found it.
CREATE TABLE host_package_checks (
  host_id TEXT PRIMARY KEY REFERENCES hosts(id) ON DELETE CASCADE,
  job_id TEXT,
  checked_at INTEGER NOT NULL,
  check_json TEXT NOT NULL
);

-- What Ollama said a package is, asked once per name: a database or a service that keeps data, or not.
CREATE TABLE package_kinds (
  name TEXT PRIMARY KEY,
  keeps_data INTEGER NOT NULL,
  decided_at INTEGER NOT NULL
);
`,
};
