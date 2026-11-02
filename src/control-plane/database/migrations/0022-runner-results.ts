export const runnerResultsMigration = {
  version: 22,
  name: "runner-results",
  sql: `
CREATE TABLE runner_results (
  id TEXT PRIMARY KEY NOT NULL,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  payload_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`,
};
