export const jarvisAnswerLineMigration = {
  version: 75,
  name: "jarvis_answer_line",
  sql: `
-- When the last answer counted about a question was written, by Home Assistant's clock: an answer is weighed against
-- answers only, so one in the same second as its heard still counts, and the same answer read again does not.
ALTER TABLE jarvis_items ADD COLUMN last_answer_at INTEGER;
`,
};
