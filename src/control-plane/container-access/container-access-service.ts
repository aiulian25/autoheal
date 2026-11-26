import { HOST_KIND, HOST_STATUS_REVOKED, HOST_TERMINAL_ROOT } from "../../shared/constants.js";
import { eq } from "drizzle-orm";
import { API_ERRORS, type ContainerView } from "../../shared/api.js";
import type { OwnerCheck } from "../auth/owner-check.js";
import type { DatabaseHandle } from "../database/connection.js";
import { hosts } from "../database/schema.js";
import { DomainError } from "../domain-error.js";
import type { InventoryService } from "../inventory/inventory-service.js";

/**
 * Who may reach inside a container, for a shell, its files or an edit: the owner, on a host whose own .env does not
 * turn it off, at a container its host lets Autoheal change.
 */
export class ContainerAccessService {
  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly inventory: Pick<InventoryService, "containers">,
    private readonly owner: Pick<OwnerCheck, "require">,
  ) {}

  /** Whom a shell on the host runs as, once the owner may open one there: the SSH user over SSH, root through a helper. */
  requireHostShell(hostId: string, userId: string): { user: string } {
    this.owner.require(userId);
    const host = this.databaseHandle.database.select().from(hosts).where(eq(hosts.id, hostId)).get();
    if (host === undefined || host.status === HOST_STATUS_REVOKED) throw new DomainError(API_ERRORS.hostNotFound);
    if (host.hostTerminal !== true) throw new DomainError(API_ERRORS.hostTerminalOff);
    return { user: host.kind === HOST_KIND.ssh ? (host.sshUser ?? HOST_TERMINAL_ROOT) : HOST_TERMINAL_ROOT };
  }

  /** The owner adding an app to a host whose runner can, and whose .env lets it. */
  requireHostDeploy(hostId: string, userId: string) {
    this.requireHostAdmin(hostId, userId);
    const host = this.databaseHandle.database.select().from(hosts).where(eq(hosts.id, hostId)).get();
    if (host?.hostDeploy !== true) throw new DomainError(API_ERRORS.hostDeployOff);
  }

  /** The owner looking at a host still enrolled here. */
  requireHostAdmin(hostId: string, userId: string) {
    this.owner.require(userId);
    const host = this.databaseHandle.database.select().from(hosts).where(eq(hosts.id, hostId)).get();
    if (host === undefined || host.status === HOST_STATUS_REVOKED) throw new DomainError(API_ERRORS.hostNotFound);
  }

  /** The container a shell, its files or an edit reach, once every guard let it; refused otherwise. */
  require(hostId: string, containerName: string, userId: string): ContainerView {
    this.owner.require(userId);
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
