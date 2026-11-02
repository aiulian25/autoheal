import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { hosts, users } from "./schema.js";

export const applicationBackupPlans = sqliteTable("application_backup_plans", {
  id: text("id").primaryKey(),
  hostId: text("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  definitionJson: text("definition_json").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  nextDueAt: integer("next_due_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
export const applicationBackupRuns = sqliteTable("application_backup_runs", {
  id: text("id").primaryKey(),
  planId: text("plan_id")
    .notNull()
    .references(() => applicationBackupPlans.id),
  hostId: text("host_id")
    .notNull()
    .references(() => hosts.id),
  operation: text("operation").notNull(),
  status: text("status").notNull(),
  taskJson: text("task_json").notNull(),
  requestedBy: text("requested_by").references(() => users.id, { onDelete: "set null" }),
  requestKey: text("request_key").notNull().unique(),
  artifactId: text("artifact_id"),
  safetyArtifactId: text("safety_artifact_id"),
  progressJson: text("progress_json"),
  resultJson: text("result_json"),
  failure: text("failure"),
  createdAt: integer("created_at").notNull(),
  claimedAt: integer("claimed_at"),
  finishedAt: integer("finished_at"),
});
export const applicationBackupArtifacts = sqliteTable("application_backup_artifacts", {
  id: text("id").primaryKey(),
  planId: text("plan_id")
    .notNull()
    .references(() => applicationBackupPlans.id),
  hostId: text("host_id")
    .notNull()
    .references(() => hosts.id),
  captureRunId: text("capture_run_id")
    .notNull()
    .references(() => applicationBackupRuns.id),
  keyCiphertext: text("key_ciphertext").notNull(),
  recipient: text("recipient").notNull(),
  status: text("status").notNull(),
  payloadBytes: integer("payload_bytes"),
  payloadSha256: text("payload_sha256"),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at").notNull(),
  verifiedAt: integer("verified_at"),
  lastDrillAt: integer("last_drill_at"),
  bootVerifiedAt: integer("boot_verified_at"),
  imageId: text("image_id"),
  retainedByRunId: text("retained_by_run_id").references(() => applicationBackupRuns.id),
});
