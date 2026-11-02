import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { API_ERRORS } from "../../shared/api.js";
import { AUDIT_ACTIONS, HOST_STATUS_ACTIVE } from "../../shared/constants.js";
import {
  MAINTENANCE_LIMITS,
  MAINTENANCE_MAX_MILLISECONDS,
  type MaintenancePolicy,
  type MaintenanceView,
} from "../../shared/maintenance.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { hosts, maintenanceRevision, maintenanceWindows } from "../database/schema.js";
import { DomainError } from "../domain-error.js";

/** Bounded, expiring suppression. Normal policy, telemetry and incident evidence are never changed. */
export class MaintenanceService {
  constructor(
    private readonly handle: DatabaseHandle,
    private readonly audit: AuditLog,
    private readonly clock = Date.now,
  ) {}
  private get database() {
    return this.handle.database;
  }
  private host(hostId: string) {
    const host = this.database.select().from(hosts).where(eq(hosts.id, hostId)).get();
    if (!host) throw new DomainError(API_ERRORS.hostNotFound);
    if (host.status !== HOST_STATUS_ACTIVE) throw new DomainError(API_ERRORS.hostRevoked);
    return host;
  }
  view(hostId?: string): MaintenanceView {
    if (hostId) this.host(hostId);
    const now = this.clock();
    return {
      acknowledged: Object.fromEntries(
        this.database
          .select({ id: hosts.id, generation: hosts.maintenanceGeneration, at: hosts.lastHeartbeatAt })
          .from(hosts)
          .where(eq(hosts.status, HOST_STATUS_ACTIVE))
          .all()
          .map(({ id, ...state }) => [id, state]),
      ),
      generation: this.database.select().from(maintenanceRevision).get()!.generation,
      windows: this.database
        .select()
        .from(maintenanceWindows)
        .where(and(gt(maintenanceWindows.expiresAt, now), hostId ? eq(maintenanceWindows.hostId, hostId) : undefined))
        .all(),
    };
  }
  forRunner(hostId: string): MaintenancePolicy {
    const view = this.view(hostId);
    return {
      generation: view.generation,
      observedAt: this.clock(),
      windows: view.windows.map(({ containerName, startsAt, expiresAt }) => ({ containerName, startsAt, expiresAt })),
    };
  }
  held(hostId: string, containerName: string) {
    const now = this.clock();
    return (
      this.database
        .select({ id: maintenanceWindows.id })
        .from(maintenanceWindows)
        .where(
          and(
            eq(maintenanceWindows.hostId, hostId),
            gt(maintenanceWindows.expiresAt, now),
            containerName === ""
              ? undefined
              : or(isNull(maintenanceWindows.containerName), eq(maintenanceWindows.containerName, containerName)),
          ),
        )
        .get() !== undefined
    );
  }
  create(actor: Actor, hostId: string, change: { containerName: string | null; reason: string; expiresAt: number }) {
    const host = this.host(hostId);
    // Runners acknowledge support before windows can be offered as effective suppression.
    if (host.maintenanceGeneration === null) throw new DomainError(API_ERRORS.maintenanceUnsupported);
    const now = this.clock();
    this.validExpiry(now, change.expiresAt);
    if (
      this.view(hostId).windows.length >= MAINTENANCE_LIMITS.windowsPerHost ||
      this.view().windows.length >= MAINTENANCE_LIMITS.windows
    )
      throw new DomainError(API_ERRORS.maintenanceFull);
    const id = randomUUID();
    this.database.transaction(() => {
      this.database.delete(maintenanceWindows).where(lt(maintenanceWindows.expiresAt, now)).run();
      this.database
        .insert(maintenanceWindows)
        .values({ id, hostId, ...change, owner: actor.username, startsAt: now })
        .run();
      this.changed(actor, hostId, id, AUDIT_ACTIONS.maintenanceCreated, change.expiresAt);
    });
    return this.view(hostId);
  }
  change(actor: Actor, hostId: string, id: string, expiresAt: number | null) {
    this.host(hostId);
    const window = this.database
      .select()
      .from(maintenanceWindows)
      .where(
        and(
          eq(maintenanceWindows.id, id),
          eq(maintenanceWindows.hostId, hostId),
          gt(maintenanceWindows.expiresAt, this.clock()),
        ),
      )
      .get();
    if (!window) throw new DomainError(API_ERRORS.maintenanceNotFound);
    if (expiresAt !== null) {
      this.validExpiry(window.startsAt, expiresAt);
      if (expiresAt <= window.expiresAt) throw new DomainError(API_ERRORS.invalidRequest);
    }
    this.database.transaction(() => {
      if (expiresAt === null) this.database.delete(maintenanceWindows).where(eq(maintenanceWindows.id, id)).run();
      else this.database.update(maintenanceWindows).set({ expiresAt }).where(eq(maintenanceWindows.id, id)).run();
      this.changed(
        actor,
        hostId,
        id,
        expiresAt === null ? AUDIT_ACTIONS.maintenanceCancelled : AUDIT_ACTIONS.maintenanceExtended,
        expiresAt,
      );
    });
    return this.view(hostId);
  }
  private validExpiry(startsAt: number, expiresAt: number) {
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= this.clock() ||
      expiresAt - startsAt > MAINTENANCE_MAX_MILLISECONDS
    )
      throw new DomainError(API_ERRORS.invalidRequest);
  }
  private changed(
    actor: Actor,
    hostId: string,
    id: string,
    action:
      | typeof AUDIT_ACTIONS.maintenanceCreated
      | typeof AUDIT_ACTIONS.maintenanceCancelled
      | typeof AUDIT_ACTIONS.maintenanceExtended,
    expiresAt: number | null,
  ) {
    this.database
      .update(maintenanceRevision)
      .set({ generation: sql`${maintenanceRevision.generation} + 1` })
      .run();
    this.audit.recordUserAction(actor, action, { kind: "host", id: hostId }, { windowId: id, expiresAt });
  }
}
