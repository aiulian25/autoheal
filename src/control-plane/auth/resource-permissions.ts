import { eq } from "drizzle-orm";
import { API_ERRORS } from "../../shared/api.js";
import {
  ACCESS_FULL,
  HOST_SILENT_AFTER_MILLISECONDS,
  HOST_STATUS_ACTIVE,
  ROLE_ADMIN,
  USER_STATUS_ACTIVE,
  type JobAction,
} from "../../shared/constants.js";
import {
  actionPermission,
  resourceAllowed,
  resourceGrantsSchema,
  type ResourceAction,
  type ResourcePermissionsView,
} from "../../shared/resource-permissions.js";
import type { DatabaseHandle } from "../database/connection.js";
import { hosts, resourcePermissions, users } from "../database/schema.js";
import { DomainError } from "../domain-error.js";
import type { InventoryService } from "../inventory/inventory-service.js";
import type { SessionStore } from "./sessions.js";

export interface ResourceMember {
  name: string;
  composeProject: string | null;
}
/**
 * What a person may do to a host's containers. Autoheal is one person's: its owner may do all of it, and nobody holds a
 * grant any more, so for anyone else every check refuses.
 */
export class ResourcePermissions {
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly inventory: Pick<InventoryService, "containers">,
    private readonly sessions: Pick<SessionStore, "isLive">,
    private readonly clock: () => number = Date.now,
  ) {}
  private get database() {
    return this.handle.database;
  }
  private user(userId: string) {
    const user = this.database.select().from(users).where(eq(users.id, userId)).get();
    if (!user) throw new DomainError(API_ERRORS.userNotFound);
    return user;
  }
  private active(userId: string) {
    const user = this.user(userId);
    if (user.status !== USER_STATUS_ACTIVE || user.mustChangePassword || !user.totpEnabled)
      throw new DomainError(API_ERRORS.resourceForbidden);
    return user;
  }
  isAdmin(userId: string) {
    return this.active(userId).role === ROLE_ADMIN;
  }
  sessionLive(tokenHash: string) {
    return this.sessions.isLive(tokenHash, ACCESS_FULL);
  }
  supported(hostId: string) {
    const host = this.database.select().from(hosts).where(eq(hosts.id, hostId)).get();
    const now = this.clock();
    return (
      host !== undefined &&
      host.status === HOST_STATUS_ACTIVE &&
      host.resourcePermissions &&
      host.lastHeartbeatAt !== null &&
      now >= host.lastHeartbeatAt &&
      now - host.lastHeartbeatAt <= HOST_SILENT_AFTER_MILLISECONDS
    );
  }
  current(userId: string): ResourcePermissionsView {
    this.user(userId);
    const row = this.database.select().from(resourcePermissions).where(eq(resourcePermissions.userId, userId)).get();
    if (!row) return { revision: 0, grants: [] };
    try {
      return { revision: row.revision, grants: resourceGrantsSchema.parse(JSON.parse(row.grantsJson)) };
    } catch {
      throw new DomainError(API_ERRORS.resourceForbidden);
    }
  }
  require(userId: string, hostId: string, action: ResourceAction, names: readonly string[]) {
    if (this.isAdmin(userId)) return;
    const containers = this.inventory.containers({ hostId });
    const members = names.map((name) => containers.find((container) => container.name === name));
    if (members.some((member) => member === undefined)) throw new DomainError(API_ERRORS.resourceForbidden);
    this.requireMembers(userId, hostId, action, members as ResourceMember[]);
  }
  requireMembers(userId: string, hostId: string, action: ResourceAction, members: readonly ResourceMember[]) {
    if (this.isAdmin(userId)) return;
    const { grants } = this.current(userId);
    if (members.length === 0 || members.some((member) => !resourceAllowed(grants, action, { hostId, ...member })))
      throw new DomainError(API_ERRORS.resourceForbidden);
    if (!this.supported(hostId)) throw new DomainError(API_ERRORS.resourceRunnerRequired);
  }
  requireJob(userId: string, hostId: string, name: string, jobAction: JobAction) {
    if (this.isAdmin(userId)) return;
    const action = actionPermission(jobAction);
    if (action === null || name.length === 0) throw new DomainError(API_ERRORS.resourceForbidden);
    this.require(userId, hostId, action, [name]);
  }
}
