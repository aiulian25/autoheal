import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, or } from "drizzle-orm";
import type { AuditEventView } from "../../shared/api.js";
import {
  ACTOR_USER,
  AUDIT_LIST_LIMIT,
  AUDIT_MESSAGES,
  AUDIT_STDOUT_TYPE,
  SECRET_FIELD_PATTERN,
  type ActorKind,
  type AuditAction,
} from "../../shared/constants.js";
import type { DatabaseHandle } from "../database/connection.js";
import { auditEvents } from "../database/schema.js";

export interface AuditEntry {
  actorKind: ActorKind;
  actorId?: string | null;
  actorLabel: string;
  action: AuditAction;
  targetKind?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  ip?: string;
  requestId?: string;
}

/** A signed-in person acting through the dashboard. */
export interface Actor {
  userId: string;
  username: string;
  ip: string;
  requestId: string;
}

export interface AuditTarget {
  kind: string;
  id: string;
}

function assertNoSecretFields(details: unknown) {
  if (typeof details !== "object" || details === null) {
    return;
  }
  for (const [key, value] of Object.entries(details)) {
    if (SECRET_FIELD_PATTERN.test(key)) {
      throw new Error(AUDIT_MESSAGES.secretField(key));
    }
    assertNoSecretFields(value);
  }
}

export interface AuditCursor {
  occurredAt: number;
  id: string;
}

/**
 * Who did what, when. Every event goes to the append-only table and to stdout, so restoring
 * an older database cannot erase the record of the restore, or of anything before it.
 */
export class AuditLog {
  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly writeLine: (line: string) => void = (line) => process.stdout.write(line),
    private readonly clock: () => number = Date.now,
  ) {}

  record(entry: AuditEntry): string {
    const details = entry.details ?? {};
    assertNoSecretFields(details);
    const event = {
      id: randomUUID(),
      occurredAt: this.clock(),
      actorKind: entry.actorKind,
      actorId: entry.actorId ?? null,
      actorLabel: entry.actorLabel,
      action: entry.action,
      targetKind: entry.targetKind ?? null,
      targetId: entry.targetId ?? null,
      ip: entry.ip ?? null,
      requestId: entry.requestId ?? null,
    };
    this.databaseHandle.database
      .insert(auditEvents)
      .values({ ...event, detailsJson: JSON.stringify(details) })
      .run();
    this.writeLine(`${JSON.stringify({ type: AUDIT_STDOUT_TYPE, ...event, details })}\n`);
    return event.id;
  }

  /** Newest first; `before`, the last event seen, pages back through older events. */
  recent(limit: number = AUDIT_LIST_LIMIT, before?: AuditCursor): AuditEventView[] {
    // One request often records several events in the same millisecond: the id breaks the tie.
    const older =
      before === undefined
        ? undefined
        : or(
            lt(auditEvents.occurredAt, before.occurredAt),
            and(eq(auditEvents.occurredAt, before.occurredAt), lt(auditEvents.id, before.id)),
          );
    return this.databaseHandle.database
      .select()
      .from(auditEvents)
      .where(older)
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
      .limit(Math.min(limit, AUDIT_LIST_LIMIT))
      .all()
      .map(({ detailsJson, requestId: _requestId, actorId: _actorId, ...event }) => ({
        ...event,
        details: JSON.parse(detailsJson) as Record<string, unknown>,
      }));
  }

  recordUserAction(actor: Actor, action: AuditAction, target: AuditTarget, details: Record<string, unknown> = {}) {
    return this.record({
      actorKind: ACTOR_USER,
      actorId: actor.userId,
      actorLabel: actor.username,
      action,
      targetKind: target.kind,
      targetId: target.id,
      details,
      ip: actor.ip,
      requestId: actor.requestId,
    });
  }
}
