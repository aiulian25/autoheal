import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const rebootPlans = sqliteTable("reboot_plans", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  stateJson: text("state_json").notNull(),
});
