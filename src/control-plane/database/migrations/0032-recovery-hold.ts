export const recoveryHoldMigration = {
  version: 32,
  name: "recovery-hold",
  sql: `
ALTER TABLE hosts ADD COLUMN recovery_hold_json TEXT;
`,
};
