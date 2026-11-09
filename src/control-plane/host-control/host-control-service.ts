import { isLeftBehind } from "../../shared/networks.js";
import type { MaintenanceService } from "../maintenance/maintenance-service.js";
import { and, eq } from "drizzle-orm";
import {
  API_ERRORS,
  type ContainerControlChange,
  givenToOllama,
  type ContainerView,
  type HostControlChange,
  type HostControlView,
  type HostUpdateSettingsView,
  type HostView,
  type IgnoredVersionChange,
  type JobView,
} from "../../shared/api.js";
import {
  AGENT_AUTOHEAL,
  AUDIT_ACTIONS,
  FALLBACK_TIME_ZONE,
  HOST_STATE,
  IGNORE_EVERY_VERSION,
  IMAGE_TAG_PATTERN,
  JOB_ACTION,
  JOB_STATUS,
  MILLISECONDS_PER_SECOND,
  RESTART_CHOICE,
  RESTART_WINDOW_SECONDS,
  TARGET_HOST,
  type ImageCleanup,
} from "../../shared/constants.js";
import { describeError } from "../../shared/errors.js";
import { log } from "../../shared/log.js";
import type { HostControl } from "../../shared/protocol.js";
import { wallClock } from "../../shared/time-zones.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { DatabaseHandle } from "../database/connection.js";
import { containerControls, hosts, ignoredVersions, jobs } from "../database/schema.js";
import { DomainError } from "../domain-error.js";
import type { HostRow } from "../hosts/hosts-service.js";
import { insideWindow } from "../host-packages/host-packages-service.js";
import type { InventoryService } from "../inventory/inventory-service.js";
import { jobViews } from "../jobs/job-views.js";
import type { JobsService } from "../jobs/jobs-service.js";
import type { TaskAuthor } from "../tasks/tasks-service.js";
import { cleansOn, nextCleanupAt } from "./host-control.js";

// An admin's resets within the hour: an older one is moot, since the restarts it cleared have left the window.
function recentResets(host: HostRow, now: number): Record<string, number> {
  const resets = Object.entries(JSON.parse(host.restartResetsJson) as Record<string, number>);
  return Object.fromEntries(resets.filter(([, at]) => now - at < RESTART_WINDOW_SECONDS * MILLISECONDS_PER_SECOND));
}

export interface HostControlDependencies {
  maintenance?: Pick<MaintenanceService, "forRunner" | "held">;
  databaseHandle: DatabaseHandle;
  auditLog: AuditLog;
  inventory: Pick<InventoryService, "hosts" | "containers" | "networks">;
  jobs: Pick<JobsService, "request">;
  // Each host's nightly window, from Settings → System → Host updates.
  window: () => HostUpdateSettingsView;
  clock?: () => number;
}

const AUTOHEAL: TaskAuthor = { kind: "agent", agent: AGENT_AUTOHEAL };
const OPEN_JOB_STATUSES: readonly string[] = [JOB_STATUS.pending, JOB_STATUS.delivered];
const timeZoneOf = (host: HostView | undefined) => host?.health?.packages?.timeZone ?? FALLBACK_TIME_ZONE;

// A tick the host's .env, the container's label or the database rule fixes can't be set from the page.
const lockedFor = (change: ContainerControlChange, container: ContainerView) =>
  (change.restart !== undefined && container.byItself.restartLock !== null) ||
  (change.update !== undefined && container.byItself.updateLock !== null);

/**
 * What each host's page lets Autoheal do there on its own: a container's ticks, the ticks a container
 * that appears later takes, and when the images no container uses are removed. The host's .env still
 * has the last word: a host that only watches changes nothing, and protected containers take no tick.
 */
export class HostControlService {
  private readonly clock: () => number;

  constructor(private readonly dependencies: HostControlDependencies) {
    this.clock = dependencies.clock ?? Date.now;
  }

  private get database() {
    return this.dependencies.databaseHandle.database;
  }

  /** How often the host's page lets Autoheal clean its unused images; "off" when it does not. */
  imageCleanupOf(hostId: string): ImageCleanup {
    return this.hostRow(hostId).imageCleanup;
  }

  private hostRow(hostId: string) {
    const host = this.database.select().from(hosts).where(eq(hosts.id, hostId)).get();
    if (host === undefined) {
      throw new DomainError(API_ERRORS.hostNotFound);
    }
    return host;
  }

  /**
   * An admin clears a container's restarts this hour and Autoheal's wait on it; the limits stay. Its runner hears
   * of it with its next answer, so only a runner that reports its waits, and so takes a reset, is asked.
   */
  resetRestarts(actor: Actor, hostId: string, containerName: string) {
    const host = this.hostRow(hostId);
    if (host.restartWaitJson === null) {
      throw new DomainError(API_ERRORS.restartResetUnsupported);
    }
    if (!this.dependencies.inventory.containers({ hostId }).some((container) => container.name === containerName)) {
      throw new DomainError(API_ERRORS.containerNotFound);
    }
    const now = this.clock();
    const resets = { ...recentResets(host, now), [containerName]: now };
    this.database
      .update(hosts)
      .set({ restartResetsJson: JSON.stringify(resets) })
      .where(eq(hosts.id, hostId))
      .run();
    this.dependencies.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.restartsReset,
      { kind: TARGET_HOST, id: hostId },
      { containerName },
    );
  }

  private hostView(hostId: string): HostView | undefined {
    return this.dependencies.inventory.hosts().find((host) => host.id === hostId);
  }

  private lastCleanup(hostId: string): JobView | null {
    const condition = and(eq(jobs.hostId, hostId), eq(jobs.action, JOB_ACTION.pruneImages));
    return jobViews(this.dependencies.databaseHandle, condition, 1)[0] ?? null;
  }

  view(hostId: string): HostControlView {
    const host = this.hostRow(hostId);
    const timeZone = timeZoneOf(this.hostView(hostId));
    const lastCleanup = this.lastCleanup(hostId);
    // A host that only watches removes nothing, whatever its schedule says.
    const live = host.dryRun === false;
    const window = this.dependencies.window();
    const next = nextCleanupAt(host.imageCleanup, lastCleanup?.createdAt ?? null, timeZone, window, this.clock());
    return {
      hostId,
      restartDefault: host.restartDefault,
      updateDefault: host.updateDefault,
      imageCleanup: host.imageCleanup,
      clearBuildCache: host.clearBuildCache,
      clearLeftNetworks: host.clearLeftNetworks,
      nextCleanupAt: live ? next : null,
      timeZone,
      lastCleanup,
    };
  }

  save(actor: Actor, hostId: string, change: HostControlChange): HostControlView {
    this.hostRow(hostId);
    this.database.update(hosts).set(change).where(eq(hosts.id, hostId)).run();
    this.dependencies.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.hostControlSaved,
      { kind: TARGET_HOST, id: hostId },
      { ...change },
    );
    return this.view(hostId);
  }

  /** One tick for several containers at once: a container's, a stack's or every one's. */
  setContainers(actor: Actor, hostId: string, change: ContainerControlChange) {
    this.hostRow(hostId);
    const onHost = new Map(
      this.dependencies.inventory.containers({ hostId }).map((container) => [container.name, container]),
    );
    const names = [...new Set(change.names)];
    const chosen = names.flatMap((name) => onHost.get(name) ?? []);
    if (chosen.length !== names.length) {
      throw new DomainError(API_ERRORS.containerNotFound);
    }
    if (chosen.some((container) => lockedFor(change, container))) {
      throw new DomainError(API_ERRORS.controlLocked);
    }
    const changedAt = this.clock();
    for (const container of chosen) {
      const values = {
        hostId,
        containerName: container.name,
        restartChoice: change.restart ?? container.byItself.restart,
        updateChoice: change.update ?? container.byItself.update,
        changedAt,
      };
      this.database
        .insert(containerControls)
        .values(values)
        .onConflictDoUpdate({ target: [containerControls.hostId, containerControls.containerName], set: values })
        .run();
    }
    this.dependencies.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.containerControlSaved,
      { kind: TARGET_HOST, id: hostId },
      { ...change },
    );
  }

  /**
   * The newer versions a person ignores: one version (the next one shows again), every new version of a container,
   * or none any more. An ignored version gets no task, no badge and nothing on Attention.
   */
  ignoreVersions(actor: Actor, hostId: string, changes: readonly IgnoredVersionChange[]) {
    this.hostRow(hostId);
    const onHost = new Set(this.dependencies.inventory.containers({ hostId }).map(({ name }) => name));
    const valid = ({ container, version }: IgnoredVersionChange) =>
      onHost.has(container) &&
      (version === null || version === IGNORE_EVERY_VERSION || IMAGE_TAG_PATTERN.test(version));
    if (!changes.every(valid)) {
      throw new DomainError(API_ERRORS.containerNotFound);
    }
    const ignoredAt = this.clock();
    for (const { container, version } of changes) {
      const row = and(eq(ignoredVersions.hostId, hostId), eq(ignoredVersions.containerName, container));
      if (version === null) {
        this.database.delete(ignoredVersions).where(row).run();
        continue;
      }
      const values = { hostId, containerName: container, version, ignoredBy: actor.username, ignoredAt };
      this.database
        .insert(ignoredVersions)
        .values(values)
        .onConflictDoUpdate({ target: [ignoredVersions.hostId, ignoredVersions.containerName], set: values })
        .run();
    }
    this.dependencies.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.versionsIgnored,
      { kind: TARGET_HOST, id: hostId },
      { changes: changes.map((change) => ({ ...change })) },
    );
  }

  /**
   * What the host's runner needs: sent back with each heartbeat, so it holds while the dashboard is away. To its
   * runner a container given to Ollama restarts as any other: what follows a restart that did not hold is the
   * dashboard's, so a runner from before it restarts it as before.
   */
  forRunner(hostId: string): HostControl {
    const host = this.hostRow(hostId);
    const containers = this.dependencies.inventory.containers({ hostId });
    const held = (name: string) => this.dependencies.maintenance?.held(hostId, name) ?? false;
    const whenFailing = (container: ContainerView) =>
      held(container.name)
        ? RESTART_CHOICE.ignore
        : container.byItself.restart === RESTART_CHOICE.repair
          ? RESTART_CHOICE.restart
          : container.byItself.restart;
    // Only "restart" restarts: a runner from before telling and going unwatched asks first instead.
    return {
      ...(this.dependencies.maintenance && host.maintenanceGeneration !== null
        ? { maintenance: this.dependencies.maintenance.forRunner(hostId) }
        : {}),
      restartByDefault: !held("") && host.restartDefault === RESTART_CHOICE.restart,
      restart: Object.fromEntries(
        containers.map((container) => [container.name, whenFailing(container) === RESTART_CHOICE.restart]),
      ),
      whenFailingByDefault: held("") ? RESTART_CHOICE.ignore : host.restartDefault,
      whenFailing: Object.fromEntries(containers.map((container) => [container.name, whenFailing(container)])),
      undoFailedUpdates: containers
        .filter((container) => !held(container.name) && givenToOllama(container))
        .map((container) => container.name),
      clearBuildCache: host.clearBuildCache,
      restartsResetAt: recentResets(host, this.clock()),
    };
  }

  /** Each minute: a host whose clean-up is due gets it, once, in its own nightly window. */
  tick() {
    const window = this.dependencies.window();
    const now = this.clock();
    for (const host of this.dependencies.inventory.hosts()) {
      try {
        this.cleanUpIfDue(host, window, now);
      } catch (error) {
        log(describeError(error));
      }
    }
  }

  // Only what Compose made and left; the runner looks again before removing, and skips what a stopped container needs.
  private clearLeftNetworks(hostId: string) {
    if (!this.hostRow(hostId).clearLeftNetworks) return;
    const names = (this.dependencies.inventory.networks(hostId) ?? []).filter(isLeftBehind).map(({ name }) => name);
    if (names.length === 0) return;
    const removal = { names, evenIfStoppedNeedIt: false };
    this.dependencies.jobs.request(AUTOHEAL, hostId, "", JOB_ACTION.removeNetworks, null, { removal });
  }

  private cleanUpIfDue(host: HostView, window: HostUpdateSettingsView, now: number) {
    const timeZone = timeZoneOf(host);
    const live = host.state === HOST_STATE.online && host.dryRun === false;
    if (!live || !insideWindow(window, timeZone, now)) {
      return;
    }
    const last = this.lastCleanup(host.id);
    const waiting = last !== null && OPEN_JOB_STATUSES.includes(last.status);
    const due = cleansOn(this.hostRow(host.id).imageCleanup, wallClock(now, timeZone), now, last?.createdAt ?? null);
    if (due && !waiting) {
      this.dependencies.jobs.request(AUTOHEAL, host.id, "", JOB_ACTION.pruneImages, null);
      this.clearLeftNetworks(host.id);
    }
  }
}
