import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ProbeOutcome, ProbeState } from "../../shared/probes.js";
import { hosts } from "../database/schema.js";

export const serviceProbes = sqliteTable(
  "service_probes",
  {
    id: text("id").primaryKey(),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id),
    bodyJson: text("body_json").notNull(),
    state: text("state").$type<ProbeState>().notNull(),
    stateSince: integer("state_since").notNull(),
    failures: integer("failures").notNull(),
    answers: integer("answers").notNull(),
    lastCheckedAt: integer("last_checked_at"),
    lastLatencyMilliseconds: integer("last_latency_milliseconds"),
    lastProblem: text("last_problem"),
    certificateJson: text("certificate_json"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("service_probes_host").on(table.hostId)],
);

export const serviceProbeSamples = sqliteTable(
  "service_probe_samples",
  {
    probeId: text("probe_id")
      .notNull()
      .references(() => serviceProbes.id, { onDelete: "cascade" }),
    at: integer("at").notNull(),
    outcome: text("outcome").$type<ProbeOutcome>().notNull(),
    latencyMilliseconds: integer("latency_milliseconds"),
  },
  (table) => [primaryKey({ columns: [table.probeId, table.at] })],
);

export const serviceProbeHours = sqliteTable(
  "service_probe_hours",
  {
    probeId: text("probe_id")
      .notNull()
      .references(() => serviceProbes.id, { onDelete: "cascade" }),
    hour: integer("hour").notNull(),
    up: integer("up").notNull(),
    down: integer("down").notNull(),
    maintenance: integer("maintenance").notNull(),
  },
  (table) => [primaryKey({ columns: [table.probeId, table.hour] })],
);
