export const nobodyActsForTheOwnerMigration = {
  version: 80,
  name: "nobody_acts_for_the_owner",
  sql: `
-- Autoheal is one person's: nobody holds grants, no job is delegated to anyone, and no runner is asked to check either.
DROP TABLE resource_permissions;
ALTER TABLE jobs DROP COLUMN operator_user_id;
ALTER TABLE hosts DROP COLUMN resource_permissions;
`,
};
