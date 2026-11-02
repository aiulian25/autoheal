import type { DatabaseHandle } from "../../src/control-plane/database/connection.js";
import { notificationDeliveries, notificationEvents } from "../../src/control-plane/notifications/delivery-schema.js";
import { DELIVERY_EVENT_LIMIT, type DeliveryMessage } from "../../src/shared/notification-deliveries.js";

const waiting: DeliveryMessage = {
  title: "An alert still waiting for its channel",
  body: "",
  priority: "high",
  link: "https://autoheal.test",
  action: "Open incident",
  tag: "warning",
};

/** As many alerts as the queue keeps, each still waiting to be sent: the queue refuses the next one, it is full. */
export function fillNotificationQueue(handle: DatabaseHandle, now: number) {
  const events = Array.from({ length: DELIVERY_EVENT_LIMIT }, (_, index) => ({
    id: `waiting-${index}`,
    dedupeKey: `waiting-${index}`,
    kind: "incident_handled" as const,
    resourceKind: "system" as const,
    priority: waiting.priority,
    messageJson: JSON.stringify(waiting),
    createdAt: now,
  }));
  handle.database.insert(notificationEvents).values(events).run();
  handle.database
    .insert(notificationDeliveries)
    .values(
      events.map(({ id }) => ({
        id: `delivery-${id}`,
        eventId: id,
        channel: "gotify" as const,
        status: "queued" as const,
        nextAttemptAt: now,
      })),
    )
    .run();
}
