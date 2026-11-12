import { z } from "zod";
import {
  MILLISECONDS_PER_HOUR,
  NOTIFICATION_KINDS,
  TASK_PRIORITIES,
  type NotificationKind,
  type TaskPriority,
} from "./constants.js";
export const NOTIFICATION_DELIVERY_ROUTES = {
  notificationDeliveries: "/api/notifications/deliveries",
  notificationAcknowledge: "/api/notifications/events/:eventId/acknowledge",
  notificationRouteUnsent: "/api/notifications/events/:eventId/route",
  notificationRetry: "/api/notifications/deliveries/:deliveryId/retry",
  notificationRouting: "/api/notifications/routing",
} as const;
export const DELIVERY_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60_000;
export const DELIVERY_EVENT_LIMIT = 2000;
// No one host's alerts waiting to go out may take more than this share of them: the others' still get in.
export const DELIVERY_PENDING_EVENTS_PER_HOST = DELIVERY_EVENT_LIMIT / 4;
export const DELIVERY_ATTEMPT_LIMIT = 8;
export const DELIVERY_TICK_LIMIT = 4;
export const DELIVERY_RETRY_MILLISECONDS = 60_000;
// Each failed try doubles the wait, at most this many times and never past an hour.
export const DELIVERY_RETRY_DOUBLINGS = 6;
export const DELIVERY_RETRY_MAXIMUM_MILLISECONDS = MILLISECONDS_PER_HOUR;
// The inbox's page of deliveries when none is asked for, and the most it gives at once.
export const DELIVERY_LIST_LIMITS = { default: 50, maximum: 100 } as const;
export const DELIVERY_STATUSES = ["queued", "sending", "accepted", "failed", "cancelled"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export type DeliveryFailure =
  | "refused"
  | "timeout"
  | "unreachable"
  | "not_configured"
  | "configuration_changed"
  | "interrupted"
  | "invalid_payload";
export const deliveryMessageSchema = z
  .object({
    title: z.string().max(256),
    body: z.string().max(4096),
    priority: z.enum(TASK_PRIORITIES),
    link: z.string().max(2048),
    action: z.string().max(128),
    tag: z.string().max(128),
  })
  .strict();
export type DeliveryMessage = z.infer<typeof deliveryMessageSchema>;
// What an alert is about.
export const DELIVERY_RESOURCE = { task: "task", incident: "incident", system: "system" } as const;
export type DeliveryResource = (typeof DELIVERY_RESOURCE)[keyof typeof DELIVERY_RESOURCE];
export interface DeliveryContext {
  resolved?: boolean;
  key: string;
  kind: "task_opened" | "task_reopened" | "task_resolved" | "incident_handled" | "incident_cleared";
  resourceKind: DeliveryResource;
  resourceId: string | null;
  hostId?: string | null;
}
// How many rules a person may set, and how soon or late an unacknowledged alert may be escalated.
export const NOTIFICATION_ROUTING_LIMITS = { rules: 16, escalateMinutes: { min: 5, max: 1440 } } as const;
const uniqueChannels = z
  .array(z.enum(NOTIFICATION_KINDS))
  .max(NOTIFICATION_KINDS.length)
  .refine((items) => new Set(items).size === items.length);
export const notificationRuleSchema = z
  .object({
    id: z.uuid(),
    hostId: z.uuid().nullable(),
    priorities: z
      .array(z.enum(TASK_PRIORITIES))
      .min(1)
      .max(4)
      .refine((items) => new Set(items).size === items.length),
    channels: uniqueChannels,
    quietStartMinute: z.number().int().min(0).max(1439).nullable(),
    quietEndMinute: z.number().int().min(0).max(1439).nullable(),
    urgentOverride: z.boolean(),
    escalateAfterMinutes: z
      .number()
      .int()
      .min(NOTIFICATION_ROUTING_LIMITS.escalateMinutes.min)
      .max(NOTIFICATION_ROUTING_LIMITS.escalateMinutes.max)
      .nullable(),
    escalationChannels: uniqueChannels,
  })
  .strict()
  .refine((rule) => (rule.quietStartMinute === null) === (rule.quietEndMinute === null))
  .refine((rule) => rule.quietStartMinute === null || rule.quietStartMinute !== rule.quietEndMinute)
  .refine((rule) => rule.escalateAfterMinutes === null || rule.escalationChannels.length > 0);
export type NotificationRule = z.infer<typeof notificationRuleSchema>;
export const notificationRoutingSchema = z
  .object({
    rules: z
      .array(notificationRuleSchema)
      .max(NOTIFICATION_ROUTING_LIMITS.rules)
      .refine((rules) => new Set(rules.map(({ id }) => id)).size === rules.length),
  })
  .strict();
export interface NotificationRoutingView {
  rules: NotificationRule[];
  overflowCount: number;
  lastOverflowAt: number | null;
}
export interface DeliveryView {
  id: string;
  channel: NotificationKind;
  stage: number;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: number | null;
  lastAttemptAt: number | null;
  acceptedAt: number | null;
  failureCode: DeliveryFailure | null;
}
export interface NotificationEventView {
  id: string;
  kind: DeliveryContext["kind"];
  hostId: string | null;
  resourceKind: DeliveryContext["resourceKind"];
  resourceId: string | null;
  priority: TaskPriority;
  createdAt: number;
  acknowledgedAt: number | null;
  acknowledgedBy: string | null;
  escalationAt: number | null;
  deliveries: DeliveryView[];
}
export interface NotificationInbox {
  events: NotificationEventView[];
  pendingCount: number;
  overflowCount: number;
  lastOverflowAt: number | null;
}
/** Quiet hours are explicitly UTC. End is exclusive; the next permitted slot is bounded to one day. */
export function notificationDueAt(rule: NotificationRule | null, priority: TaskPriority, now: number): number {
  if (
    !rule ||
    rule.quietStartMinute === null ||
    rule.quietEndMinute === null ||
    (priority === "urgent" && rule.urgentOverride)
  )
    return now;
  const day = 24 * 60 * 60_000;
  const midnight = Math.floor(now / day) * day;
  const minute = Math.floor((now - midnight) / 60_000);
  const { quietStartMinute: start, quietEndMinute: end } = rule;
  const quiet = start < end ? minute >= start && minute < end : minute >= start || minute < end;
  return quiet ? midnight + (minute < end ? 0 : day) + end * 60_000 : now;
}
