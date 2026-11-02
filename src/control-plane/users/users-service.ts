import { randomUUID } from "node:crypto";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { API_ERRORS, type AccountView, type CreatedAccountView, type TemporaryPasswordView } from "../../shared/api.js";
import {
  AUDIT_ACTIONS,
  ROLE_ADMIN,
  TARGET_USER,
  USER_STATUS_ACTIVE,
  USER_STATUS_DEACTIVATED,
  type Role,
} from "../../shared/constants.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import { generateOneTimePassword } from "../auth/bootstrap.js";
import { hashPassword } from "../auth/password-hashing.js";
import type { DatabaseHandle } from "../database/connection.js";
import { auditEvents, passkeys, recoveryCodes, resourcePermissions, sessions, users } from "../database/schema.js";
import { DomainError } from "../domain-error.js";

type UserRow = typeof users.$inferSelect;
type UserStatus = UserRow["status"];

const accountView = (user: UserRow): AccountView => ({
  id: user.id,
  username: user.username,
  role: user.role,
  status: user.status,
  mustChangePassword: user.mustChangePassword,
  totpEnabled: user.totpEnabled,
  createdAt: user.createdAt,
  lastLoginAt: user.lastLoginAt,
});

const targetOf = (user: UserRow) => ({ kind: TARGET_USER, id: user.id });

const beforeRoleChanged = (before: UserRow, after: UserRow) => before.role !== after.role;

const isActiveAdmin = (user: UserRow) => user.role === ROLE_ADMIN && user.status === USER_STATUS_ACTIVE;

/** Admin-only account management. There must always be one active admin left. */
export class UsersService {
  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly auditLog: AuditLog,
    private readonly clock: () => number = Date.now,
  ) {}

  list(): AccountView[] {
    return this.databaseHandle.database.select().from(users).orderBy(asc(users.username)).all().map(accountView);
  }

  async create(actor: Actor, request: { username: string; role: Role }): Promise<CreatedAccountView> {
    const temporaryPassword = generateOneTimePassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const user = this.databaseHandle.database.transaction((transaction) => {
      const taken = transaction.select({ id: users.id }).from(users).where(eq(users.username, request.username)).get();
      if (taken !== undefined) {
        throw new DomainError(API_ERRORS.usernameTaken);
      }
      return transaction
        .insert(users)
        .values({ id: randomUUID(), ...request, passwordHash, mustChangePassword: true, createdAt: this.clock() })
        .returning()
        .get();
    });
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.userCreated, targetOf(user), {
      username: user.username,
      role: user.role,
    });
    return { account: accountView(user), temporaryPassword };
  }

  update(actor: Actor, userId: string, change: { role?: Role; status?: UserStatus }): AccountView {
    const database = this.databaseHandle.database;
    const { before, after } = database.transaction((transaction) => {
      const user = this.requireUser(userId, transaction);
      const losesAdmin =
        isActiveAdmin(user) &&
        ((change.role ?? ROLE_ADMIN) !== ROLE_ADMIN || (change.status ?? USER_STATUS_ACTIVE) !== USER_STATUS_ACTIVE);
      if (losesAdmin && this.activeAdminCount(transaction) <= 1) {
        throw new DomainError(API_ERRORS.lastAdmin);
      }
      const updated = transaction.update(users).set(change).where(eq(users.id, userId)).returning().get();
      if (beforeRoleChanged(user, updated) || updated.status === USER_STATUS_DEACTIVATED) {
        transaction
          .insert(resourcePermissions)
          .values({ userId, revision: 1, grantsJson: "[]" })
          .onConflictDoUpdate({
            target: resourcePermissions.userId,
            set: { revision: sql`${resourcePermissions.revision} + 1`, grantsJson: "[]" },
          })
          .run();
        transaction.delete(sessions).where(eq(sessions.userId, userId)).run();
      }
      return { before: user, after: updated };
    });
    this.auditChanges(actor, before, after);
    return accountView(after);
  }

  async resetPassword(actor: Actor, userId: string): Promise<TemporaryPasswordView> {
    const temporaryPassword = generateOneTimePassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const user = this.databaseHandle.database.transaction((transaction) => {
      const found = this.requireUser(userId, transaction);
      transaction.update(users).set({ passwordHash, mustChangePassword: true }).where(eq(users.id, userId)).run();
      transaction.delete(sessions).where(eq(sessions.userId, userId)).run();
      transaction.delete(passkeys).where(eq(passkeys.userId, userId)).run();
      return found;
    });
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.userPasswordReset, targetOf(user));
    return { temporaryPassword };
  }

  resetTotp(actor: Actor, userId: string) {
    const user = this.databaseHandle.database.transaction((transaction) => {
      const found = this.requireUser(userId, transaction);
      transaction
        .update(users)
        .set({ totpSecret: null, totpPendingSecret: null, totpEnabled: false, totpLastStep: null })
        .where(eq(users.id, userId))
        .run();
      transaction.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
      transaction.delete(sessions).where(eq(sessions.userId, userId)).run();
      transaction.delete(passkeys).where(eq(passkeys.userId, userId)).run();
      return found;
    });
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.userTotpReset, targetOf(user));
  }

  /** Only for accounts that never did anything: the audit trail must keep naming who acted. */
  remove(actor: Actor, userId: string) {
    const user = this.databaseHandle.database.transaction((transaction) => {
      const found = this.requireUser(userId, transaction);
      const hasActed =
        transaction.select({ id: auditEvents.id }).from(auditEvents).where(eq(auditEvents.actorId, userId)).get() !==
        undefined;
      if (hasActed) {
        throw new DomainError(API_ERRORS.deactivateInstead);
      }
      if (isActiveAdmin(found) && this.activeAdminCount(transaction) <= 1) {
        throw new DomainError(API_ERRORS.lastAdmin);
      }
      transaction.delete(users).where(eq(users.id, userId)).run();
      return found;
    });
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.userDeleted, targetOf(user), { username: user.username });
  }

  private requireUser(userId: string, database = this.databaseHandle.database): UserRow {
    const user = database.select().from(users).where(eq(users.id, userId)).get();
    if (user === undefined) {
      throw new DomainError(API_ERRORS.userNotFound);
    }
    return user;
  }

  private activeAdminCount(database = this.databaseHandle.database): number {
    const result = database
      .select({ admins: count() })
      .from(users)
      .where(and(eq(users.role, ROLE_ADMIN), eq(users.status, USER_STATUS_ACTIVE)))
      .get();
    return result?.admins ?? 0;
  }

  private auditChanges(actor: Actor, before: UserRow, after: UserRow) {
    if (before.role !== after.role) {
      this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.userRoleChanged, targetOf(after), {
        from: before.role,
        to: after.role,
      });
    }
    if (before.status !== after.status) {
      const action =
        after.status === USER_STATUS_DEACTIVATED ? AUDIT_ACTIONS.userDeactivated : AUDIT_ACTIONS.userReactivated;
      this.auditLog.recordUserAction(actor, action, targetOf(after));
    }
  }
}
