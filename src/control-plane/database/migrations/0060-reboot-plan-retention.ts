export const rebootPlanRetentionMigration = {
  version: 60,
  name: "reboot_plan_retention",
  sql: `
-- Where each plan stands, beside the plan itself, so finding the one that is running costs an index seek rather
-- than reading and checking every plan ever made. Backfilled from what each row already says; a row whose JSON
-- cannot be read has no status to take, and keeps the name below so it is still found and still blocks new plans.
ALTER TABLE reboot_plans ADD COLUMN status TEXT NOT NULL DEFAULT 'unreadable';
UPDATE reboot_plans
  SET status = COALESCE(json_extract(state_json, '$.status'), 'unreadable')
  WHERE json_valid(state_json);
CREATE INDEX reboot_plans_status ON reboot_plans(status);
`,
};
