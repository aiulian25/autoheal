export const notificationDeliveriesMigration = {
  version: 26,
  name: "notification-deliveries",
  sql: `
CREATE TABLE notification_routing (id INTEGER PRIMARY KEY CHECK (id = 1), rules_json TEXT NOT NULL DEFAULT '[]', overflow_count INTEGER NOT NULL DEFAULT 0, last_overflow_at INTEGER) STRICT;
INSERT INTO notification_routing (id) VALUES (1);
CREATE TABLE notification_events (
 id TEXT PRIMARY KEY NOT NULL, dedupe_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
 host_id TEXT, resource_kind TEXT NOT NULL, resource_id TEXT, priority TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0,
 message_json TEXT NOT NULL, rule_json TEXT, created_at INTEGER NOT NULL,
 acknowledged_at INTEGER, acknowledged_by TEXT, escalate_at INTEGER, escalated INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX notification_event_resource ON notification_events(resource_kind, resource_id, created_at);
CREATE INDEX notification_event_created ON notification_events(created_at);
CREATE TABLE notification_deliveries (
 id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
 channel TEXT NOT NULL, stage INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
 config_fingerprint TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER,
 last_attempt_at INTEGER, accepted_at INTEGER, failure_code TEXT,
 UNIQUE (event_id, channel, stage)
) STRICT;
CREATE INDEX notification_delivery_due ON notification_deliveries(status, next_attempt_at);
`,
};
