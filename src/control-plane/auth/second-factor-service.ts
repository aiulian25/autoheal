import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { API_ERRORS, type RecoveryCodesView, type TotpSetupView } from "../../shared/api.js";
import {
  AUDIT_ACTIONS,
  SECOND_FACTOR_MAXIMUM_FAILURES,
  TARGET_USER,
  TOTP_ALLOWED_DRIFT_STEPS,
  TOTP_CODE_PATTERN,
  TOTP_FAILURE,
  type AuditAction,
} from "../../shared/constants.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { recoveryCodes, sessions, users } from "../database/schema.js";
import type { SecretBox } from "../database/secret-box.js";
import { DomainError } from "../domain-error.js";
import type { RequestContext } from "./auth-service.js";
import type { LoginThrottle } from "./login-throttle.js";
import { generateRecoveryCodes, hashRecoveryCode } from "./recovery-codes.js";
import type { ResolvedSession, SessionStore } from "./sessions.js";
import {
  explainTotpFailure,
  generateTotpSecret,
  matchTotp,
  normalizeTotpCode,
  otpauthUri,
  totpAccountName,
  type TotpFailure,
} from "./totp.js";

export type SetupResult = { kind: "started"; setup: TotpSetupView } | { kind: "already_enabled" };

// A recovery code that matched nothing: there is no clock to blame.
const NOT_A_MATCH: TotpFailure = { reason: TOTP_FAILURE.noMatch };

// `token`: the session's new one, which the answer sets; the token from before the step no longer works.
export type ConfirmResult =
  | { kind: "enabled"; codes: RecoveryCodesView; token: string }
  | { kind: "not_started" }
  | { kind: "already_enabled" }
  | { kind: "wrong_code"; failure: TotpFailure }
  | { kind: "session_ended" };

export type VerifyResult =
  | { kind: "verified"; token: string }
  | { kind: "wrong_code"; failure: TotpFailure }
  | { kind: "session_ended" }
  | { kind: "throttled"; retryAfterSeconds: number };

// A code that did not pass: wrong, or asked for too often.
export type CodeRefusal =
  { kind: "wrong_code"; failure: TotpFailure } | { kind: "throttled"; retryAfterSeconds: number };
type CodeCheck = { kind: "verified"; usedRecoveryCode: boolean } | CodeRefusal;

export type MoveResult = { kind: "started"; setup: TotpSetupView } | CodeRefusal;
export type MoveConfirmResult =
  { kind: "moved" } | { kind: "not_started" } | { kind: "wrong_code"; failure: TotpFailure };
export type RenewResult = { kind: "renewed"; codes: RecoveryCodesView } | CodeRefusal;

type UserRow = typeof users.$inferSelect;

function replaceRecoveryCodes(database: DatabaseHandle["database"], userId: string, codes: readonly string[]) {
  database.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
  database
    .insert(recoveryCodes)
    .values(codes.map((recoveryCode) => ({ id: randomUUID(), userId, codeHash: hashRecoveryCode(recoveryCode) })))
    .run();
}

/**
 * TOTP enrolment and the second step of signing in, with one-use recovery codes. Wrong codes
 * count as login failures: knowing the password must not buy unlimited guesses at the code.
 */
export class SecondFactorService {
  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly auditLog: AuditLog,
    private readonly throttle: LoginThrottle,
    private readonly sessions: Pick<SessionStore, "completeSecondFactor">,
    // The dashboard's host, in each authenticator entry's name, and its logo beside the entry.
    private readonly accountHost: string,
    private readonly authenticatorImage: string,
    // Authenticator seeds are kept sealed with it, and opened only to check a code.
    private readonly secretBox: SecretBox,
    private readonly clock: () => number = Date.now,
  ) {}

  beginSetup(session: ResolvedSession): SetupResult {
    const user = this.userOf(session);
    if (user.totpEnabled) {
      return { kind: "already_enabled" };
    }
    return { kind: "started", setup: this.newPendingSecret(user) };
  }

  confirmSetup(session: ResolvedSession, code: string, context: RequestContext): ConfirmResult {
    const user = this.userOf(session);
    if (user.totpEnabled) {
      return { kind: "already_enabled" };
    }
    if (user.totpPendingSecret === null) {
      return { kind: "not_started" };
    }
    const pending = this.opened(user.totpPendingSecret);
    const typed = normalizeTotpCode(code);
    const step = matchTotp(pending, typed, this.clock(), null);
    if (step === null) {
      return { kind: "wrong_code", failure: explainTotpFailure(pending, typed, this.clock()) };
    }
    const codes = generateRecoveryCodes();
    // TOTP goes on together with this session's new token, or not at all: the store writes inside this transaction.
    const token = this.databaseHandle.database.transaction((transaction) => {
      const replaced = this.sessions.completeSecondFactor(session.tokenHash);
      if (replaced === null) {
        return null;
      }
      transaction
        .update(users)
        .set({ totpSecret: user.totpPendingSecret, totpPendingSecret: null, totpEnabled: true, totpLastStep: step })
        .where(eq(users.id, user.id))
        .run();
      replaceRecoveryCodes(transaction, user.id, codes);
      return replaced;
    });
    if (token === null) {
      return { kind: "session_ended" };
    }
    this.audit(session, AUDIT_ACTIONS.totpEnrolled, context);
    return { kind: "enabled", codes: { recoveryCodes: codes }, token };
  }

  verify(session: ResolvedSession, code: string, context: RequestContext): VerifyResult {
    const check = this.checkCode(this.userOf(session), code, context);
    if (check.kind === "throttled") {
      return check;
    }
    if (check.kind === "wrong_code") {
      return this.recordFailure(session, context, check.failure);
    }
    const token = this.sessions.completeSecondFactor(session.tokenHash);
    this.audit(
      session,
      check.usedRecoveryCode ? AUDIT_ACTIONS.recoveryCodeUsed : AUDIT_ACTIONS.secondFactorVerified,
      context,
    );
    return token === null ? { kind: "session_ended" } : { kind: "verified", token };
  }

  /**
   * Moving to a new authenticator, proven with a current code, or a recovery code when the old
   * phone is gone. The new secret waits until a code from the new app confirms it: until then the
   * old entry keeps working, so a move left halfway locks nobody out.
   */
  beginMove(session: ResolvedSession, code: string, context: RequestContext): MoveResult {
    const user = this.userOf(session);
    const check = this.checkCode(user, code, context);
    if (check.kind !== "verified") {
      return this.refused(session, context, check);
    }
    return { kind: "started", setup: this.newPendingSecret(user) };
  }

  confirmMove(session: ResolvedSession, code: string, context: RequestContext): MoveConfirmResult {
    const user = this.userOf(session);
    if (!user.totpEnabled || user.totpPendingSecret === null) {
      return { kind: "not_started" };
    }
    const pending = this.opened(user.totpPendingSecret);
    const typed = normalizeTotpCode(code);
    const step = matchTotp(pending, typed, this.clock(), null);
    if (step === null) {
      return { kind: "wrong_code", failure: explainTotpFailure(pending, typed, this.clock()) };
    }
    this.databaseHandle.database
      .update(users)
      .set({ totpSecret: user.totpPendingSecret, totpPendingSecret: null, totpLastStep: step })
      .where(eq(users.id, user.id))
      .run();
    this.audit(session, AUDIT_ACTIONS.authenticatorMoved, context);
    return { kind: "moved" };
  }

  /** New recovery codes for old ones, proven with a current code; the old ones stop working at once. */
  renewRecoveryCodes(session: ResolvedSession, code: string, context: RequestContext): RenewResult {
    const user = this.userOf(session);
    const check = this.checkCode(user, code, context);
    if (check.kind !== "verified") {
      return this.refused(session, context, check);
    }
    const codes = generateRecoveryCodes();
    this.databaseHandle.database.transaction((transaction) => replaceRecoveryCodes(transaction, user.id, codes));
    this.audit(session, AUDIT_ACTIONS.recoveryCodesRenewed, context);
    return { kind: "renewed", codes: { recoveryCodes: codes } };
  }

  /** A current code, or an unused recovery code, before adding another way in: a passkey. */
  checkCurrentCode(
    session: ResolvedSession,
    code: string,
    context: RequestContext,
  ): { kind: "verified" } | CodeRefusal {
    const check = this.checkCode(this.userOf(session), code, context);
    return check.kind === "verified" ? { kind: "verified" } : this.refused(session, context, check);
  }

  // A code from the authenticator in use, or an unused recovery code. Wrong ones count as failed
  // sign-ins, so no page here gives free guesses.
  private checkCode(user: UserRow, code: string, context: RequestContext): CodeCheck {
    const retryAfterSeconds = this.throttle.retryAfterSeconds(user.username, context.ip);
    if (retryAfterSeconds > 0) {
      return { kind: "throttled", retryAfterSeconds };
    }
    const typed = normalizeTotpCode(code);
    const isTotpCode = TOTP_CODE_PATTERN.test(typed);
    const usedRecoveryCode = !isTotpCode && this.consumeRecoveryCode(user.id, code);
    const totpSecret = isTotpCode && user.totpSecret !== null ? this.opened(user.totpSecret) : null;
    const step = totpSecret === null ? null : matchTotp(totpSecret, typed, this.clock(), user.totpLastStep);
    const passed = step !== null || usedRecoveryCode;
    this.throttle.record(user.username, context.ip, passed);
    if (!passed) {
      const failure =
        totpSecret === null
          ? NOT_A_MATCH
          : explainTotpFailure(totpSecret, typed, this.clock(), TOTP_ALLOWED_DRIFT_STEPS);
      return { kind: "wrong_code", failure };
    }
    if (step !== null) {
      this.databaseHandle.database.update(users).set({ totpLastStep: step }).where(eq(users.id, user.id)).run();
    }
    return { kind: "verified", usedRecoveryCode };
  }

  private refused(session: ResolvedSession, context: RequestContext, refusal: CodeRefusal): CodeRefusal {
    if (refusal.kind === "wrong_code") {
      this.audit(session, AUDIT_ACTIONS.secondFactorFailed, context, refusal.failure);
    }
    return refusal;
  }

  private newPendingSecret(user: UserRow): TotpSetupView {
    const secret = generateTotpSecret();
    this.databaseHandle.database
      .update(users)
      .set({ totpPendingSecret: this.secretBox.seal(secret) })
      .where(eq(users.id, user.id))
      .run();
    const accountName = totpAccountName(user.username, this.accountHost);
    return { secret, otpauthUri: otpauthUri(accountName, secret, this.authenticatorImage) };
  }

  // A seed another backup passphrase sealed cannot be checked: the person needs a recovery code, a passkey or a reset.
  private opened(sealed: string): string {
    const secret = this.secretBox.open(sealed);
    if (secret === null) {
      throw new DomainError(API_ERRORS.storedSecretUnreadable);
    }
    return secret;
  }

  private recordFailure(session: ResolvedSession, context: RequestContext, failure: TotpFailure): VerifyResult {
    const database = this.databaseHandle.database;
    const updated = database
      .update(sessions)
      .set({ secondFactorFailures: sql`${sessions.secondFactorFailures} + 1` })
      .where(eq(sessions.tokenHash, session.tokenHash))
      .returning({ failures: sessions.secondFactorFailures })
      .get();
    this.audit(session, AUDIT_ACTIONS.secondFactorFailed, context, failure);
    if ((updated?.failures ?? SECOND_FACTOR_MAXIMUM_FAILURES) < SECOND_FACTOR_MAXIMUM_FAILURES) {
      return { kind: "wrong_code", failure };
    }
    database.delete(sessions).where(eq(sessions.tokenHash, session.tokenHash)).run();
    return { kind: "session_ended" };
  }

  private consumeRecoveryCode(userId: string, code: string): boolean {
    const result = this.databaseHandle.database
      .update(recoveryCodes)
      .set({ usedAt: this.clock() })
      .where(
        and(
          eq(recoveryCodes.userId, userId),
          eq(recoveryCodes.codeHash, hashRecoveryCode(code)),
          isNull(recoveryCodes.usedAt),
        ),
      )
      .run();
    return result.changes > 0;
  }

  private userOf(session: ResolvedSession) {
    return this.databaseHandle.database.select().from(users).where(eq(users.id, session.user.id)).get()!;
  }

  private audit(session: ResolvedSession, action: AuditAction, context: RequestContext, details: object = {}) {
    const actor = { userId: session.user.id, username: session.user.username, ...context };
    this.auditLog.recordUserAction(actor, action, { kind: TARGET_USER, id: session.user.id }, { ...details });
  }
}
