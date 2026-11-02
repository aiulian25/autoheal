import type { ResourceAction } from "../../shared/resource-permissions.js";
import type { ResourceMember, ResourcePermissions } from "../auth/resource-permissions.js";
import type { SessionStore } from "../auth/sessions.js";
import {
  ACCESS_FULL,
  HOST_KIND,
  HOST_STATUS_REVOKED,
  HOST_TERMINAL_ROOT,
  ROLE_ADMIN,
  USER_STATUS_ACTIVE,
} from "../../shared/constants.js";
import { eq } from "drizzle-orm";
import { API_ERRORS, type ContainerView } from "../../shared/api.js";
import type { DatabaseHandle } from "../database/connection.js";
import { hosts, users } from "../database/schema.js";
import { DomainError } from "../domain-error.js";
import type { InventoryService } from "../inventory/inventory-service.js";

/**
 * Who may reach inside a container, for a shell, its files or an edit: an admin (its routes say so), on a host whose
 * own .env does not turn it off, at a container its host lets Autoheal change.
 */
export class ContainerAccessService {
  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly inventory: Pick<InventoryService, "containers">,
    private readonly permissions?: ResourcePermissions,
    private readonly sessions?: Pick<SessionStore, "isLive">,
  ) {}

  /**
   * Whom a shell on the host runs as, once an admin may open one there: the SSH user over SSH, root through a helper.
   * Never an operator: no grant reaches past containers.
   */
  requireHostShell(hostId: string, userId: string): { user: string } {
    if (this.operatorUserId(userId) !== undefined) throw new DomainError(API_ERRORS.resourceForbidden);
    const host = this.databaseHandle.database.select().from(hosts).where(eq(hosts.id, hostId)).get();
    if (host === undefined || host.status === HOST_STATUS_REVOKED) throw new DomainError(API_ERRORS.hostNotFound);
    if (host.hostTerminal !== true) throw new DomainError(API_ERRORS.hostTerminalOff);
    return { user: host.kind === HOST_KIND.ssh ? (host.sshUser ?? HOST_TERMINAL_ROOT) : HOST_TERMINAL_ROOT };
  }

  /** An admin adding an app to a host whose runner can, and whose .env lets it. */
  requireHostDeploy(hostId: string, userId: string) {
    this.requireHostAdmin(hostId, userId);
    const host = this.databaseHandle.database.select().from(hosts).where(eq(hosts.id, hostId)).get();
    if (host?.hostDeploy !== true) throw new DomainError(API_ERRORS.hostDeployOff);
  }

  /** An admin looking at a host still enrolled here; no grant to an operator reaches past containers. */
  requireHostAdmin(hostId: string, userId: string) {
    if (this.operatorUserId(userId) !== undefined) throw new DomainError(API_ERRORS.resourceForbidden);
    const host = this.databaseHandle.database.select().from(hosts).where(eq(hosts.id, hostId)).get();
    if (host === undefined || host.status === HOST_STATUS_REVOKED) throw new DomainError(API_ERRORS.hostNotFound);
  }

  /** The container a shell, its files or an edit reach, once every guard let it; refused otherwise. */
  operatorUserId(userId: string): string | undefined {
    const user = this.databaseHandle.database.select().from(users).where(eq(users.id, userId)).get();
    if (!user || user.status !== USER_STATUS_ACTIVE) throw new DomainError(API_ERRORS.resourceForbidden);
    return user.role === ROLE_ADMIN ? undefined : userId;
  }
  authorizeOperator(
    hostId: string,
    containerName: string,
    userId: string,
    action: ResourceAction,
    members: readonly ResourceMember[],
    tokenHash: string | undefined,
  ): boolean {
    try {
      if (
        !tokenHash ||
        !(this.sessions?.isLive(tokenHash, ACCESS_FULL) ?? this.permissions?.sessionLive(tokenHash) ?? false)
      )
        return false;
      if (!members.some((member) => member.name === containerName) || !this.permissions) return false;
      this.require(hostId, containerName, userId, action);
      this.permissions.requireMembers(userId, hostId, action, members);
      return true;
    } catch {
      return false;
    }
  }
  require(hostId: string, containerName: string, userId?: string, action: ResourceAction = "read"): ContainerView {
    if (userId !== undefined) {
      if (this.permissions) this.permissions.require(userId, hostId, action, [containerName]);
      else if (this.operatorUserId(userId) !== undefined) throw new DomainError(API_ERRORS.resourceForbidden);
    }
    const host = this.databaseHandle.database
      .select({ containerAccess: hosts.containerAccess })
      .from(hosts)
      .where(eq(hosts.id, hostId))
      .get();
    if (host === undefined) {
      throw new DomainError(API_ERRORS.hostNotFound);
    }
    if (host.containerAccess !== true) {
      throw new DomainError(API_ERRORS.containerAccessOff);
    }
    const container = this.inventory.containers({ hostId }).find((candidate) => candidate.name === containerName);
    if (container === undefined) {
      throw new DomainError(API_ERRORS.containerNotFound);
    }
    if (container.handsOff !== null) {
      throw new DomainError(API_ERRORS.handsOff);
    }
    return container;
  }
}
