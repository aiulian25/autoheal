import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const networkDevices = sqliteTable("network_devices", {
  mac: text("mac").primaryKey(),
  name: text("name").notNull(),
  givenName: text("given_name"),
  network: text("network"),
  ip: text("ip"),
  wired: integer("wired").notNull().default(0),
  uplink: text("uplink"),
  uplinkPort: integer("uplink_port"),
  signal: integer("signal"),
  linkMbps: integer("link_mbps"),
  bestLinkMbps: integer("best_link_mbps"),
  firstSeen: integer("first_seen").notNull(),
  lastSeen: integer("last_seen").notNull(),
  online: integer("online").notNull().default(1),
  known: integer("known").notNull().default(0),
  muted: integer("muted").notNull().default(0),
});

export const networkUsageHours = sqliteTable(
  "network_usage_hours",
  {
    mac: text("mac").notNull(),
    hour: integer("hour").notNull(),
    received: integer("received").notNull().default(0),
    sent: integer("sent").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.mac, table.hour] })],
);

export const networkEvents = sqliteTable("network_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),
  mac: text("mac"),
  at: integer("at").notNull(),
  detail: text("detail").notNull().default(""),
});

export const internetSamples = sqliteTable(
  "internet_samples",
  {
    at: integer("at").notNull(),
    wan: text("wan").notNull(),
    up: integer("up").notNull(),
    latency: integer("latency"),
    state: text("state").notNull(),
  },
  (table) => [primaryKey({ columns: [table.at, table.wan] })],
);

export const speedTests = sqliteTable("speed_tests", {
  at: integer("at").primaryKey(),
  downMbps: real("down_mbps").notNull(),
  upMbps: real("up_mbps").notNull(),
  ping: integer("ping"),
  busyMbps: real("busy_mbps"),
  fair: integer("fair").notNull(),
  source: text("source").notNull().default("router"),
});

export const exposureSnapshots = sqliteTable("exposure_snapshots", {
  at: integer("at").primaryKey(),
  hash: text("hash").notNull(),
  bodyJson: text("body_json").notNull(),
  confirmed: integer("confirmed").notNull().default(0),
});

export const networkFlows = sqliteTable(
  "network_flows",
  {
    hour: integer("hour").notNull(),
    source: text("source").notNull(),
    destination: text("destination").notNull(),
    port: integer("port").notNull().default(0),
    blocked: integer("blocked").notNull(),
    lines: integer("lines").notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.hour, table.source, table.destination, table.port, table.blocked] })],
);

export const networkReports = sqliteTable("network_reports", {
  at: integer("at").primaryKey(),
  bodyJson: text("body_json").notNull(),
});
