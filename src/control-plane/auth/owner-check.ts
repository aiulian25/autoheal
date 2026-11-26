import { eq } from "drizzle-orm";
import { API_ERRORS } from "../../shared/api.js";
import { ROLE_ADMIN, USER_STATUS_ACTIVE } from "../../shared/constants.js";
import type { DatabaseHandle } from "../database/connection.js";
import { users } from "../database/schema.js";
import { DomainError } from "../domain-error.js";

/**
 * Whether someone is the one person this Autoheal is for, as far along as acting needs: its active admin, with their
 * own password and an authenticator set up. Nobody else does anything to a host.
 */
export class OwnerCheck {
  constructor(private readonly databaseHandle: DatabaseHandle) {}

  is(userId: string): boolean {
    const user = this.databaseHandle.database.select().from(users).where(eq(users.id, userId)).get();
    return (
      user !== undefined &&
      user.role === ROLE_ADMIN &&
      user.status === USER_STATUS_ACTIVE &&
      !user.mustChangePassword &&
      user.totpEnabled
    );
  }

  require(userId: string) {
    if (!this.is(userId)) throw new DomainError(API_ERRORS.resourceForbidden);
  }
}
