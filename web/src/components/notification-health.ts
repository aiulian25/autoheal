import type { NotificationDeliveryView } from "../../../src/shared/api.js";
import { TEXT } from "../constants.js";
import { dateTime, shortTimeAgo } from "../format.js";

/** Describes observed server acceptance, never whether a device received the notification. */
export function notificationHealth(delivery?: NotificationDeliveryView): {
  tone: "off" | "good" | "danger";
  text: string;
  detail: string;
} {
  const words = TEXT.services.deliveryHealth;
  const detail = words.history(
    delivery?.lastAttemptAt == null ? words.notObserved : dateTime(delivery.lastAttemptAt),
    delivery?.lastSuccessAt == null ? words.notObserved : dateTime(delivery.lastSuccessAt),
  );
  if (delivery?.status === "healthy" && delivery.lastSuccessAt != null)
    return { tone: "good", text: words.accepted(shortTimeAgo(delivery.lastSuccessAt)), detail };
  if (delivery?.status === "degraded" && delivery.lastAttemptAt != null) {
    const reason = delivery.failureCode === null ? "" : words.failures[delivery.failureCode];
    return {
      tone: "danger",
      text: words.failed(shortTimeAgo(delivery.lastAttemptAt)),
      detail: `${reason} ${detail}`.trim(),
    };
  }
  return { tone: "off", text: delivery?.lastAttemptAt == null ? words.configured : words.pending, detail };
}
