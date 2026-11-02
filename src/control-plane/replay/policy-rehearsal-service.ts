import { and, desc, eq, gte, lte, inArray } from "drizzle-orm";
import { API_ERRORS } from "../../shared/api.js";
import { MAX_RESTARTS_PER_WINDOW } from "../../shared/constants.js";
import {
  simulateRecovery,
  policyRehearsalRequestSchema,
  type PolicyRehearsalContext,
  type PolicyRehearsalRequest,
  type PolicyRehearsalResult,
  type RehearsalEvent,
} from "../../shared/recovery-policy-simulator.js";
import type { DatabaseHandle } from "../database/connection.js";
import { containerControls, incidents } from "../database/schema.js";
import { DomainError } from "../domain-error.js";
import type { HostControlService } from "../host-control/host-control-service.js";
import type { InventoryService } from "../inventory/inventory-service.js";
import type { MaintenanceService } from "../maintenance/maintenance-service.js";

export interface PolicyRehearsalDependencies {
  databaseHandle: DatabaseHandle;
  hostControl: Pick<HostControlService, "view">;
  inventory: Pick<InventoryService, "hosts" | "containers">;
  maintenance: Pick<MaintenanceService, "forRunner">;
  clock?: () => number;
}
/** Reads captured evidence and controls only; has no job, model, Docker or policy-write dependency. */
export class PolicyRehearsalService {
  private readonly clock: () => number;
  constructor(private readonly dependencies: PolicyRehearsalDependencies) {
    this.clock = dependencies.clock ?? Date.now;
  }
  context(hostId: string): PolicyRehearsalContext {
    const host = this.dependencies.inventory.hosts().find((candidate) => candidate.id === hostId);
    if (!host) throw new DomainError(API_ERRORS.hostNotFound);
    const control = this.dependencies.hostControl.view(hostId);
    const currentContainers = this.dependencies.inventory.containers({ hostId });
    const explicit = new Set(
      this.dependencies.databaseHandle.database
        .select({ name: containerControls.containerName })
        .from(containerControls)
        .where(
          and(
            eq(containerControls.hostId, hostId),
            inArray(
              containerControls.containerName,
              currentContainers.map(({ name }) => name),
            ),
          ),
        )
        .all()
        .map(({ name }) => name),
    );
    return {
      hostId,
      hostLabel: host.label,
      now: this.clock(),
      restartDefault: control.restartDefault,
      dryRun: host.dryRun !== false,
      lastHeartbeatAt: host.lastHeartbeatAt,
      containers: currentContainers
        .map((container) => ({
          name: container.name,
          restart: container.byItself.restart,
          inherited: !explicit.has(container.name) && container.byItself.restartLock === null,
          protected: container.protected,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      restartBudget: host.restartBudget,
      protectedContainers: host.protectedContainers,
      maintenance: this.dependencies.maintenance.forRunner(hostId).windows,
    };
  }
  rehearse(value: PolicyRehearsalRequest): PolicyRehearsalResult {
    const request = policyRehearsalRequestSchema.parse(value);
    const context = this.context(request.hostId);
    const captured =
      request.source === "history"
        ? this.dependencies.databaseHandle.database
            .select({ id: incidents.id, name: incidents.containerName, at: incidents.detectedAt })
            .from(incidents)
            .where(
              and(
                eq(incidents.hostId, request.hostId),
                gte(incidents.createdAt, this.clock() - 7 * 86_400_000),
                lte(incidents.createdAt, this.clock()),
              ),
            )
            .orderBy(desc(incidents.createdAt), desc(incidents.id))
            .limit(500)
            .all()
            .filter(({ at }) => at >= this.clock() - 7 * 86_400_000 && at <= this.clock())
            .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
        : [];
    const events: RehearsalEvent[] =
      request.source === "history" ? captured.map(({ name, at }) => ({ name, at, kind: "failure" })) : request.events!;
    if (events.length === 0) throw new DomainError(API_ERRORS.invalidRequest);
    const startedAt = Math.min(...events.map(({ at }) => at));
    const current = Object.fromEntries(context.containers.map((container) => [container.name, container.restart]));
    const proposed = Object.fromEntries(
      context.containers.map((container) => [
        container.name,
        container.inherited ? request.proposedRestartDefault : container.restart,
      ]),
    );
    const eventNames = [
      ...new Set(
        events.flatMap((event) =>
          "name" in event ? [event.name, ...(event.kind === "failure" && event.target ? [event.target] : [])] : [],
        ),
      ),
    ];
    if (eventNames.length) {
      for (const saved of this.dependencies.databaseHandle.database
        .select({ name: containerControls.containerName, restart: containerControls.restartChoice })
        .from(containerControls)
        .where(and(eq(containerControls.hostId, request.hostId), inArray(containerControls.containerName, eventNames)))
        .all()) {
        if (!Object.hasOwn(current, saved.name)) {
          current[saved.name] = saved.restart;
          proposed[saved.name] = saved.restart;
        }
      }
    }
    const base = {
      startedAt,
      protectedContainers: context.protectedContainers,
      dryRun: context.dryRun,
      maintenance: context.maintenance,
      groups: request.groups,
      events,
      initial:
        request.source === "history"
          ? []
          : Object.entries(context.restartBudget).map(([name, count]) => ({
              name,
              lastKill: null,
              lastHandled: null,
              restartTimes: Array.from(
                { length: Math.min(MAX_RESTARTS_PER_WINDOW, Math.max(0, count)) },
                () => startedAt / 1000,
              ),
            })),
    };
    const result: PolicyRehearsalResult = {
      hostId: request.hostId,
      source: request.source,
      change: {
        before: context.restartDefault,
        after: request.proposedRestartDefault,
        containers: context.containers
          .filter((container) => container.restart !== proposed[container.name])
          .map((container) => ({ name: container.name, before: container.restart, after: proposed[container.name]! })),
      },
      current: simulateRecovery({ ...base, restartDefault: context.restartDefault, containers: current }),
      proposed: simulateRecovery({ ...base, restartDefault: request.proposedRestartDefault, containers: proposed }),
      evidence: {
        incidentIds: captured.map(({ id }) => id),
        assumptions:
          request.source === "history"
            ? [
                "Saved failures from the last seven days are replayed under today's controls, not the historical policy.",
                "The historical budget starts empty because precise earlier restart/stop/lock/outage state is not captured. This is a counterfactual, not an authoritative reconstruction.",
                "Only currently retained maintenance windows are available; missing historical suppression or manual actions can change real outcomes.",
              ]
            : [
                "Current reported restart counts are seeded at the scenario start, conservatively retaining each credit for a full hour because exact timestamps are not reported.",
                "Earlier cooldowns and deliberate stops are unknown; add planned stops/operations explicitly to the scenario.",
              ],
      },
    };
    return result;
  }
}
