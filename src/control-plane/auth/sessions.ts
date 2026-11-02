import { randomBytes } from "node:crypto";
import { sha256Hex } from "../../shared/hash.js";
import { and, desc, eq, gt, ne, sql } from "drizzle-orm";
import {
  ACCESS_SIGNED_IN,
  type Access,
  CSRF_TOKEN_BYTES,
  SESSION_ABSOLUTE_MILLISECONDS,
  SESSION_ID_LENGTH,
  SESSION_IDLE_MILLISECONDS,
  SESSION_TOKEN_BYTES,
  SESSION_TOUCH_INTERVAL_MILLISECONDS,
  USER_STATUS_ACTIVE,
  type Role,
} from "../../shared/constants.js";
import type { DatabaseHandle } from "../database/connection.js";
import { accessProblem } from "./access.js";
import { sessions, users } from "../database/schema.js";

export interface SessionUser {
  id: string;
  username: string;
  role: Role;
  mustChangePassword: boolean;
  totpEnabled: boolean;
}

export interface ResolvedSession {
  tokenHash: string;
  csrfToken: string;
  secondFactorDone: boolean;
  user: SessionUser;
}

export interface ListedSession {
  id: string;
  tokenHash: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
  lastSeenAt: number;
}

// The start of a session's token hash: enough to tell one person's sessions apart and end one.
const sessionIdOf = (tokenHash: string) => tokenHash.slice(0, SESSION_ID_LENGTH);
const newSessionToken = () => randomBytes(SESSION_TOKEN_BYTES).toString("base64url");

export interface ClientContext {
  ip: string;
  userAgent: string | null;
}

/** Server-side sessions: the browser holds a random token, the database only its hash. */
export class SessionStore {
  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly clock: () => number = Date.now,
  ) {}

  /** `secondFactorDone`: a passkey proves both steps at once; a password still needs its code. */
  create(userId: string, client: ClientContext, secondFactorDone = false): { token: string; csrfToken: string } {
    const token = newSessionToken();
    const csrfToken = randomBytes(CSRF_TOKEN_BYTES).toString("base64url");
    const now = this.clock();
    this.databaseHandle.database
      .insert(sessions)
      .values({
        tokenHash: sha256Hex(token),
        userId,
        csrfToken,
        secondFactorDone,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + SESSION_ABSOLUTE_MILLISECONDS,
        ip: client.ip,
        userAgent: client.userAgent,
      })
      .run();
    return { token, csrfToken };
  }

  /**
   * The second step is done: the session goes on under a new token, so the one from before that step opens nothing.
   * Its CSRF token stays, so the dashboard's open tabs go on. Null when the session ended meanwhile.
   */
  completeSecondFactor(tokenHash: string): string | null {
    return this.replaceToken(tokenHash, { secondFactorDone: true, secondFactorFailures: 0 });
  }

  /** Its password changed: the session goes on under a new token, as after the second step. Null when it ended. */
  renew(tokenHash: string): string | null {
    return this.replaceToken(tokenHash, {});
  }

  // The one way a session gets a new token: the old one opens nothing from then on, and the CSRF token stays.
  private replaceToken(tokenHash: string, fields: Partial<typeof sessions.$inferInsert>): string | null {
    const token = newSessionToken();
    const { changes } = this.databaseHandle.database
      .update(sessions)
      .set({ ...fields, tokenHash: sha256Hex(token) })
      .where(eq(sessions.tokenHash, tokenHash))
      .run();
    return changes > 0 ? token : null;
  }

  /** The live session for this token, or null when it is unknown, expired or its user deactivated. */
  resolve(token: string): ResolvedSession | null {
    const database = this.databaseHandle.database;
    const tokenHash = sha256Hex(token);
    const row = database
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, tokenHash))
      .get();
    if (row === undefined) {
      return null;
    }
    const now = this.clock();
    const expired = now >= row.session.expiresAt || now - row.session.lastSeenAt >= SESSION_IDLE_MILLISECONDS;
    if (expired || row.user.status !== USER_STATUS_ACTIVE) {
      this.delete(tokenHash);
      return null;
    }
    if (now - row.session.lastSeenAt >= SESSION_TOUCH_INTERVAL_MILLISECONDS) {
      database.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.tokenHash, tokenHash)).run();
    }
    return {
      tokenHash,
      csrfToken: row.session.csrfToken,
      secondFactorDone: row.session.secondFactorDone,
      user: {
        id: row.user.id,
        username: row.user.username,
        role: row.user.role,
        mustChangePassword: row.user.mustChangePassword,
        totpEnabled: row.user.totpEnabled,
      },
    };
  }

  /** Whether a session still works, without counting the question as its use: an open stream must not keep it alive. */
  isLive(tokenHash: string, access: Access = ACCESS_SIGNED_IN): boolean {
    const row = this.databaseHandle.database
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, tokenHash))
      .get();
    const now = this.clock();
    return (
      row !== undefined &&
      now < row.session.expiresAt &&
      now - row.session.lastSeenAt < SESSION_IDLE_MILLISECONDS &&
      row.user.status === USER_STATUS_ACTIVE &&
      accessProblem(access, {
        tokenHash,
        csrfToken: row.session.csrfToken,
        secondFactorDone: row.session.secondFactorDone,
        user: row.user,
      }) === null
    );
  }

  /** A person's sessions that still work, most recently used first. */
  listForUser(userId: string): ListedSession[] {
    const now = this.clock();
    return this.databaseHandle.database
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          gt(sessions.expiresAt, now),
          gt(sessions.lastSeenAt, now - SESSION_IDLE_MILLISECONDS),
        ),
      )
      .orderBy(desc(sessions.lastSeenAt))
      .all()
      .map((session) => ({
        id: sessionIdOf(session.tokenHash),
        tokenHash: session.tokenHash,
        ip: session.ip,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
      }));
  }

  /** Ends one of a person's sessions by the id the account page shows; false when there is none. */
  deleteById(userId: string, sessionId: string): boolean {
    const result = this.databaseHandle.database
      .delete(sessions)
      .where(
        and(eq(sessions.userId, userId), sql`substr(${sessions.tokenHash}, 1, ${SESSION_ID_LENGTH}) = ${sessionId}`),
      )
      .run();
    return result.changes > 0;
  }

  delete(tokenHash: string) {
    this.databaseHandle.database.delete(sessions).where(eq(sessions.tokenHash, tokenHash)).run();
  }

  deleteForUser(userId: string, keepTokenHash?: string) {
    const keep = keepTokenHash === undefined ? undefined : ne(sessions.tokenHash, keepTokenHash);
    this.databaseHandle.database
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), keep))
      .run();
  }
}
