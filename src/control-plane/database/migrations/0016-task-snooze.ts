export const taskSnoozeMigration = {
  version: 16,
  name: "task-snooze",
  sql: `
-- A task a person put off: until then it waits among what was noticed, not among what needs them.
ALTER TABLE tasks ADD COLUMN snoozed_until INTEGER;
`,
};
