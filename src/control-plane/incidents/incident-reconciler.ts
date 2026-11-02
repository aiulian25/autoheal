import type { ContainerView, HostView, IncidentSummaryView } from "../../shared/api.js";
import {
  CONTAINER_STATE_RUNNING,
  HEALTH_STARTING,
  HEALTH_UNHEALTHY,
  HOST_STATE,
  INCIDENT_CLEAR_MILLISECONDS,
  INCIDENT_CLEARED,
  INCIDENT_OUTCOME_LOST_MILLISECONDS,
  INCIDENT_STATUS,
} from "../../shared/constants.js";
import type { InventoryService } from "../inventory/inventory-service.js";
import { logAlertNotQueued, type Notifier } from "../notifications/notifier.js";
import type { IncidentsService } from "./incidents-service.js";

export interface IncidentReconcilerDependencies {
  incidents: Pick<IncidentsService, "list" | "settleUnneeded" | "askAfterLostOutcome">;
  inventory: Pick<InventoryService, "hosts" | "containers">;
  notifier: Pick<Notifier, "incidentCleared">;
  clock?: () => number;
}

// Running and not failing its health check: nothing a person would still have to decide about.
export const isFine = (container: ContainerView) =>
  container.state === CONTAINER_STATE_RUNNING &&
  container.health !== HEALTH_UNHEALTHY &&
  container.health !== HEALTH_STARTING;

// Only a host reporting now, and since the escalation, says how its containers are after it.
const reportedSince = (host: HostView | undefined, incident: IncidentSummaryView): host is HostView =>
  host?.state === HOST_STATE.online && (host.lastHeartbeatAt ?? 0) > incident.updatedAt;

/**
 * An escalation settles itself once nothing is left to decide: its container has been gone, or running and not
 * unhealthy, for INCIDENT_CLEAR_MILLISECONDS of its host's reports. When each was first seen so is kept in memory,
 * as the detectors keep theirs: after a restart the wait starts over.
 */
export class IncidentReconciler {
  private readonly fineSince = new Map<string, number>();

  constructor(private readonly dependencies: IncidentReconcilerDependencies) {}

  reset() {
    this.fineSince.clear();
  }

  async run() {
    const { incidents, inventory } = this.dependencies;
    const now = (this.dependencies.clock ?? Date.now)();
    const hosts = new Map(inventory.hosts().map((host) => [host.id, host]));
    // ponytail: only time tells a lost outcome from a slow repair; a runner's restart count would say it sooner.
    const lost = incidents
      .list({ status: INCIDENT_STATUS.decided })
      .filter(
        (incident) =>
          now - incident.updatedAt >= INCIDENT_OUTCOME_LOST_MILLISECONDS &&
          reportedSince(hosts.get(incident.hostId), incident),
      );
    for (const incident of lost) incidents.askAfterLostOutcome(incident.id);
    const waiting = incidents.list({ status: INCIDENT_STATUS.awaitingApproval });
    for (const incident of waiting) {
      await this.reconcile(incident, hosts.get(incident.hostId), now);
    }
    const stillWaiting = new Set(waiting.map((incident) => incident.id));
    for (const incidentId of [...this.fineSince.keys()].filter((candidate) => !stillWaiting.has(candidate))) {
      this.fineSince.delete(incidentId);
    }
  }

  private async reconcile(incident: IncidentSummaryView, host: HostView | undefined, now: number) {
    if (!reportedSince(host, incident)) {
      this.fineSince.delete(incident.id);
      return;
    }
    const container =
      this.dependencies.inventory
        .containers({ hostId: host.id })
        .find((candidate) => candidate.name === incident.containerName) ?? null;
    if (container !== null && !isFine(container)) {
      this.fineSince.delete(incident.id);
      return;
    }
    const firstSeen = this.fineSince.get(incident.id) ?? now;
    this.fineSince.set(incident.id, firstSeen);
    // Docker restarting it since starts the wait over.
    const since = Math.max(firstSeen, container?.startedAt ?? 0);
    if (now - since < INCIDENT_CLEAR_MILLISECONDS) {
      return;
    }
    this.fineSince.delete(incident.id);
    const outcome =
      container === null
        ? INCIDENT_CLEARED.gone(incident.containerName, host.label)
        : INCIDENT_CLEARED.running(incident.containerName);
    if (this.dependencies.incidents.settleUnneeded(incident.id, outcome) !== null) {
      await this.dependencies.notifier.incidentCleared(host.label, incident, outcome).catch(logAlertNotQueued);
    }
  }
}
