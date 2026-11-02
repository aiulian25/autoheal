export const jarvisMigration = {
  version: 47,
  name: "jarvis",
  sql: `
CREATE TABLE jarvis_items (
  id TEXT PRIMARY KEY,
  group_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  task_ids_json TEXT NOT NULL,
  message_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX jarvis_items_status ON jarvis_items (status, sent_at);
`,
};
