import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { API_ERRORS, type CreatedWidgetKeyView, type WidgetKeyView } from "../../shared/api.js";
import {
  AUDIT_ACTIONS,
  FORMER_USER_LABEL,
  JARVIS_KEY_SCOPE,
  TARGET_WIDGET_KEY,
  TOKEN_HINT_LENGTH,
  WIDGET_KEY_BYTES,
  WIDGET_KEY_PREFIX,
  WIDGET_LAST_USED_GRANULARITY_MILLISECONDS,
  type AnyKeyScope,
} from "../../shared/constants.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import { sha256Hex } from "../../shared/hash.js";
import type { DatabaseHandle } from "../database/connection.js";
import { users, widgetKeys } from "../database/schema.js";
import { DomainError } from "../domain-error.js";

/**
 * Keys for Homepage's custom API widget and for Prometheus. Each reads one of them, counts or metrics, and nothing
 * else; only their hash is stored, and an admin can revoke one at any time.
 */
export class WidgetKeysService {
  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly auditLog: AuditLog,
    private readonly clock: () => number = Date.now,
  ) {}

  create(actor: Actor, name: string, scope: AnyKeyScope): CreatedWidgetKeyView {
    const secret = `${WIDGET_KEY_PREFIX}${randomBytes(WIDGET_KEY_BYTES).toString("base64url")}`;
    const key = this.databaseHandle.database
      .insert(widgetKeys)
      .values({
        id: randomUUID(),
        name,
        keyHash: sha256Hex(secret),
        keyHint: secret.slice(-TOKEN_HINT_LENGTH),
        createdBy: actor.userId,
        createdAt: this.clock(),
        scope,
      })
      .returning()
      .get();
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.widgetKeyCreated,
      { kind: TARGET_WIDGET_KEY, id: key.id },
      { name, scope },
    );
    return { key: this.view(key.id), secret };
  }

  list(): WidgetKeyView[] {
    return this.databaseHandle.database
      .select({ id: widgetKeys.id })
      .from(widgetKeys)
      .where(and(isNull(widgetKeys.revokedAt), ne(widgetKeys.scope, JARVIS_KEY_SCOPE)))
      .orderBy(asc(widgetKeys.createdAt))
      .all()
      .map(({ id }) => this.view(id));
  }

  revoke(actor: Actor, keyId: string) {
    const revoked = this.databaseHandle.database
      .update(widgetKeys)
      .set({ revokedAt: this.clock() })
      .where(and(eq(widgetKeys.id, keyId), isNull(widgetKeys.revokedAt)))
      .run();
    if (revoked.changes === 0) {
      throw new DomainError(API_ERRORS.widgetKeyNotFound);
    }
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.widgetKeyRevoked, { kind: TARGET_WIDGET_KEY, id: keyId });
  }

  /** Whether this is a live key that reads what is asked; notes when it was last used, to the minute. */
  /** When this key was last used; null if never, or if it is gone. */
  lastUsed(keyId: string): number | null {
    const key = this.databaseHandle.database
      .select({ lastUsedAt: widgetKeys.lastUsedAt })
      .from(widgetKeys)
      .where(and(eq(widgetKeys.id, keyId), isNull(widgetKeys.revokedAt)))
      .get();
    return key?.lastUsedAt ?? null;
  }

  revokeIfLive(actor: Actor, keyId: string) {
    const live = this.databaseHandle.database
      .select({ id: widgetKeys.id })
      .from(widgetKeys)
      .where(and(eq(widgetKeys.id, keyId), isNull(widgetKeys.revokedAt)))
      .get();
    if (live !== undefined) this.revoke(actor, keyId);
  }

  authenticate(secret: string, scope: AnyKeyScope): boolean {
    const key = this.databaseHandle.database
      .select({ id: widgetKeys.id, lastUsedAt: widgetKeys.lastUsedAt })
      .from(widgetKeys)
      .where(and(eq(widgetKeys.keyHash, sha256Hex(secret)), eq(widgetKeys.scope, scope), isNull(widgetKeys.revokedAt)))
      .get();
    if (key === undefined) {
      return false;
    }
    const now = this.clock();
    // A note a minute or more off either way is written again: also after the clock went back.
    const noted = key.lastUsedAt !== null && Math.abs(now - key.lastUsedAt) < WIDGET_LAST_USED_GRANULARITY_MILLISECONDS;
    if (!noted) {
      this.databaseHandle.database.update(widgetKeys).set({ lastUsedAt: now }).where(eq(widgetKeys.id, key.id)).run();
    }
    return true;
  }

  private view(keyId: string): WidgetKeyView {
    const row = this.databaseHandle.database
      .select({ key: widgetKeys, username: users.username })
      .from(widgetKeys)
      .leftJoin(users, eq(users.id, widgetKeys.createdBy))
      .where(eq(widgetKeys.id, keyId))
      .get();
    if (row === undefined) {
      throw new DomainError(API_ERRORS.widgetKeyNotFound);
    }
    return {
      id: row.key.id,
      name: row.key.name,
      scope: row.key.scope,
      hint: row.key.keyHint,
      createdBy: row.username ?? FORMER_USER_LABEL,
      createdAt: row.key.createdAt,
      lastUsedAt: row.key.lastUsedAt,
    };
  }
}
