export const jarvisQuestionsMigration = {
  version: 73,
  name: "jarvis_questions",
  sql: `
-- A question to the assistant: the updates it asks about, how often it was heard, when it is asked again, its code.
-- And for every message, when the last line Home Assistant wrote about it was written: each line counts once.
ALTER TABLE jarvis_items ADD COLUMN members_json TEXT;
ALTER TABLE jarvis_items ADD COLUMN asks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jarvis_items ADD COLUMN next_ask_at INTEGER;
ALTER TABLE jarvis_items ADD COLUMN code_sealed TEXT;
ALTER TABLE jarvis_items ADD COLUMN last_line_at INTEGER;
-- The answer a question got, by whom and how, and how each update it started ended.
ALTER TABLE jarvis_items ADD COLUMN answer_json TEXT;
`,
};
