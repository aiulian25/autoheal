import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  ACTOR_SYSTEM,
  ADMIN_USERNAME,
  AUDIT_ACTIONS,
  BOOTSTRAP_MESSAGES,
  ONE_TIME_PASSWORD_BYTES,
  ROLE_ADMIN,
  SINGLE_OWNER_MESSAGES,
  SYSTEM_ACTOR_LABEL,
  TARGET_USER,
  USER_STATUS_ACTIVE,
} from "../../shared/constants.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { passkeys, recoveryCodes, sessions, users } from "../database/schema.js";
import { hashPassword } from "./password-hashing.js";
import { keepOneOwner, ownerOf, setUpWith, type Person } from "./single-owner.js";

export const generateOneTimePassword = () => randomBytes(ONE_TIME_PASSWORD_BYTES).toString("base64url");

const anyUser = (databaseHandle: DatabaseHandle) =>
  databaseHandle.database.select({ id: users.id }).from(users).limit(1).get() !== undefined;

/** On an empty database, create the one person it is for: an admin with a one-time password shown once. */
export async function ensureFirstAdmin(
  databaseHandle: DatabaseHandle,
  auditLog: AuditLog,
  username: string,
  announce: (message: string) => void,
  clock: () => number = Date.now,
): Promise<boolean> {
  if (anyUser(databaseHandle)) {
    return false;
  }
  const password = generateOneTimePassword();
  const passwordHash = await hashPassword(password);
  const id = randomUUID();
  // Asked again in the step that writes it: two starting at once make one person, never two.
  const created = databaseHandle.database.transaction(
    (transaction) => {
      if (transaction.select({ id: users.id }).from(users).limit(1).get() !== undefined) return false;
      transaction
        .insert(users)
        .values({ id, username, passwordHash, role: ROLE_ADMIN, mustChangePassword: true, createdAt: clock() })
        .run();
      return true;
    },
    { behavior: "immediate" },
  );
  if (!created) {
    return false;
  }
  auditLog.record({
    actorKind: ACTOR_SYSTEM,
    actorLabel: SYSTEM_ACTOR_LABEL,
    action: AUDIT_ACTIONS.adminBootstrapped,
    targetKind: TARGET_USER,
    targetId: id,
    details: { username },
  });
  announce(BOOTSTRAP_MESSAGES.firstAdmin(username, password));
  return true;
}

export type ResetRefusal =
  { kind: "not_owner"; owner: string } | { kind: "unknown"; username: string } | { kind: "choose" };
export type ResetOutcome = { kind: "reset"; username: string } | ResetRefusal;

type Target = { kind: "existing"; person: Person } | { kind: "first" } | ResetRefusal;

const everyoneIn = (databaseHandle: DatabaseHandle): Person[] =>
  databaseHandle.database.select({ id: users.id, username: users.username }).from(users).all();

// With no admin active: the account it was set up with, else its only account, else the one named on the host.
function targetWithNobody(databaseHandle: DatabaseHandle, asked: string | undefined): Target {
  const everyone = everyoneIn(databaseHandle);
  if (everyone.length === 0) return { kind: "first" };
  const named = everyone.find(({ username }) => username === asked);
  if (named !== undefined) return { kind: "existing", person: named };
  if (asked !== undefined) return { kind: "unknown", username: asked };
  const first = setUpWith(databaseHandle.sqlite);
  const original = everyone.filter(({ id }) => first.has(id));
  const candidates = original.length === 1 ? original : everyone;
  return candidates.length === 1 ? { kind: "existing", person: candidates[0]! } : { kind: "choose" };
}

// Of several admins, none the one it was set up with: the one named on the host decides, who holds the machine anyway.
function targetAmongSeveral(databaseHandle: DatabaseHandle, asked: string | undefined): Target {
  if (asked === undefined) return { kind: "choose" };
  const named = everyoneIn(databaseHandle).find(({ username }) => username === asked);
  return named === undefined ? { kind: "unknown", username: asked } : { kind: "existing", person: named };
}

// Whom a reset is for: the owner, when there is one, and only them.
function targetOf(databaseHandle: DatabaseHandle, asked: string | undefined): Target {
  const owner = ownerOf(databaseHandle.sqlite);
  if (owner.kind === "nobody") return targetWithNobody(databaseHandle, asked);
  if (owner.kind === "unclear") return targetAmongSeveral(databaseHandle, asked);
  const isOwner = asked === undefined || asked === owner.person.username;
  return isOwner ? { kind: "existing", person: owner.person } : { kind: "not_owner", owner: owner.person.username };
}

/**
 * Lockout recovery from the host (`docker exec ... reset-admin`): there is no email, and whoever can run that already
 * has root on the machine. Resets the one person this Autoheal is for: a new one-time password, TOTP cleared, their
 * sessions, recovery codes and passkeys ended, and nobody else left able to sign in. On a database with nobody in it,
 * it sets up the first person. It never adds anyone beside them.
 */
export async function resetOwner(
  databaseHandle: DatabaseHandle,
  auditLog: AuditLog,
  asked: string | undefined,
  announce: (message: string) => void,
  clock: () => number = Date.now,
): Promise<ResetOutcome> {
  const target = targetOf(databaseHandle, asked);
  if (target.kind === "first") {
    const username = asked ?? ADMIN_USERNAME;
    await ensureFirstAdmin(databaseHandle, auditLog, username, announce, clock);
    return { kind: "reset", username };
  }
  if (target.kind !== "existing") {
    return target;
  }
  const { person } = target;
  const password = generateOneTimePassword();
  const passwordHash = await hashPassword(password);
  // Everyone else first: only then may this one be the one who is active.
  keepOneOwner(databaseHandle, auditLog, person);
  databaseHandle.database.transaction((transaction) => {
    transaction
      .update(users)
      .set({
        passwordHash,
        role: ROLE_ADMIN,
        status: USER_STATUS_ACTIVE,
        mustChangePassword: true,
        totpSecret: null,
        totpPendingSecret: null,
        totpEnabled: false,
        totpLastStep: null,
      })
      .where(eq(users.id, person.id))
      .run();
    transaction.delete(sessions).where(eq(sessions.userId, person.id)).run();
    transaction.delete(recoveryCodes).where(eq(recoveryCodes.userId, person.id)).run();
    transaction.delete(passkeys).where(eq(passkeys.userId, person.id)).run();
  });
  auditLog.record({
    actorKind: ACTOR_SYSTEM,
    actorLabel: SYSTEM_ACTOR_LABEL,
    action: AUDIT_ACTIONS.adminReset,
    targetKind: TARGET_USER,
    targetId: person.id,
    details: { username: person.username },
  });
  announce(BOOTSTRAP_MESSAGES.adminReset(person.username, password));
  return { kind: "reset", username: person.username };
}

/** What the host is told when no reset is made. */
export function refusalOf(refusal: ResetRefusal): string {
  if (refusal.kind === "not_owner") return SINGLE_OWNER_MESSAGES.notOwner(refusal.owner);
  if (refusal.kind === "unknown") return SINGLE_OWNER_MESSAGES.unknown(refusal.username);
  return SINGLE_OWNER_MESSAGES.chooseOne;
}
