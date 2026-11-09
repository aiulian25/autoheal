import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { SessionView, UserView } from "../../shared/api.js";
import { sha256Hex } from "../../shared/hash.js";
import {
  ACTOR_USER,
  AUDIT_ACTIONS,
  AUDIT_LABEL_MAXIMUM_LENGTH,
  LOGIN_FAILURE_REASONS,
  TARGET_USER,
  UNKNOWN_USER_PASSWORD_BYTES,
  USER_STATUS_ACTIVE,
} from "../../shared/constants.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { users } from "../database/schema.js";
import type { LoginThrottle } from "./login-throttle.js";
import { hashPassword, verifyPassword } from "./password-hashing.js";
import { passwordProblems } from "./password-policy.js";
import type { ClientContext, ResolvedSession, SessionStore, SessionUser } from "./sessions.js";

export interface RequestContext extends ClientContext {
  requestId: string;
}

export type LoginResult =
  | { kind: "throttled"; retryAfterSeconds: number }
  | { kind: "rejected" }
  | { kind: "signed_in"; token: string; session: SessionView };

export type PasswordChangeResult =
  | { kind: "changed"; token: string }
  | { kind: "session_ended" }
  | { kind: "throttled"; retryAfterSeconds: number }
  | { kind: "wrong_password" }
  | { kind: "same_password" }
  | { kind: "policy"; problems: string[] };

export const userView = (user: SessionUser): UserView => ({
  id: user.id,
  username: user.username,
  role: user.role,
  mustChangePassword: user.mustChangePassword,
  totpEnabled: user.totpEnabled,
});

export const sessionView = (session: ResolvedSession): SessionView => ({
  user: userView(session.user),
  csrfToken: session.csrfToken,
  secondFactorDone: session.secondFactorDone,
});

export class AuthService {
  // Checked when the username is unknown, so a miss takes as long as a wrong password.
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly auditLog: AuditLog,
    private readonly sessions: SessionStore,
    private readonly throttle: LoginThrottle,
    private readonly clock: () => number = Date.now,
  ) {}

  async login(credentials: { username: string; password: string }, context: RequestContext): Promise<LoginResult> {
    const { username, password } = credentials;
    // A throttled request is refused before anything is checked, so it is not audited as an attempt.
    const retryAfterSeconds = this.throttle.retryAfterSeconds(username, context.ip);
    if (retryAfterSeconds > 0) {
      return { kind: "throttled", retryAfterSeconds };
    }
    const user = this.databaseHandle.database.select().from(users).where(eq(users.username, username)).get();
    const passwordMatches = await verifyPassword(user?.passwordHash ?? (await this.unknownUserHash()), password);
    const isActive = user?.status === USER_STATUS_ACTIVE;
    const passed = passwordMatches && isActive;
    // With TOTP enrolled the sign-in is only a success once the code is right: a correct password
    // alone must not reset the failure count, or the code could be guessed five times per login.
    if (!passed || !user.totpEnabled) {
      this.throttle.record(username, context.ip, passed);
    }
    if (user === undefined || !passwordMatches || !isActive) {
      const reason =
        user !== undefined && passwordMatches
          ? LOGIN_FAILURE_REASONS.deactivated
          : LOGIN_FAILURE_REASONS.wrongCredentials;
      this.recordFailedLogin(username, user?.id ?? null, reason, context);
      return { kind: "rejected" };
    }
    this.databaseHandle.database.update(users).set({ lastLoginAt: this.clock() }).where(eq(users.id, user.id)).run();
    const { token, csrfToken } = this.sessions.create(user.id, context);
    this.auditLog.record({
      actorKind: ACTOR_USER,
      actorId: user.id,
      actorLabel: user.username,
      action: AUDIT_ACTIONS.loginSucceeded,
      ip: context.ip,
      requestId: context.requestId,
    });
    return { kind: "signed_in", token, session: { user: userView(user), csrfToken, secondFactorDone: false } };
  }

  logout(session: ResolvedSession, context: RequestContext) {
    this.sessions.delete(session.tokenHash);
    this.auditLog.record({
      actorKind: ACTOR_USER,
      actorId: session.user.id,
      actorLabel: session.user.username,
      action: AUDIT_ACTIONS.logout,
      ip: context.ip,
      requestId: context.requestId,
    });
  }

  async changePassword(
    session: ResolvedSession,
    change: { currentPassword: string; newPassword: string },
    context: RequestContext,
  ): Promise<PasswordChangeResult> {
    const database = this.databaseHandle.database;
    const user = database.select().from(users).where(eq(users.id, session.user.id)).get();
    if (user === undefined) {
      return { kind: "wrong_password" };
    }
    // Wrong guesses wait as at sign-in, and count with it: a borrowed session must not guess the password fast either.
    const retryAfterSeconds = this.throttle.retryAfterSeconds(user.username, context.ip);
    if (retryAfterSeconds > 0) {
      return { kind: "throttled", retryAfterSeconds };
    }
    const passwordMatches = await verifyPassword(user.passwordHash, change.currentPassword);
    this.throttle.record(user.username, context.ip, passwordMatches);
    if (!passwordMatches) {
      return { kind: "wrong_password" };
    }
    if (change.newPassword === change.currentPassword) {
      return { kind: "same_password" };
    }
    const problems = passwordProblems(change.newPassword, user.username);
    if (problems.length > 0) {
      return { kind: "policy", problems };
    }
    const passwordHash = await hashPassword(change.newPassword);
    // The new password, this session's new token and the end of the account's other sessions go together, or not at
    // all: the store writes inside this transaction. The token from before the change opens nothing any more.
    const token = database.transaction((transaction) => {
      const renewed = this.sessions.renew(session.tokenHash);
      if (renewed === null) {
        return null;
      }
      transaction
        .update(users)
        .set({ passwordHash, mustChangePassword: false, passwordChangedAt: this.clock() })
        .where(eq(users.id, user.id))
        .run();
      this.sessions.deleteForUser(user.id, sha256Hex(renewed));
      return renewed;
    });
    if (token === null) {
      return { kind: "session_ended" };
    }
    this.auditLog.record({
      actorKind: ACTOR_USER,
      actorId: user.id,
      actorLabel: user.username,
      action: AUDIT_ACTIONS.passwordChanged,
      targetKind: TARGET_USER,
      targetId: user.id,
      ip: context.ip,
      requestId: context.requestId,
    });
    return { kind: "changed", token };
  }

  private unknownUserHash(): Promise<string> {
    this.dummyHash ??= hashPassword(randomBytes(UNKNOWN_USER_PASSWORD_BYTES).toString("base64url"));
    return this.dummyHash;
  }

  private recordFailedLogin(username: string, userId: string | null, reason: string, context: RequestContext) {
    this.auditLog.record({
      actorKind: ACTOR_USER,
      actorId: userId,
      actorLabel: username.slice(0, AUDIT_LABEL_MAXIMUM_LENGTH),
      action: AUDIT_ACTIONS.loginFailed,
      details: { reason },
      ip: context.ip,
      requestId: context.requestId,
    });
  }
}
