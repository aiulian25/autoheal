import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELIVERY_ATTEMPT_LIMIT,
  DELIVERY_EVENT_LIMIT,
  DELIVERY_RETENTION_MILLISECONDS,
  notificationDueAt,
  type DeliveryContext,
  type DeliveryMessage,
  type NotificationRule,
} from "../../shared/notification-deliveries.js";
import { AuditLog } from "../audit/audit-log.js";
import { DatabaseHandle } from "../database/connection.js";
import { DeliveryService } from "./delivery-service.js";
import { notificationDeliveries, notificationEvents } from "./delivery-schema.js";
import type { NotificationChannels } from "./notifier.js";
const NOW = Date.UTC(2026, 9, 27, 22, 30);
const channelsOf = (): NotificationChannels => ({
  gotify: { url: "https://gotify.test", token: "private-gotify-token" },
  ntfy: { url: "https://ntfy.test", topic: "private-topic", token: "private-ntfy-token" },
  webhook: null,
});
const context = (key = "logical-event"): DeliveryContext => ({
  key,
  kind: "incident_handled",
  resourceKind: "system",
  resourceId: null,
});
const message = (priority: DeliveryMessage["priority"] = "high", title = "Captured alert"): DeliveryMessage => ({
  title,
  body: "password=synthetic-provider-secret",
  priority,
  link: "https://autoheal.test",
  action: "Open incident",
  tag: "warning",
});
const actor = { userId: "admin", username: "admin", ip: "127.0.0.1", requestId: "r1" };
const ruleOf = (overrides: Partial<NotificationRule> = {}): NotificationRule => ({
  id: randomUUID(),
  hostId: null,
  priorities: ["urgent", "high", "medium", "low"],
  channels: ["gotify"],
  quietStartMinute: null,
  quietEndMinute: null,
  urgentOverride: true,
  escalateAfterMinutes: null,
  escalationChannels: [],
  ...overrides,
});

describe("durable notification delivery", () => {
  let directory: string, handle: DatabaseHandle, now: number, channels: NotificationChannels, service: DeliveryService;
  let audit: string[], sent: { channel: string; message: DeliveryMessage; persisted: boolean }[];
  const makeService = () =>
    new DeliveryService(
      handle,
      new AuditLog(
        handle,
        (line) => audit.push(line),
        () => now,
      ),
      () => channels,
      () => now,
    );
  const sender = (failure: "unreachable" | null) =>
    service.useSender(async (channel, given) => {
      const rows = handle.database.select().from(notificationDeliveries).all();
      sent.push({
        channel,
        message: given,
        persisted: rows.some((row) => row.channel === channel && row.status === "sending" && row.attempts > 0),
      });
      return failure;
    });
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "autoheal-delivery-"));
    handle = new DatabaseHandle(join(directory, "state.sqlite"));
    now = NOW;
    channels = channelsOf();
    audit = [];
    sent = [];
    service = makeService();
  });
  afterEach(() => {
    handle.close();
    rmSync(directory, { recursive: true, force: true });
  });
  it("reads the inbox in the same few statements however many alerts it holds, each with its own deliveries", () => {
    service.saveRules(actor, { rules: [ruleOf({ channels: ["ntfy", "gotify"] })] });
    const listed = () => {
      const prepared = vi.spyOn(handle.sqlite, "prepare");
      const inbox = service.list();
      const statements = prepared.mock.calls.length;
      prepared.mockRestore();
      return { inbox, statements };
    };
    service.enqueue(context("first"), message());
    const one = listed();
    for (let index = 1; index < 10; index++) service.enqueue(context(`alert-${index}`), message());
    const ten = listed();
    expect(ten.inbox.events).toHaveLength(10);
    for (const event of ten.inbox.events) {
      expect(event.deliveries.map((row) => row.channel)).toEqual(["gotify", "ntfy"]);
      expect(new Set(event.deliveries.map((row) => row.id)).size).toBe(2);
    }
    const ids = ten.inbox.events.flatMap((event) => event.deliveries.map((row) => row.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ten.statements).toBe(one.statements);
  });

  it("journals before external I/O and recovers one logical alert with bounded retry state across database reconstruction", async () => {
    sender("unreachable");
    const id = service.enqueue(context(), message());
    expect(service.enqueue(context(), message())).toBe(id);
    expect(sent).toHaveLength(0);
    await service.tick();
    expect(sent).toHaveLength(2);
    expect(sent.every(({ persisted }) => persisted)).toBe(true);
    expect(service.list().events[0]?.deliveries.every((row) => row.status === "queued" && row.attempts === 1)).toBe(
      true,
    );
    const dbText =
      JSON.stringify(handle.database.select().from(notificationEvents).all()) +
      JSON.stringify(handle.database.select().from(notificationDeliveries).all());
    expect(dbText).not.toContain("private-gotify-token");
    expect(dbText).not.toContain("private-ntfy-token");
    expect(dbText).not.toContain("synthetic-provider-secret");
    handle.close();
    handle = new DatabaseHandle(join(directory, "state.sqlite"));
    service = makeService();
    sender(null);
    now += 60_000;
    expect(service.enqueue(context(), message())).toBe(id);
    await service.tick();
    expect(service.list().events).toHaveLength(1);
    expect(service.list().events[0]?.deliveries.every((row) => row.status === "accepted" && row.attempts === 2)).toBe(
      true,
    );
    expect(service.health("gotify")).toMatchObject({ status: "healthy", lastSuccessAt: now });
    expect(JSON.stringify(service.list())).not.toContain("Captured alert");
    expect(JSON.stringify(service.list())).not.toContain("private-topic");
  });
  it("never grants extra attempts to interrupted final attempts or runner/process reconstruction", async () => {
    channels.ntfy = null;
    sender("unreachable");
    service.enqueue(context(), message());
    for (let attempt = 0; attempt < DELIVERY_ATTEMPT_LIMIT; attempt++) {
      await service.tick();
      now += 60 * 60_000;
    }
    expect(sent).toHaveLength(DELIVERY_ATTEMPT_LIMIT);
    const row = service.list().events[0]!.deliveries[0]!;
    expect(row).toMatchObject({ status: "failed", attempts: DELIVERY_ATTEMPT_LIMIT });
    handle.database
      .update(notificationDeliveries)
      .set({ status: "sending", nextAttemptAt: now })
      .where(eq(notificationDeliveries.id, row.id))
      .run();
    service = makeService();
    sender(null);
    await service.tick();
    expect(sent).toHaveLength(DELIVERY_ATTEMPT_LIMIT);
    expect(service.list().events[0]?.deliveries[0]?.status).toBe("failed");
  });
  it("enforces UTC quiet hours, urgent override, one escalation and acknowledgement cancellation", async () => {
    sender(null);
    const quiet = ruleOf({
      quietStartMinute: 22 * 60,
      quietEndMinute: 7 * 60,
      urgentOverride: true,
      escalateAfterMinutes: 15,
      escalationChannels: ["ntfy"],
    });
    service.saveRules(actor, { rules: [quiet] });
    const high = service.enqueue(context("high"), message("high", "Quiet high"));
    expect(notificationDueAt(quiet, "high", now)).toBe(Date.UTC(2026, 9, 28, 7));
    await service.tick();
    expect(sent).toHaveLength(0);
    service.enqueue(context("urgent"), message("urgent", "Urgent override"));
    await service.tick();
    expect(sent.map(({ message }) => message.title)).toEqual(["Urgent override"]);
    now = Date.UTC(2026, 9, 28, 7);
    await service.tick();
    expect(sent.some(({ message }) => message.title === "Quiet high")).toBe(true);
    service.acknowledge(actor, high);
    now += 20 * 60_000;
    await service.tick();
    expect(service.list().events.find((event) => event.id === high)?.deliveries).toHaveLength(1);
    const unacknowledged = service.enqueue(context("escalate"), message("high", "Needs acknowledgement"));
    await service.tick();
    now += 15 * 60_000;
    await service.tick();
    await service.tick();
    expect(
      service
        .list()
        .events.find((event) => event.id === unacknowledged)
        ?.deliveries.map((row) => row.stage)
        .sort(),
    ).toEqual([0, 1]);
    expect(audit.some((line) => line.includes("notification.acknowledged"))).toBe(true);
    const disabledOverride = { ...quiet, urgentOverride: false };
    expect(notificationDueAt(disabledOverride, "urgent", NOW)).toBe(Date.UTC(2026, 9, 28, 7));
  });
  it("defers retry backoff that crosses into quiet hours without spending an attempt", async () => {
    channels.ntfy = null;
    now = Date.UTC(2026, 9, 27, 21, 59);
    sender("unreachable");
    service.saveRules(actor, { rules: [ruleOf({ quietStartMinute: 22 * 60, quietEndMinute: 7 * 60 })] });
    service.enqueue(context(), message());
    await service.tick();
    expect(sent).toHaveLength(1);
    expect(service.list().events[0]?.deliveries[0]?.nextAttemptAt).toBe(Date.UTC(2026, 9, 28, 7));
    now += 60_000;
    await service.tick();
    expect(sent).toHaveLength(1);
    expect(service.list().events[0]?.deliveries[0]?.attempts).toBe(1);
  });
  it("does not send queued payloads to changed credentials/endpoints until an explicit current-config retry", async () => {
    channels.ntfy = null;
    sender(null);
    service.enqueue(context(), message());
    channels.gotify = { url: "https://changed.test", token: "replacement-private-token" };
    await service.tick();
    expect(sent).toHaveLength(0);
    const row = service.list().events[0]!.deliveries[0]!;
    expect(row).toMatchObject({ status: "failed", failureCode: "configuration_changed" });
    service.retry(actor, row.id);
    await service.tick();
    expect(sent).toHaveLength(1);
    expect(service.list().events[0]!.deliveries[0]!.status).toBe("accepted");
    expect(JSON.stringify(service.list())).not.toContain("replacement-private-token");
    expect(audit.join("")).not.toContain("replacement-private-token");
  });
  it("bounds reconnect sending, retains pending intents at capacity and exposes overflow", async () => {
    channels.ntfy = null;
    sender(null);
    const payload = JSON.stringify(message());
    const events = Array.from({ length: DELIVERY_EVENT_LIMIT }, (_, index) => ({
      id: `event-${index}`,
      dedupeKey: `key-${index}`,
      kind: "incident_handled" as const,
      resourceKind: "system" as const,
      priority: "high" as const,
      messageJson: payload,
      createdAt: now,
    }));
    handle.database.insert(notificationEvents).values(events).run();
    const { channelFingerprint } = await import("./delivery-service.js");
    handle.database
      .insert(notificationDeliveries)
      .values(
        events.map((event) => ({
          id: `delivery-${event.id}`,
          eventId: event.id,
          channel: "gotify" as const,
          status: "queued" as const,
          configFingerprint: channelFingerprint(channels.gotify!),
          nextAttemptAt: now,
        })),
      )
      .run();
    expect(() => service.enqueue(context("overflow"), message())).toThrow("notification_queue_full");
    expect(service.rules()).toMatchObject({ overflowCount: 1, lastOverflowAt: now });
    expect(service.list().pendingCount).toBe(DELIVERY_EVENT_LIMIT);
    await service.tick();
    expect(sent).toHaveLength(4);
    service.enqueue(context("new-room"), message());
    expect(handle.database.select().from(notificationEvents).all()).toHaveLength(DELIVERY_EVENT_LIMIT);
    now += DELIVERY_RETENTION_MILLISECONDS + 1;
    await service.tick();
    expect(service.list().events).toHaveLength(0);
  });
  it("keeps an unrouted alert recoverable through explicit current-routing approval", async () => {
    channels = { gotify: null, ntfy: null, webhook: null };
    sender(null);
    const id = service.enqueue(context(), message());
    expect(service.list().events[0]?.deliveries).toHaveLength(0);
    expect(() => service.routeUnsent(actor, id)).toThrow("invalid_request");
    channels = { gotify: channelsOf().gotify, ntfy: null, webhook: null };
    service.routeUnsent(actor, id);
    expect(() => service.routeUnsent(actor, id)).toThrow("invalid_request");
    await service.tick();
    expect(service.list().events).toHaveLength(1);
    expect(service.list().events[0]?.id).toBe(id);
    expect(service.list().events[0]?.deliveries[0]?.status).toBe("accepted");
  });
  it("cancels obsolete queued alerts and escalations when captured resolution arrives at the same timestamp", async () => {
    sender(null);
    service.saveRules(actor, { rules: [ruleOf({ escalateAfterMinutes: 5, escalationChannels: ["ntfy"] })] });
    const taskId = randomUUID();
    const opened = service.enqueue(
      { key: "opened", kind: "task_opened", resourceKind: "task", resourceId: taskId },
      message(),
    );
    const resolved = service.enqueue(
      { key: "resolved", kind: "task_resolved", resourceKind: "task", resourceId: taskId },
      message("medium", "Resolved"),
    );
    await service.tick();
    now += 10 * 60_000;
    await service.tick();
    expect(service.list().events.find((event) => event.id === opened)?.deliveries[0]?.status).toBe("cancelled");
    expect(service.list().events.find((event) => event.id === resolved)?.deliveries).toHaveLength(1);
    expect(sent.map(({ message }) => message.title)).toEqual(["Resolved"]);
  });
});
