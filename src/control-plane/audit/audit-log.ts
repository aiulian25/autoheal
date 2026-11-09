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
import { log } from "../../shared/log.js";
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

// The details as written, without any field named like a secret at any depth, and the names of those left out.
function withoutSecretFields(details: Record<string, unknown>) {
  const leftOut: string[] = [];
  const json = JSON.stringify(details, (key, value: unknown) => {
    if (!SECRET_FIELD_PATTERN.test(key)) return value;
    leftOut.push(key);
    return undefined;
  });
  return { json, leftOut };
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
    // Tests refuse a field named like a secret, so it is caught before it ships. A running dashboard leaves it out and
    // says so instead: whatever was recorded is done by now, and must not fail over its record.
    private readonly options: { refuseSecretFields?: boolean } = {},
  ) {}

  record(entry: AuditEntry): string {
    const { json, leftOut } = withoutSecretFields(entry.details ?? {});
    if (leftOut.length > 0 && this.options.refuseSecretFields === true) {
      throw new Error(AUDIT_MESSAGES.secretField(leftOut[0]!));
    }
    if (leftOut.length > 0) log(AUDIT_MESSAGES.secretFieldsLeftOut(entry.action, leftOut.join(", ")));
    const details = JSON.parse(json) as Record<string, unknown>;
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
      .values({ ...event, detailsJson: json })
      .run();
    // A line for the host's logs says only what was kept.
    const line = `${JSON.stringify({ type: AUDIT_STDOUT_TYPE, ...event, details })}\n`;
    this.databaseHandle.afterCommit(() => this.writeLine(line));
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
