import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { decodeClientDataJSON } from "@simplewebauthn/server/helpers";
import { and, asc, eq } from "drizzle-orm";
import { API_ERRORS, type PasskeyStatusView, type PasskeyView, type SessionView } from "../../shared/api.js";
import {
  ACTOR_USER,
  APP_NAME,
  AUDIT_ACTIONS,
  AUDIT_LABEL_MAXIMUM_LENGTH,
  IPV6_BRACKETS,
  LOGIN_FAILURE_REASONS,
  PASSKEY_CEREMONY_LIMIT,
  PASSKEY_CEREMONY_MILLISECONDS,
  PASSKEY_DEFAULT_NAME,
  PASSKEY_PROVIDERS,
  PASSKEYS_PER_USER,
  SIGN_IN_METHOD,
  TARGET_USER,
  USER_STATUS_ACTIVE,
  type AuditAction,
} from "../../shared/constants.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { passkeys, users } from "../database/schema.js";
import { DomainError } from "../domain-error.js";
import { userView, type RequestContext } from "./auth-service.js";
import type { ResolvedSession, SessionStore } from "./sessions.js";

const CEREMONY = { signIn: "sign_in", enrol: "enrol" } as const;
type CeremonyPurpose = (typeof CEREMONY)[keyof typeof CEREMONY];

interface Ceremony {
  purpose: CeremonyPurpose;
  // Who an enrolment is for; null for a sign-in, which doesn't know yet.
  userId: string | null;
  expiresAt: number;
}

interface RelyingParty {
  id: string;
  origin: string;
}

type PasskeyRow = typeof passkeys.$inferSelect;
type UserRow = typeof users.$inferSelect;

export type PasskeySignInResult = { kind: "signed_in"; token: string; session: SessionView } | { kind: "refused" };

// Browsers keep passkeys to a site reached by name: an address like 192.168.10.83 can have none.
function relyingPartyOf(publicBaseUrl: string): RelyingParty | null {
  const url = new URL(publicBaseUrl);
  const isAddress = isIP(url.hostname.replace(IPV6_BRACKETS, "")) !== 0;
  return isAddress ? null : { id: url.hostname, origin: url.origin };
}

// The user handle a passkey keeps: our id for the person, which says whose passkey answered.
const userHandleOf = (userId: string) => Buffer.from(userId).toString("base64url");
const transportsOf = (row: PasskeyRow) => JSON.parse(row.transportsJson) as string[];

// The challenge an answer was made for; null when its client data can't be read.
function challengeOf(response: AuthenticationResponseJSON | RegistrationResponseJSON): string | null {
  try {
    return decodeClientDataJSON(response.response.clientDataJSON).challenge;
  } catch {
    return null;
  }
}

/**
 * Passkeys: signing in with the device's own lock (fingerprint, face, PIN) in place of the password
 * and the code. A passkey must verify the person (user verification), so one alone
 * counts as both steps. Each challenge works once, within five minutes, and only for what it was made
 * for. Only public keys are kept.
 */
export class PasskeyService {
  private readonly relyingParty: RelyingParty | null;
  // ponytail: in memory, so a restart drops a sign-in under way; a table if control planes ever multiply.
  private readonly ceremonies = new Map<string, Ceremony>();

  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly auditLog: AuditLog,
    private readonly sessions: SessionStore,
    publicBaseUrl: string,
    private readonly clock: () => number = Date.now,
  ) {
    this.relyingParty = relyingPartyOf(publicBaseUrl);
  }

  private get database() {
    return this.databaseHandle.database;
  }

  status(): PasskeyStatusView {
    if (this.relyingParty === null) {
      return { usable: false, offered: false };
    }
    const any = this.database
      .select({ id: passkeys.id })
      .from(passkeys)
      .where(eq(passkeys.relyingPartyId, this.relyingParty.id))
      .get();
    return { usable: true, offered: any !== undefined };
  }

  /** The challenge for signing in; any passkey made here may answer it, so no name is asked first. */
  async signInOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const relyingParty = this.requireRelyingParty();
    const options = await generateAuthenticationOptions({
      rpID: relyingParty.id,
      userVerification: "required",
      timeout: PASSKEY_CEREMONY_MILLISECONDS,
    });
    this.remember(options.challenge, CEREMONY.signIn, null);
    return options;
  }

  async signIn(response: AuthenticationResponseJSON, context: RequestContext): Promise<PasskeySignInResult> {
    const relyingParty = this.requireRelyingParty();
    const challenge = this.takeChallenge(response, CEREMONY.signIn, null);
    const found = this.database
      .select({ passkey: passkeys, user: users })
      .from(passkeys)
      .innerJoin(users, eq(users.id, passkeys.userId))
      .where(and(eq(passkeys.credentialId, response.id), eq(passkeys.relyingPartyId, relyingParty.id)))
      .get();
    const counter =
      found === undefined ? null : await this.verifiedCounter(found.passkey, found.user, response, challenge);
    if (found === undefined || counter === null) {
      this.recordRefusedSignIn(found?.user ?? null, LOGIN_FAILURE_REASONS.passkeyRefused, context);
      return { kind: "refused" };
    }
    if (found.user.status !== USER_STATUS_ACTIVE) {
      this.recordRefusedSignIn(found.user, LOGIN_FAILURE_REASONS.deactivated, context);
      return { kind: "refused" };
    }
    const now = this.clock();
    this.database.update(passkeys).set({ counter, lastUsedAt: now }).where(eq(passkeys.id, found.passkey.id)).run();
    this.database.update(users).set({ lastLoginAt: now }).where(eq(users.id, found.user.id)).run();
    const { token, csrfToken } = this.sessions.create(found.user.id, context, true);
    this.auditLog.record({
      actorKind: ACTOR_USER,
      actorId: found.user.id,
      actorLabel: found.user.username,
      action: AUDIT_ACTIONS.loginSucceeded,
      details: { method: SIGN_IN_METHOD.passkey, passkey: found.passkey.name },
      ip: context.ip,
      requestId: context.requestId,
    });
    return { kind: "signed_in", token, session: { user: userView(found.user), csrfToken, secondFactorDone: true } };
  }

  list(session: ResolvedSession): PasskeyView[] {
    return this.rowsOf(session.user.id).map((row) => this.viewOf(row));
  }

  /** The challenge for adding one; the route has already checked a current code. */
  async enrolmentOptions(session: ResolvedSession): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const relyingParty = this.requireRelyingParty();
    const own = this.rowsOf(session.user.id);
    if (own.length >= PASSKEYS_PER_USER) {
      throw new DomainError(API_ERRORS.passkeyLimit);
    }
    const options = await generateRegistrationOptions({
      rpName: APP_NAME,
      rpID: relyingParty.id,
      userName: session.user.username,
      userDisplayName: session.user.username,
      userID: Buffer.from(session.user.id),
      attestationType: "none",
      // The same device twice would be a second entry for one passkey: the browser says it has one already.
      excludeCredentials: own
        .filter((row) => row.relyingPartyId === relyingParty.id)
        .map((row) => ({ id: row.credentialId, transports: transportsOf(row) })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      timeout: PASSKEY_CEREMONY_MILLISECONDS,
    });
    this.remember(options.challenge, CEREMONY.enrol, session.user.id);
    return options;
  }

  /** Keeps the passkey the browser made, named after the password manager that keeps it when it says. */
  async enrol(
    session: ResolvedSession,
    response: RegistrationResponseJSON,
    suggestedName: string | undefined,
    context: RequestContext,
  ): Promise<PasskeyView> {
    const relyingParty = this.requireRelyingParty();
    const challenge = this.takeChallenge(response, CEREMONY.enrol, session.user.id);
    if (challenge === null) {
      throw new DomainError(API_ERRORS.passkeyNotAdded);
    }
    const registration = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: relyingParty.origin,
      expectedRPID: relyingParty.id,
      requireUserVerification: true,
    }).catch(() => null);
    const info = registration?.verified === true ? registration.registrationInfo : null;
    const taken = info !== null && this.findByCredential(info.credential.id) !== undefined;
    if (info === null || taken) {
      throw new DomainError(API_ERRORS.passkeyNotAdded);
    }
    const row: PasskeyRow = {
      id: randomUUID(),
      userId: session.user.id,
      relyingPartyId: relyingParty.id,
      credentialId: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey).toString("base64url"),
      counter: info.credential.counter,
      transportsJson: JSON.stringify(info.credential.transports ?? []),
      synced: info.credentialBackedUp,
      name: PASSKEY_PROVIDERS[info.aaguid] ?? suggestedName ?? PASSKEY_DEFAULT_NAME,
      createdAt: this.clock(),
      lastUsedAt: null,
    };
    this.database.insert(passkeys).values(row).run();
    this.audit(session, AUDIT_ACTIONS.passkeyAdded, { name: row.name }, context);
    return this.viewOf(row);
  }

  rename(session: ResolvedSession, passkeyId: string, name: string, context: RequestContext): PasskeyView {
    const row = this.ownRow(session, passkeyId);
    this.database.update(passkeys).set({ name }).where(eq(passkeys.id, row.id)).run();
    this.audit(session, AUDIT_ACTIONS.passkeyRenamed, { from: row.name, name }, context);
    return this.viewOf({ ...row, name });
  }

  remove(session: ResolvedSession, passkeyId: string, context: RequestContext) {
    const row = this.ownRow(session, passkeyId);
    this.database.delete(passkeys).where(eq(passkeys.id, row.id)).run();
    this.audit(session, AUDIT_ACTIONS.passkeyRemoved, { name: row.name }, context);
  }

  // The new counter when the passkey's answer checks out; null when it doesn't, or answers for someone else.
  private async verifiedCounter(
    passkey: PasskeyRow,
    user: UserRow,
    response: AuthenticationResponseJSON,
    challenge: string | null,
  ): Promise<number | null> {
    if (challenge === null) {
      return null;
    }
    const handle = response.response.userHandle;
    if (handle !== undefined && handle !== userHandleOf(user.id)) {
      return null;
    }
    const relyingParty = this.requireRelyingParty();
    const authentication = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: relyingParty.origin,
      expectedRPID: relyingParty.id,
      credential: {
        id: passkey.credentialId,
        publicKey: Buffer.from(passkey.publicKey, "base64url"),
        counter: passkey.counter,
        transports: transportsOf(passkey),
      },
      requireUserVerification: true,
    }).catch(() => null);
    return authentication?.verified === true ? authentication.authenticationInfo.newCounter : null;
  }

  private requireRelyingParty(): RelyingParty {
    if (this.relyingParty === null) {
      throw new DomainError(API_ERRORS.passkeysUnavailable);
    }
    return this.relyingParty;
  }

  private remember(challenge: string, purpose: CeremonyPurpose, userId: string | null) {
    const now = this.clock();
    for (const [waiting, ceremony] of this.ceremonies) {
      if (ceremony.expiresAt <= now) {
        this.ceremonies.delete(waiting);
      }
    }
    // The oldest goes first when too many wait: a flood can't grow memory, only end its own ceremonies.
    const oldest = this.ceremonies.keys().next();
    if (this.ceremonies.size >= PASSKEY_CEREMONY_LIMIT && oldest.done !== true) {
      this.ceremonies.delete(oldest.value);
    }
    this.ceremonies.set(challenge, { purpose, userId, expiresAt: now + PASSKEY_CEREMONY_MILLISECONDS });
  }

  // An answer ends the ceremony it names before anything else about it is checked, so a refused answer ends it too.
  // Its challenge when that ceremony was still open to this answer; null when not.
  private takeChallenge(
    response: AuthenticationResponseJSON | RegistrationResponseJSON,
    purpose: CeremonyPurpose,
    userId: string | null,
  ): string | null {
    const challenge = challengeOf(response);
    return challenge !== null && this.consume(challenge, purpose, userId) ? challenge : null;
  }

  // Once, for what it was made for, by whom, in time.
  private consume(challenge: string, purpose: CeremonyPurpose, userId: string | null): boolean {
    const ceremony = this.ceremonies.get(challenge);
    this.ceremonies.delete(challenge);
    return (
      ceremony !== undefined &&
      ceremony.purpose === purpose &&
      ceremony.userId === userId &&
      ceremony.expiresAt > this.clock()
    );
  }

  private rowsOf(userId: string): PasskeyRow[] {
    return this.database
      .select()
      .from(passkeys)
      .where(eq(passkeys.userId, userId))
      .orderBy(asc(passkeys.createdAt))
      .all();
  }

  private findByCredential(credentialId: string): PasskeyRow | undefined {
    return this.database.select().from(passkeys).where(eq(passkeys.credentialId, credentialId)).get();
  }

  private ownRow(session: ResolvedSession, passkeyId: string): PasskeyRow {
    const row = this.database
      .select()
      .from(passkeys)
      .where(and(eq(passkeys.id, passkeyId), eq(passkeys.userId, session.user.id)))
      .get();
    if (row === undefined) {
      throw new DomainError(API_ERRORS.passkeyNotFound);
    }
    return row;
  }

  private viewOf(row: PasskeyRow): PasskeyView {
    const here = row.relyingPartyId === this.relyingParty?.id;
    return {
      id: row.id,
      name: row.name,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      synced: row.synced,
      otherAddress: here ? null : row.relyingPartyId,
    };
  }

  private audit(
    session: ResolvedSession,
    action: AuditAction,
    details: Record<string, string>,
    context: RequestContext,
  ) {
    this.auditLog.record({
      actorKind: ACTOR_USER,
      actorId: session.user.id,
      actorLabel: session.user.username,
      action,
      targetKind: TARGET_USER,
      targetId: session.user.id,
      details,
      ip: context.ip,
      requestId: context.requestId,
    });
  }

  private recordRefusedSignIn(user: UserRow | null, reason: string, context: RequestContext) {
    this.auditLog.record({
      actorKind: ACTOR_USER,
      actorId: user?.id ?? null,
      actorLabel: (user?.username ?? SIGN_IN_METHOD.passkey).slice(0, AUDIT_LABEL_MAXIMUM_LENGTH),
      action: AUDIT_ACTIONS.loginFailed,
      details: { reason },
      ip: context.ip,
      requestId: context.requestId,
    });
  }
}
