import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { API_ERRORS, type NotificationDeliveryView } from "../../shared/api.js";
import {
  AUDIT_ACTIONS,
  MILLISECONDS_PER_MINUTE,
  NOTIFICATION_KINDS,
  TASK_RESOURCE,
  type NotificationKind,
} from "../../shared/constants.js";
import {
  DELIVERY_ATTEMPT_LIMIT,
  DELIVERY_EVENT_LIMIT,
  DELIVERY_PENDING_EVENTS_PER_HOST,
  DELIVERY_LIST_LIMITS,
  DELIVERY_RESOURCE,
  DELIVERY_RETENTION_MILLISECONDS,
  DELIVERY_RETRY_DOUBLINGS,
  DELIVERY_RETRY_MAXIMUM_MILLISECONDS,
  DELIVERY_RETRY_MILLISECONDS,
  DELIVERY_TICK_LIMIT,
  deliveryMessageSchema,
  notificationDueAt,
  notificationRoutingSchema,
  notificationRuleSchema,
  type DeliveryContext,
  type DeliveryFailure,
  type DeliveryMessage,
  type NotificationEventView,
  type NotificationInbox,
  type NotificationRoutingView,
  type NotificationRule,
} from "../../shared/notification-deliveries.js";
import { sha256Hex } from "../../shared/hash.js";
import { redactSecrets } from "../../shared/redaction.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { incidents, tasks } from "../database/schema.js";
import { DomainError } from "../domain-error.js";
import type { NotificationChannels } from "./notifier.js";
import { notificationDeliveries, notificationEvents, notificationRouting } from "./delivery-schema.js";

// Where a channel sends, and how: an alert queued for one setup is not sent to another. A webhook's format joins the
// end, so the other channels' fingerprints stay as they were.
export const channelFingerprint = (config: NonNullable<NotificationChannels[NotificationKind]>) =>
  sha256Hex(
    JSON.stringify([
      config.url,
      "topic" in config ? config.topic : null,
      config.token,
      ...("format" in config ? [config.format] : []),
    ]),
  );
type Sender = (kind: NotificationKind, message: DeliveryMessage) => Promise<DeliveryFailure | null>;
type DeliveryRow = typeof notificationDeliveries.$inferSelect;
const PENDING = ["queued", "sending"] as const;
const unknown = (): NotificationDeliveryView => ({
  status: "unknown",
  lastAttemptAt: null,
  lastSuccessAt: null,
  failureCode: null,
});

/** Durable logical alerts, bounded provider attempts and metadata-only browser views. */
export class DeliveryService {
  private sender: Sender | null = null;
  private running: Promise<void> | null = null;
  private recovered = false;
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly audit: AuditLog,
    private readonly channels: () => NotificationChannels,
    private readonly clock = Date.now,
  ) {}
  private get database() {
    return this.handle.database;
  }
  useSender(sender: Sender) {
    this.sender = sender;
  }
  reset() {
    this.recovered = false;
  }
  rules(): NotificationRoutingView {
    const stored = this.database.select().from(notificationRouting).get()!;
    const { rules } = notificationRoutingSchema.parse({ rules: JSON.parse(stored.rulesJson) });
    return { rules, overflowCount: stored.overflowCount, lastOverflowAt: stored.lastOverflowAt };
  }
  saveRules(actor: Actor, change: { rules: NotificationRule[] }): NotificationRoutingView {
    const { rules } = notificationRoutingSchema.parse(change);
    this.database
      .update(notificationRouting)
      .set({ rulesJson: JSON.stringify(rules) })
      .run();
    this.audit.recordUserAction(
      actor,
      AUDIT_ACTIONS.notificationRoutesSaved,
      { kind: "notification", id: "routing" },
      { ruleCount: rules.length },
    );
    return this.rules();
  }
  private hostOf(context: DeliveryContext): string | null {
    const resource =
      context.resourceId === null
        ? undefined
        : context.resourceKind === "incident"
          ? this.database
              .select({ hostId: incidents.hostId })
              .from(incidents)
              .where(eq(incidents.id, context.resourceId))
              .get()
          : context.resourceKind === "task"
            ? this.database.select({ hostId: tasks.hostId }).from(tasks).where(eq(tasks.id, context.resourceId)).get()
            : undefined;
    if (resource?.hostId && context.hostId && resource.hostId !== context.hostId)
      throw new DomainError(API_ERRORS.invalidTarget);
    return resource?.hostId ?? context.hostId ?? null;
  }
  enqueue(context: DeliveryContext, given: DeliveryMessage): string {
    const hostId = this.hostOf(context);
    const key = sha256Hex(JSON.stringify([context.kind, hostId, context.key]));
    const before = this.database
      .select({ id: notificationEvents.id })
      .from(notificationEvents)
      .where(eq(notificationEvents.dedupeKey, key))
      .get();
    if (before) return before.id;
    const now = this.clock();
    this.prune(now);
    const total = this.database.select({ count: count() }).from(notificationEvents).get()!.count;
    if (total >= DELIVERY_EVENT_LIMIT || this.waitingFrom(hostId) >= DELIVERY_PENDING_EVENTS_PER_HOST) {
      this.database
        .update(notificationRouting)
        .set({ overflowCount: sql`${notificationRouting.overflowCount} + 1`, lastOverflowAt: now })
        .run();
      throw new DomainError(API_ERRORS.notificationQueueFull);
    }
    const message = deliveryMessageSchema.parse({
      ...given,
      title: redactSecrets(given.title).slice(0, 256),
      body: redactSecrets(given.body).slice(0, 4096),
    });
    const rule =
      this.rules().rules.find(
        (rule) => (rule.hostId === null || rule.hostId === hostId) && rule.priorities.includes(message.priority),
      ) ?? null;
    const channels = rule?.channels ?? NOTIFICATION_KINDS.filter((kind) => this.channels()[kind] !== null);
    const id = randomUUID();
    this.database.transaction(() => {
      this.database
        .insert(notificationEvents)
        .values({
          id,
          dedupeKey: key,
          kind: context.kind,
          hostId,
          resourceKind: context.resourceKind,
          resourceId: context.resourceId,
          priority: message.priority,
          resolved: context.resolved || context.kind === "task_resolved" || context.kind === "incident_cleared",
          messageJson: JSON.stringify(message),
          ruleJson: rule === null ? null : JSON.stringify(rule),
          createdAt: now,
          escalateAt:
            context.resolved ||
            context.kind === "task_resolved" ||
            context.kind === "incident_cleared" ||
            rule?.escalateAfterMinutes == null
              ? null
              : notificationDueAt(rule, message.priority, now) + rule.escalateAfterMinutes * MILLISECONDS_PER_MINUTE,
        })
        .run();
      for (const channel of channels) this.queue(id, channel, 0, notificationDueAt(rule, message.priority, now));
      if (
        context.resourceId &&
        (context.resolved || context.kind === "task_resolved" || context.kind === "incident_cleared")
      ) {
        const older = this.database
          .select({ id: notificationEvents.id })
          .from(notificationEvents)
          .where(
            and(
              eq(notificationEvents.resourceKind, context.resourceKind),
              eq(notificationEvents.resourceId, context.resourceId),
              ne(notificationEvents.id, id),
              isNull(notificationEvents.acknowledgedAt),
            ),
          )
          .all();
        if (older.length) {
          this.database
            .update(notificationEvents)
            .set({ escalated: true, escalateAt: null })
            .where(
              inArray(
                notificationEvents.id,
                older.map(({ id }) => id),
              ),
            )
            .run();
          this.database
            .update(notificationDeliveries)
            .set({ status: "cancelled", nextAttemptAt: null })
            .where(
              and(
                inArray(
                  notificationDeliveries.eventId,
                  older.map(({ id }) => id),
                ),
                eq(notificationDeliveries.status, "queued"),
              ),
            )
            .run();
        }
      }
    });
    return id;
  }
  private queue(eventId: string, channel: NotificationKind, stage: number, due: number) {
    const config = this.channels()[channel];
    this.database
      .insert(notificationDeliveries)
      .values({
        id: randomUUID(),
        eventId,
        channel,
        stage,
        status: "queued",
        nextAttemptAt: due,
        configFingerprint: config === null ? null : channelFingerprint(config),
      })
      .onConflictDoNothing()
      .run();
  }
  // How many of one host's alerts still wait to go out; the control plane's own are not counted against a host.
  private waitingFrom(hostId: string | null): number {
    if (hostId === null) return 0;
    return this.database
      .select({ count: countDistinct(notificationEvents.id) })
      .from(notificationEvents)
      .innerJoin(notificationDeliveries, eq(notificationDeliveries.eventId, notificationEvents.id))
      .where(and(eq(notificationEvents.hostId, hostId), inArray(notificationDeliveries.status, [...PENDING])))
      .get()!.count;
  }
  private prune(now: number) {
    this.database
      .delete(notificationEvents)
      .where(lt(notificationEvents.createdAt, now - DELIVERY_RETENTION_MILLISECONDS))
      .run();
    const total = this.database.select({ count: count() }).from(notificationEvents).get()!.count;
    if (total < DELIVERY_EVENT_LIMIT) return;
    const pending = this.database
      .select({ id: notificationDeliveries.eventId })
      .from(notificationDeliveries)
      .where(inArray(notificationDeliveries.status, [...PENDING]));
    const removable = this.database
      .select({ id: notificationEvents.id })
      .from(notificationEvents)
      .where(notInArray(notificationEvents.id, pending))
      .orderBy(asc(notificationEvents.createdAt))
      .limit(total - DELIVERY_EVENT_LIMIT + 1)
      .all();
    if (removable.length)
      this.database
        .delete(notificationEvents)
        .where(
          inArray(
            notificationEvents.id,
            removable.map(({ id }) => id),
          ),
        )
        .run();
  }
  async tick() {
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  private async drain() {
    if (!this.sender) return;
    const now = this.clock();
    if (!this.recovered) {
      this.database
        .update(notificationDeliveries)
        .set({ status: "queued", failureCode: "interrupted" })
        .where(eq(notificationDeliveries.status, "sending"))
        .run();
      this.recovered = true;
    }
    this.prune(now);
    const escalate = this.database
      .select()
      .from(notificationEvents)
      .where(
        and(
          eq(notificationEvents.escalated, false),
          isNull(notificationEvents.acknowledgedAt),
          lte(notificationEvents.escalateAt, now),
        ),
      )
      .limit(DELIVERY_TICK_LIMIT)
      .all();
    for (const event of escalate) {
      let rule: NotificationRule | null;
      try {
        rule = event.ruleJson === null ? null : notificationRuleSchema.parse(JSON.parse(event.ruleJson));
      } catch {
        this.database
          .update(notificationEvents)
          .set({ escalated: true })
          .where(eq(notificationEvents.id, event.id))
          .run();
        this.database
          .update(notificationDeliveries)
          .set({ status: "failed", failureCode: "invalid_payload", nextAttemptAt: null })
          .where(and(eq(notificationDeliveries.eventId, event.id), eq(notificationDeliveries.status, "queued")))
          .run();
        continue;
      }
      this.database.transaction(() => {
        for (const channel of rule?.escalationChannels ?? [])
          this.queue(event.id, channel, 1, notificationDueAt(rule, event.priority, now));
        this.database
          .update(notificationEvents)
          .set({ escalated: true })
          .where(eq(notificationEvents.id, event.id))
          .run();
      });
    }
    const due = this.database
      .select()
      .from(notificationDeliveries)
      .where(and(eq(notificationDeliveries.status, "queued"), lte(notificationDeliveries.nextAttemptAt, now)))
      .orderBy(asc(notificationDeliveries.nextAttemptAt), asc(notificationDeliveries.id))
      .limit(DELIVERY_TICK_LIMIT)
      .all();
    for (const delivery of due) await this.attempt(delivery);
  }
  private async attempt(delivery: DeliveryRow) {
    const event = this.database
      .select()
      .from(notificationEvents)
      .where(eq(notificationEvents.id, delivery.eventId))
      .get();
    if (!event || event.acknowledgedAt !== null) {
      this.database
        .update(notificationDeliveries)
        .set({ status: "cancelled", nextAttemptAt: null })
        .where(eq(notificationDeliveries.id, delivery.id))
        .run();
      return;
    }
    if (delivery.attempts >= DELIVERY_ATTEMPT_LIMIT) {
      this.database
        .update(notificationDeliveries)
        .set({ status: "failed", nextAttemptAt: null, failureCode: delivery.failureCode ?? "interrupted" })
        .where(eq(notificationDeliveries.id, delivery.id))
        .run();
      return;
    }
    const config = this.channels()[delivery.channel];
    if (config === null || delivery.configFingerprint !== channelFingerprint(config)) {
      this.database
        .update(notificationDeliveries)
        .set({
          status: "failed",
          failureCode: config === null ? "not_configured" : "configuration_changed",
          nextAttemptAt: null,
        })
        .where(eq(notificationDeliveries.id, delivery.id))
        .run();
      return;
    }
    let message: DeliveryMessage;
    let rule: NotificationRule | null;
    try {
      message = deliveryMessageSchema.parse(JSON.parse(event.messageJson));
      rule = event.ruleJson === null ? null : notificationRuleSchema.parse(JSON.parse(event.ruleJson));
    } catch {
      this.database
        .update(notificationDeliveries)
        .set({ status: "failed", nextAttemptAt: null, failureCode: "invalid_payload" })
        .where(eq(notificationDeliveries.id, delivery.id))
        .run();
      return;
    }
    const now = this.clock();
    const due = notificationDueAt(rule, message.priority, now);
    if (due > now) {
      this.database
        .update(notificationDeliveries)
        .set({ nextAttemptAt: due })
        .where(eq(notificationDeliveries.id, delivery.id))
        .run();
      return;
    }
    const attempts = delivery.attempts + 1;
    const next = notificationDueAt(
      rule,
      message.priority,
      now +
        Math.min(
          DELIVERY_RETRY_MAXIMUM_MILLISECONDS,
          DELIVERY_RETRY_MILLISECONDS * 2 ** Math.min(DELIVERY_RETRY_DOUBLINGS, attempts - 1),
        ),
    );
    // Taken only while it is still queued: one cancelled since this tick looked, as a resolution does, is not sent.
    const claimed = this.database
      .update(notificationDeliveries)
      .set({ status: "sending", attempts, lastAttemptAt: now, nextAttemptAt: next, failureCode: null })
      .where(and(eq(notificationDeliveries.id, delivery.id), eq(notificationDeliveries.status, "queued")))
      .run();
    if (claimed.changes === 0) return;
    let failure: DeliveryFailure | null;
    try {
      failure = await this.sender!(delivery.channel, message);
    } catch {
      failure = "unreachable";
    }
    this.database
      .update(notificationDeliveries)
      .set({
        status:
          failure === null
            ? "accepted"
            : attempts >= DELIVERY_ATTEMPT_LIMIT || failure === "not_configured" || failure === "configuration_changed"
              ? "failed"
              : "queued",
        acceptedAt: failure === null ? this.clock() : null,
        failureCode: failure,
        nextAttemptAt:
          failure === null ||
          attempts >= DELIVERY_ATTEMPT_LIMIT ||
          failure === "not_configured" ||
          failure === "configuration_changed"
            ? null
            : next,
      })
      .where(eq(notificationDeliveries.id, delivery.id))
      .run();
  }
  list(filter: { incidentId?: string; limit?: number } = {}): NotificationInbox {
    const routing = this.rules();
    const rows = this.database
      .select()
      .from(notificationEvents)
      .where(
        filter.incidentId
          ? and(
              eq(notificationEvents.resourceKind, DELIVERY_RESOURCE.incident),
              eq(notificationEvents.resourceId, filter.incidentId),
            )
          : undefined,
      )
      .orderBy(desc(notificationEvents.createdAt), desc(notificationEvents.id))
      .limit(Math.max(1, Math.min(DELIVERY_LIST_LIMITS.maximum, filter.limit ?? DELIVERY_LIST_LIMITS.default)))
      .all();
    return {
      events: this.eventViews(rows),
      pendingCount: this.database
        .select({ count: count() })
        .from(notificationDeliveries)
        .where(inArray(notificationDeliveries.status, [...PENDING]))
        .get()!.count,
      overflowCount: routing.overflowCount,
      lastOverflowAt: routing.lastOverflowAt,
    };
  }
  /** The alerts about a container's incidents and tasks, newest first, each with its deliveries. */
  aboutContainer(hostId: string, containerName: string, limit: number): NotificationEventView[] {
    const ofIncidents = this.database
      .select({ id: incidents.id })
      .from(incidents)
      .where(and(eq(incidents.hostId, hostId), eq(incidents.containerName, containerName)));
    const ofTasks = this.database
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.hostId, hostId),
          eq(tasks.resourceKind, TASK_RESOURCE.container),
          eq(tasks.resourceId, containerName),
        ),
      );
    const rows = this.database
      .select()
      .from(notificationEvents)
      .where(
        or(
          and(
            eq(notificationEvents.resourceKind, DELIVERY_RESOURCE.incident),
            inArray(notificationEvents.resourceId, ofIncidents),
          ),
          and(
            eq(notificationEvents.resourceKind, DELIVERY_RESOURCE.task),
            inArray(notificationEvents.resourceId, ofTasks),
          ),
        ),
      )
      .orderBy(desc(notificationEvents.createdAt), desc(notificationEvents.id))
      .limit(limit)
      .all();
    return this.eventViews(rows);
  }

  // Each alert as the inbox shows it.
  private eventViews(rows: (typeof notificationEvents.$inferSelect)[]): NotificationEventView[] {
    const deliveries = this.deliveriesOf(rows.map((row) => row.id));
    return rows.map(
      ({
        id,
        kind,
        hostId,
        resourceKind,
        resourceId,
        priority,
        createdAt,
        acknowledgedAt,
        acknowledgedBy,
        escalateAt,
      }) => ({
        id,
        kind,
        hostId,
        resourceKind,
        resourceId,
        priority,
        createdAt,
        acknowledgedAt,
        acknowledgedBy,
        escalationAt: escalateAt,
        deliveries: deliveries.get(id) ?? [],
      }),
    );
  }

  // Every listed alert's deliveries in one statement, each alert's by channel and then stage.
  private deliveriesOf(eventIds: string[]) {
    const rows = this.database
      .select({
        eventId: notificationDeliveries.eventId,
        id: notificationDeliveries.id,
        channel: notificationDeliveries.channel,
        stage: notificationDeliveries.stage,
        status: notificationDeliveries.status,
        attempts: notificationDeliveries.attempts,
        nextAttemptAt: notificationDeliveries.nextAttemptAt,
        lastAttemptAt: notificationDeliveries.lastAttemptAt,
        acceptedAt: notificationDeliveries.acceptedAt,
        failureCode: notificationDeliveries.failureCode,
      })
      .from(notificationDeliveries)
      .where(inArray(notificationDeliveries.eventId, eventIds))
      .orderBy(
        asc(notificationDeliveries.eventId),
        asc(notificationDeliveries.channel),
        asc(notificationDeliveries.stage),
      )
      .all();
    const byEvent = new Map<string, Omit<(typeof rows)[number], "eventId">[]>();
    for (const { eventId, ...delivery } of rows) {
      byEvent.set(eventId, [...(byEvent.get(eventId) ?? []), delivery]);
    }
    return byEvent;
  }
  acknowledge(actor: Actor, eventId: string) {
    const event = this.database.select().from(notificationEvents).where(eq(notificationEvents.id, eventId)).get();
    if (!event) throw new DomainError(API_ERRORS.notificationDeliveryNotFound);
    if (event.acknowledgedAt !== null) return;
    this.database.transaction(() => {
      this.database
        .update(notificationEvents)
        .set({ acknowledgedAt: this.clock(), acknowledgedBy: actor.username, escalateAt: null })
        .where(eq(notificationEvents.id, eventId))
        .run();
      this.database
        .update(notificationDeliveries)
        .set({ status: "cancelled", nextAttemptAt: null })
        .where(and(eq(notificationDeliveries.eventId, eventId), eq(notificationDeliveries.status, "queued")))
        .run();
      this.audit.recordUserAction(actor, AUDIT_ACTIONS.notificationAcknowledged, { kind: "notification", id: eventId });
    });
  }
  routeUnsent(actor: Actor, eventId: string) {
    const event = this.database.select().from(notificationEvents).where(eq(notificationEvents.id, eventId)).get();
    if (!event) throw new DomainError(API_ERRORS.notificationDeliveryNotFound);
    if (
      event.acknowledgedAt !== null ||
      this.database
        .select({ id: notificationDeliveries.id })
        .from(notificationDeliveries)
        .where(eq(notificationDeliveries.eventId, eventId))
        .get()
    )
      throw new DomainError(API_ERRORS.invalidRequest);
    const rule =
      this.rules().rules.find(
        (candidate) =>
          (candidate.hostId === null || candidate.hostId === event.hostId) &&
          candidate.priorities.includes(event.priority),
      ) ?? null;
    const channels = rule?.channels ?? NOTIFICATION_KINDS.filter((kind) => this.channels()[kind] !== null);
    if (!channels.length) throw new DomainError(API_ERRORS.invalidRequest);
    const now = this.clock();
    const due = notificationDueAt(rule, event.priority, now);
    const resolved = event.resolved;
    this.database.transaction(() => {
      this.database
        .update(notificationEvents)
        .set({
          ruleJson: rule === null ? null : JSON.stringify(rule),
          escalateAt:
            resolved || rule?.escalateAfterMinutes == null
              ? null
              : due + rule.escalateAfterMinutes * MILLISECONDS_PER_MINUTE,
          escalated: false,
        })
        .where(eq(notificationEvents.id, eventId))
        .run();
      for (const channel of channels) this.queue(eventId, channel, 0, due);
      this.audit.recordUserAction(
        actor,
        AUDIT_ACTIONS.notificationRetried,
        { kind: "notification", id: eventId },
        { unrouted: true },
      );
    });
  }

  retry(actor: Actor, deliveryId: string) {
    const delivery = this.database
      .select()
      .from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, deliveryId))
      .get();
    if (!delivery) throw new DomainError(API_ERRORS.notificationDeliveryNotFound);
    const event = this.database
      .select()
      .from(notificationEvents)
      .where(eq(notificationEvents.id, delivery.eventId))
      .get()!;
    if (event.acknowledgedAt !== null || delivery.status !== "failed") throw new DomainError(API_ERRORS.invalidRequest);
    const config = this.channels()[delivery.channel];
    const rule = event.ruleJson === null ? null : notificationRuleSchema.parse(JSON.parse(event.ruleJson));
    this.database
      .update(notificationDeliveries)
      .set({
        status: "queued",
        attempts: 0,
        failureCode: null,
        configFingerprint: config === null ? null : channelFingerprint(config),
        nextAttemptAt: notificationDueAt(rule, event.priority, this.clock()),
      })
      .where(eq(notificationDeliveries.id, deliveryId))
      .run();
    this.audit.recordUserAction(
      actor,
      AUDIT_ACTIONS.notificationRetried,
      { kind: "notification", id: deliveryId },
      { eventId: event.id },
    );
  }
  health(kind: NotificationKind): NotificationDeliveryView {
    const config = this.channels()[kind];
    if (config === null) return unknown();
    const condition = and(
      eq(notificationDeliveries.channel, kind),
      eq(notificationDeliveries.configFingerprint, channelFingerprint(config)),
    );
    const last = this.database
      .select()
      .from(notificationDeliveries)
      .where(and(condition, sql`${notificationDeliveries.lastAttemptAt} IS NOT NULL`))
      .orderBy(desc(notificationDeliveries.lastAttemptAt), desc(notificationDeliveries.id))
      .get();
    if (!last) return unknown();
    const success = this.database
      .select()
      .from(notificationDeliveries)
      .where(and(condition, eq(notificationDeliveries.status, "accepted")))
      .orderBy(desc(notificationDeliveries.acceptedAt))
      .get();
    return {
      status: last.status === "accepted" ? "healthy" : last.status === "sending" ? "unknown" : "degraded",
      lastAttemptAt: last.lastAttemptAt,
      lastSuccessAt: success?.acceptedAt ?? null,
      failureCode:
        last.status === "accepted" || last.status === "sending"
          ? null
          : last.failureCode === "refused" || last.failureCode === "timeout"
            ? last.failureCode
            : "unreachable",
    };
  }
}
