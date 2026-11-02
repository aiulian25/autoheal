import { and, count, eq, isNull, ne } from "drizzle-orm";
import { API_ERRORS, type OwnAccountView } from "../../shared/api.js";
import { AUDIT_ACTIONS, TARGET_USER, type AuditAction } from "../../shared/constants.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { RequestContext } from "../auth/auth-service.js";
import { verifyPassword } from "../auth/password-hashing.js";
import type { ResolvedSession, SessionStore } from "../auth/sessions.js";
import { totpAccountName } from "../auth/totp.js";
import type { DatabaseHandle } from "../database/connection.js";
import { recoveryCodes, users } from "../database/schema.js";
import { DomainError } from "../domain-error.js";

/** The signed-in person's own account: their name, and where they are signed in. */
export class AccountService {
  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly auditLog: AuditLog,
    private readonly sessions: SessionStore,
    // The dashboard's host, in the authenticator entry's name.
    private readonly accountHost: string,
  ) {}

  view(session: ResolvedSession): OwnAccountView {
    const database = this.databaseHandle.database;
    const user = this.userOf(session);
    const unused = database
      .select({ left: count() })
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, user.id), isNull(recoveryCodes.usedAt)))
      .get();
    return {
      username: user.username,
      role: user.role,
      authenticatorName: totpAccountName(user.username, this.accountHost),
      recoveryCodesLeft: unused?.left ?? 0,
      sessions: this.sessions
        .listForUser(user.id)
        .map(({ tokenHash, ...listed }) => ({ ...listed, current: tokenHash === session.tokenHash })),
    };
  }

  /** A new name, proven with the password: a borrowed session must not lock its owner out. */
  async rename(
    session: ResolvedSession,
    request: { username: string; currentPassword: string },
    context: RequestContext,
  ): Promise<OwnAccountView> {
    const user = this.userOf(session);
    if (!(await verifyPassword(user.passwordHash, request.currentPassword))) {
      throw new DomainError(API_ERRORS.wrongPassword);
    }
    this.databaseHandle.database.transaction((transaction) => {
      // The column ignores case, so "Alex" is taken when "alex" is someone else.
      const taken = transaction
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.username, request.username), ne(users.id, user.id)))
        .get();
      if (taken !== undefined) {
        throw new DomainError(API_ERRORS.usernameTaken);
      }
      transaction.update(users).set({ username: request.username }).where(eq(users.id, user.id)).run();
    });
    this.audit(session, AUDIT_ACTIONS.accountRenamed, context, { from: user.username, to: request.username });
    return this.view(session);
  }

  endSession(session: ResolvedSession, sessionId: string, context: RequestContext) {
    if (!this.sessions.deleteById(session.user.id, sessionId)) {
      throw new DomainError(API_ERRORS.sessionNotFound);
    }
    this.audit(session, AUDIT_ACTIONS.sessionEnded, context);
  }

  endOtherSessions(session: ResolvedSession, context: RequestContext) {
    this.sessions.deleteForUser(session.user.id, session.tokenHash);
    this.audit(session, AUDIT_ACTIONS.otherSessionsEnded, context);
  }

  private userOf(session: ResolvedSession) {
    return this.databaseHandle.database.select().from(users).where(eq(users.id, session.user.id)).get()!;
  }

  private audit(session: ResolvedSession, action: AuditAction, context: RequestContext, details: object = {}) {
    const actor = { userId: session.user.id, username: session.user.username, ...context };
    this.auditLog.recordUserAction(actor, action, { kind: TARGET_USER, id: session.user.id }, { ...details });
  }
}
