import {
  API_ERRORS,
  hasUpdate,
  type AgentDispatchRequest,
  type AgentDispatchView,
  type AssigneeChoice,
  type ContainerView,
  type HostView,
} from "../../shared/api.js";
import {
  AGENT_AUTOHEAL,
  AUDIT_ACTIONS,
  AUTOHEAL_TEXT,
  HOST_STATE,
  INCIDENT_STATUS,
  JOB_ACTION,
  OPEN_TASK_STATUSES,
  TARGET_CONTAINER,
  TARGET_HOST,
  TARGET_INCIDENT,
  TASK_ACTIVITY,
  TASK_LABEL,
  TASK_RESOURCE,
  TRACE,
} from "../../shared/constants.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import { DomainError } from "../domain-error.js";
import { osUpdatesKey, type HostPackagesService } from "../host-packages/host-packages-service.js";
import type { IncidentsService } from "../incidents/incidents-service.js";
import type { InventoryService } from "../inventory/inventory-service.js";
import type { TaskAuthor, TaskRow, TasksService } from "../tasks/tasks-service.js";

export interface DispatchDependencies {
  tasks: Pick<TasksService, "find" | "change" | "addActivity" | "comment" | "openFor" | "setByAutoheal">;
  incidents: Pick<IncidentsService, "find" | "addEvent">;
  inventory: Pick<InventoryService, "hosts" | "containers">;
  hostPackages: Pick<HostPackagesService, "requireUpgrade" | "request">;
  auditLog: Pick<AuditLog, "recordUserAction">;
  // The agents that take what was handed over, asked to look now rather than at their next pass.
  wake: () => void;
}

const AUTOHEAL: TaskAuthor = { kind: "agent", agent: AGENT_AUTOHEAL };
const TO_AUTOHEAL: AssigneeChoice = { kind: "agent", id: AGENT_AUTOHEAL };

interface UpdateHandOver {
  task: TaskRow;
  container: ContainerView;
}

const isOpen = (task: TaskRow) => (OPEN_TASK_STATUSES as readonly string[]).includes(task.status);
const isContainerUpdate = (task: TaskRow) =>
  (JSON.parse(task.labelsJson) as string[]).includes(TASK_LABEL.update) &&
  task.resourceKind === TASK_RESOURCE.container;

// The same host named twice is one upgrade of every package named for it.
function packagesByHost(request: AgentDispatchRequest): Map<string, string[]> {
  const byHost = new Map<string, Set<string>>();
  for (const { hostId, names } of request.packages) {
    byHost.set(hostId, new Set([...(byHost.get(hostId) ?? []), ...names]));
  }
  return new Map([...byHost].map(([hostId, names]) => [hostId, [...names]]));
}

/**
 * A person handing work to the Ollama agent: image updates, a host's packages, escalated incidents. The agent does
 * them whatever held them for a person (Ollama's own hold, the database rule, the package rules, ask first); the
 * host's .env still decides, so a hand-over its runner would refuse is refused here, before anything changes.
 */
export class DispatchService {
  constructor(private readonly dependencies: DispatchDependencies) {}

  dispatch(actor: Actor, request: AgentDispatchRequest): AgentDispatchView {
    // Each once, however often it was dragged.
    const updates = [...new Set(request.updates)].map((taskId) => this.updateOf(taskId));
    const packages = packagesByHost(request);
    for (const [hostId, names] of packages) {
      this.requirePackages(hostId, names);
    }
    const incidents = [...new Set(request.incidents)].map((incidentId) => this.requireIncident(incidentId));
    updates.forEach((handOver) => this.handOverUpdate(actor, handOver));
    packages.forEach((names, hostId) => this.handOverPackages(actor, hostId, names));
    incidents.forEach((incidentId) => this.handOverIncident(actor, incidentId));
    this.dependencies.wake();
    return {
      updates: updates.length,
      packages: [...packages.values()].reduce((sum, names) => sum + names.length, 0),
      incidents: incidents.length,
    };
  }

  // --- what may be handed over ---------------------------------------------------------------------

  private hostOf(hostId: string): HostView {
    const host = this.dependencies.inventory.hosts().find((candidate) => candidate.id === hostId);
    if (host === undefined) {
      throw new DomainError(API_ERRORS.hostNotFound);
    }
    return host;
  }

  // On the host as it reported last, and one Autoheal may change: not protected, kept aside, nor in dry-run.
  private changeableContainer(hostId: string, name: string): ContainerView {
    const container = this.dependencies.inventory.containers({ hostId }).find((candidate) => candidate.name === name);
    if (container === undefined) {
      throw new DomainError(API_ERRORS.containerNotFound);
    }
    if (container.handsOff !== null) {
      throw new DomainError(API_ERRORS.handsOff);
    }
    return container;
  }

  private updateOf(taskId: string): UpdateHandOver {
    const task = this.dependencies.tasks.find(taskId);
    if (!isOpen(task) || !isContainerUpdate(task) || task.hostId === null || task.resourceId === null) {
      throw new DomainError(API_ERRORS.notDispatchable);
    }
    const container = this.changeableContainer(task.hostId, task.resourceId);
    if (!hasUpdate(container)) {
      throw new DomainError(API_ERRORS.noUpdate);
    }
    return { task, container };
  }

  private requirePackages(hostId: string, names: readonly string[]) {
    if (this.hostOf(hostId).dryRun !== false) {
      throw new DomainError(API_ERRORS.notDispatchable);
    }
    this.dependencies.hostPackages.requireUpgrade(hostId, names);
  }

  // Waiting for a person, on a host that acts now: Ollama repairs only what its runner can change.
  private requireIncident(incidentId: string): string {
    const incident = this.dependencies.incidents.find(incidentId);
    if (incident.status !== INCIDENT_STATUS.awaitingApproval) {
      throw new DomainError(API_ERRORS.notAwaitingApproval);
    }
    const host = this.hostOf(incident.hostId);
    if (host.state !== HOST_STATE.online || host.dryRun !== false) {
      throw new DomainError(API_ERRORS.notDispatchable);
    }
    this.changeableContainer(host.id, incident.containerName);
    return incident.id;
  }

  // --- handing over ---------------------------------------------------------------------------------

  private handOverUpdate(actor: Actor, { task, container }: UpdateHandOver) {
    const { tasks, auditLog } = this.dependencies;
    tasks.change(actor, task.id, { assignee: TO_AUTOHEAL });
    tasks.addActivity(task.id, TASK_ACTIVITY.dispatched, { kind: "user", actor }, {});
    tasks.comment(AUTOHEAL, task.id, AUTOHEAL_TEXT.dispatched(actor.username));
    auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.agentDispatched,
      { kind: TARGET_CONTAINER, id: `${container.hostId}/${container.name}` },
      { update: container.name },
    );
  }

  // The host's OS updates task follows the upgrade: its end hands the task back, and Ollama reports on a failure.
  private handOverPackages(actor: Actor, hostId: string, names: readonly string[]) {
    const { tasks, hostPackages, auditLog } = this.dependencies;
    const task = tasks.openFor(osUpdatesKey(hostId));
    if (task !== null) {
      tasks.setByAutoheal(task.id, { assignee: TO_AUTOHEAL });
      tasks.addActivity(task.id, TASK_ACTIVITY.dispatched, { kind: "user", actor }, { packages: names });
      tasks.comment(AUTOHEAL, task.id, AUTOHEAL_TEXT.packagesDispatched(actor.username, names));
    }
    hostPackages.request(AUTOHEAL, hostId, JOB_ACTION.upgradePackages, names, task?.id ?? null);
    auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.agentDispatched,
      { kind: TARGET_HOST, id: hostId },
      { packages: [...names] },
    );
  }

  private handOverIncident(actor: Actor, incidentId: string) {
    this.dependencies.incidents.addEvent(incidentId, TRACE.dispatched, { by: actor.username });
    this.dependencies.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.agentDispatched,
      { kind: TARGET_INCIDENT, id: incidentId },
      {},
    );
  }
}
