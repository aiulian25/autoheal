export const hostDefaultsMigration = {
  version: 13,
  name: "host-defaults",
  sql: `
-- What a host's containers do until someone sets one on its own, as two questions now: when one dies,
-- restart it or ask first; when a new image is out, apply it if Ollama calls it safe or ask first.
-- Each host keeps what its one setting meant.
ALTER TABLE hosts ADD COLUMN restart_default TEXT NOT NULL DEFAULT 'ask';
ALTER TABLE hosts ADD COLUMN update_default TEXT NOT NULL DEFAULT 'ask';
UPDATE hosts SET
  restart_default = CASE container_default WHEN 'ask' THEN 'ask' ELSE 'restart' END,
  update_default = CASE container_default WHEN 'both' THEN 'apply' ELSE 'ask' END;
ALTER TABLE hosts DROP COLUMN container_default;
`,
};
