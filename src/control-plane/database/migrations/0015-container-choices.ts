export const containerChoicesMigration = {
  version: 15,
  name: "container-choices",
  sql: `
-- A container's own answers, three to each question now: when it dies, restart it, ask first or only tell;
-- when a new image is out, apply it if Ollama calls it safe, ask first or never update it. Each container
-- keeps what its tick meant.
ALTER TABLE container_controls ADD COLUMN restart_choice TEXT NOT NULL DEFAULT 'ask';
ALTER TABLE container_controls ADD COLUMN update_choice TEXT NOT NULL DEFAULT 'ask';
UPDATE container_controls SET
  restart_choice = CASE restart_by_itself WHEN 1 THEN 'restart' ELSE 'ask' END,
  update_choice = CASE update_by_itself WHEN 1 THEN 'apply' ELSE 'ask' END;
ALTER TABLE container_controls DROP COLUMN restart_by_itself;
ALTER TABLE container_controls DROP COLUMN update_by_itself;
`,
};
