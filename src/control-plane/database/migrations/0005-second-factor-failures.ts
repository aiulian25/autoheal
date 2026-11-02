export const secondFactorFailuresMigration = {
  version: 5,
  name: "second-factor-failures",
  sql: `
ALTER TABLE sessions ADD COLUMN second_factor_failures INTEGER NOT NULL DEFAULT 0;
`,
};
