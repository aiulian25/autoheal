import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { DELIVERY_STATUSES, type DeliveryContext, type DeliveryFailure } from "../../shared/notification-deliveries.js";
import { NOTIFICATION_KINDS, type TaskPriority } from "../../shared/constants.js";
export const notificationRouting = sqliteTable("notification_routing", {
  id: integer("id").primaryKey(),
  rulesJson: text("rules_json").notNull().default("[]"),
  overflowCount: integer("overflow_count").notNull().default(0),
  lastOverflowAt: integer("last_overflow_at"),
});
export const notificationEvents = sqliteTable("notification_events", {
  id: text("id").primaryKey(),
  dedupeKey: text("dedupe_key").notNull().unique(),
  kind: text("kind").$type<DeliveryContext["kind"]>().notNull(),
  hostId: text("host_id"),
  resourceKind: text("resource_kind").$type<DeliveryContext["resourceKind"]>().notNull(),
  resourceId: text("resource_id"),
  priority: text("priority").$type<TaskPriority>().notNull(),
  resolved: integer("resolved", { mode: "boolean" }).notNull().default(false),
  messageJson: text("message_json").notNull(),
  ruleJson: text("rule_json"),
  createdAt: integer("created_at").notNull(),
  acknowledgedAt: integer("acknowledged_at"),
  acknowledgedBy: text("acknowledged_by"),
  escalateAt: integer("escalate_at"),
  escalated: integer("escalated", { mode: "boolean" }).notNull().default(false),
});
export const notificationDeliveries = sqliteTable(
  "notification_deliveries",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => notificationEvents.id, { onDelete: "cascade" }),
    channel: text("channel", { enum: NOTIFICATION_KINDS }).notNull(),
    stage: integer("stage").notNull().default(0),
    status: text("status", { enum: DELIVERY_STATUSES }).notNull(),
    configFingerprint: text("config_fingerprint"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    lastAttemptAt: integer("last_attempt_at"),
    acceptedAt: integer("accepted_at"),
    failureCode: text("failure_code").$type<DeliveryFailure>(),
  },
  (table) => [unique().on(table.eventId, table.channel, table.stage)],
);
