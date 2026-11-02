export const jobUndoMigration = {
  version: 21,
  name: "job-undo",
  sql: `
-- An update its runner puts back at once when the new container does not come back healthy: a container that
-- always takes new images, or one a person handed to the Ollama agent.
ALTER TABLE jobs ADD COLUMN undo_if_unhealthy INTEGER NOT NULL DEFAULT 0;
`,
};
