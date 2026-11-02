import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  ACTOR_SYSTEM,
  AUDIT_ACTIONS,
  BOOTSTRAP_MESSAGES,
  ONE_TIME_PASSWORD_BYTES,
  ROLE_ADMIN,
  SYSTEM_ACTOR_LABEL,
  TARGET_USER,
  USER_STATUS_ACTIVE,
} from "../../shared/constants.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { passkeys, recoveryCodes, sessions, users } from "../database/schema.js";
import { hashPassword } from "./password-hashing.js";

export const generateOneTimePassword = () => randomBytes(ONE_TIME_PASSWORD_BYTES).toString("base64url");

/** On an empty database, create the admin account with a one-time password shown once. */
export async function ensureFirstAdmin(
  databaseHandle: DatabaseHandle,
  auditLog: AuditLog,
  username: string,
  announce: (message: string) => void,
  clock: () => number = Date.now,
): Promise<boolean> {
  const anyUser = databaseHandle.database.select({ id: users.id }).from(users).limit(1).get();
  if (anyUser !== undefined) {
    return false;
  }
  const password = generateOneTimePassword();
  const id = randomUUID();
  databaseHandle.database
    .insert(users)
    .values({
      id,
      username,
      passwordHash: await hashPassword(password),
      role: ROLE_ADMIN,
      mustChangePassword: true,
      createdAt: clock(),
    })
    .run();
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

/**
 * Lockout recovery from the host (`docker exec ... reset-admin`): there is no email, and whoever
 * can run that already has root on the machine. Re-activates or creates the account as admin,
 * clears TOTP and ends its sessions.
 */
export async function resetAdmin(
  databaseHandle: DatabaseHandle,
  auditLog: AuditLog,
  username: string,
  announce: (message: string) => void,
  clock: () => number = Date.now,
): Promise<void> {
  const password = generateOneTimePassword();
  const passwordHash = await hashPassword(password);
  const database = databaseHandle.database;
  const id = database.transaction((transaction) => {
    const existing = transaction.select({ id: users.id }).from(users).where(eq(users.username, username)).get();
    const userId = existing?.id ?? randomUUID();
    const resetFields = {
      passwordHash,
      role: ROLE_ADMIN,
      status: USER_STATUS_ACTIVE,
      mustChangePassword: true,
      totpSecret: null,
      totpPendingSecret: null,
      totpEnabled: false,
      totpLastStep: null,
    } as const;
    if (existing === undefined) {
      transaction
        .insert(users)
        .values({ id: userId, username, createdAt: clock(), ...resetFields })
        .run();
    } else {
      transaction.update(users).set(resetFields).where(eq(users.id, userId)).run();
    }
    transaction.delete(sessions).where(eq(sessions.userId, userId)).run();
    transaction.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
    transaction.delete(passkeys).where(eq(passkeys.userId, userId)).run();
    return userId;
  });
  auditLog.record({
    actorKind: ACTOR_SYSTEM,
    actorLabel: SYSTEM_ACTOR_LABEL,
    action: AUDIT_ACTIONS.adminReset,
    targetKind: TARGET_USER,
    targetId: id,
    details: { username },
  });
  announce(BOOTSTRAP_MESSAGES.adminReset(username, password));
}
