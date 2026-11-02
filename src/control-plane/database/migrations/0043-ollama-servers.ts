export const ollamaServersMigration = {
  version: 43,
  name: "ollama-servers",
  sql: `
-- More Ollama servers, beside the default one, which stays in the .env and Settings.
CREATE TABLE ollama_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  model TEXT NOT NULL,
  context_tokens INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
-- Null is the default server. A removed server's hosts go back to it.
ALTER TABLE hosts ADD COLUMN ollama_server_id TEXT REFERENCES ollama_servers(id) ON DELETE SET NULL;
`,
};
