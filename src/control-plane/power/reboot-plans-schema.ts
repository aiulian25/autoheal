import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { REBOOT_PLAN_UNREADABLE } from "../../shared/reboot-plans.js";

export const rebootPlans = sqliteTable("reboot_plans", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  stateJson: text("state_json").notNull(),
  // What the plan says it is, kept beside it and indexed: the one that is running is found without reading the rest.
  // A row whose JSON cannot be read holds REBOOT_PLAN_UNREADABLE, so it is still found and still blocks new plans.
  status: text("status").notNull().default(REBOOT_PLAN_UNREADABLE),
});
