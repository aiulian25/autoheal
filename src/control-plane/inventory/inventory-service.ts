import type { VolumeReport } from "../../shared/volumes.js";
import type { NetworkReport } from "../../shared/networks.js";
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, type SQL } from "drizzle-orm";
import {
  API_ERRORS,
  UNKNOWN_HOME_ASSISTANT_SYSTEM,
  hasUpdate,
  type ContainerView,
  type HomeAssistantView,
  type HostChangeView,
  type HostImagesView,
  type HostNetworksView,
  type HostVolumesView,
  type HostPowerView,
  type HostView,
  type SshConnectionView,
  type SshSessionReport,
  type OverviewView,
} from "../../shared/api.js";
import {
  CONTAINER_STATE_RUNNING,
  HOST_CHANGE_RETENTION_MILLISECONDS,
  HOST_KIND,
  HOST_STATE,
  HOST_STATUS_REVOKED,
  JOB_ACTION,
  SSH_STATE,
  type HostChangeDetails,
} from "../../shared/constants.js";
import type { ContainerSnapshot, Heartbeat, HostHealth, UnusedImage } from "../../shared/protocol.js";
import type { DatabaseHandle } from "../database/connection.js";
import { containerControls, hostChanges, hosts, jobs } from "../database/schema.js";
import { DomainError } from "../domain-error.js";
import type { HomeAssistantConnection } from "../home-assistant/home-assistant-inventory.js";
import type { SavedControl } from "../host-control/host-control.js";
import type { HostRow } from "../hosts/hosts-service.js";
import { jobViews } from "../jobs/job-views.js";
import { changesBetween } from "./host-changes.js";
import { containerViewsOf, isCounted, toHostView } from "./host-views.js";
import type { MetricsStore } from "./metrics-store.js";

interface ContainerFilter {
  hostId?: string | undefined;
  problemsOnly?: boolean | undefined;
  search?: string | undefined;
}

const matches = (container: ContainerView, search: string) =>
  [container.name, container.image, container.hostLabel, container.composeProject ?? ""].some((field) =>
    field.toLowerCase().includes(search),
  );

// Problems first, then by host and name, so what needs attention is at the top of every list.
const byProblemThenName = (first: ContainerView, second: ContainerView) =>
  Number(second.problem !== null) - Number(first.problem !== null) ||
  first.hostLabel.localeCompare(second.hostLabel) ||
  first.name.localeCompare(second.name);

const countOf = <Item>(items: readonly Item[], predicate: (item: Item) => boolean) => items.filter(predicate).length;

// What the host's runner said last time, to compare the new report with.
const previousReportOf = (host: HostRow) => ({
  containers: JSON.parse(host.containersJson) as ContainerSnapshot[],
  health: host.healthJson === null ? null : (JSON.parse(host.healthJson) as HostHealth),
});

const NOT_CONFIGURED: HomeAssistantView = {
  status: { configured: false, connected: false, version: null, error: null, connectedSince: null },
  system: UNKNOWN_HOME_ASSISTANT_SYSTEM,
  zigbee: [],
  safety: [],
  watched: [],
  entities: 0,
  unavailableEntities: 0,
};

/** Everything Autoheal watches: what each runner last reported, and what Home Assistant knows. */
export class InventoryService {
  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly metrics: MetricsStore,
    private readonly homeAssistantInventory: Pick<HomeAssistantConnection, "view" | "summary"> | null = null,
    private readonly clock: () => number = Date.now,
    // An SSH host's session, as the control plane holds it now.
    private readonly sshConnectionOf: (hostId: string) => SshConnectionView | null = () => null,
    // The control plane's own machine, looked after in place: why its runner has not started, if it has not.
    private readonly inPlaceOf: (hostId: string) => { problem: string | null } | null = () => null,
    // A reboot or a shutdown a person asked for, while it is followed.
    private readonly powerOf: (host: HostRow) => HostPowerView | null = () => null,
  ) {}

  /**
   * Every report replaces the previous one: a full picture each time, so nothing drifts. What changed since
   * the last one goes into the host's journal, which keeps two weeks.
   */
  recordHeartbeat(host: HostRow, heartbeat: Heartbeat) {
    // An SSH host's runner lives in the control plane and beats on while its host is down: without its session the
    // beat says nothing of the host, which goes quiet as any other would.
    const unreachable = host.kind === HOST_KIND.ssh && this.sshConnectionOf(host.id)?.state !== SSH_STATE.connected;
    if (unreachable) return;
    const at = this.clock();
    const reported = {
      lastHeartbeatAt: at,
      runnerVersion: heartbeat.runnerVersion,
      dryRun: heartbeat.dryRun,
      eventStreamConnected: heartbeat.eventStreamConnected,
      protectedContainersJson: JSON.stringify(heartbeat.protectedContainers),
      applicationBackups: heartbeat.applicationBackups === true,
      rollouts: heartbeat.rollouts === true,
      operationPreviews: heartbeat.operationPreviews === true,
      ...(heartbeat.topology === undefined ? {} : { topologyJson: JSON.stringify(heartbeat.topology) }),
      resourcePermissions: heartbeat.resourcePermissions === true,
      serviceProbes: heartbeat.serviceProbes === true,
      maintenanceGeneration: heartbeat.maintenanceGeneration ?? null,
      restartBudgetJson: JSON.stringify(heartbeat.restartBudget),
      recoveryHoldJson: heartbeat.recoveryHold ? JSON.stringify(heartbeat.recoveryHold) : null,
      restartWaitJson: heartbeat.restartWait === undefined ? null : JSON.stringify(heartbeat.restartWait),
      containersJson: JSON.stringify(heartbeat.containers),
      containerAccess: heartbeat.containerAccess ?? false,
      hostTerminal: heartbeat.hostTerminal ?? null,
      hostDeploy: heartbeat.hostDeploy ?? null,
      docker: heartbeat.docker ?? true,
    };
    // A host that could not be read this time keeps its last health instead of losing it; its images too.
    const health = heartbeat.host === null ? {} : { healthJson: JSON.stringify(heartbeat.host) };
    const images =
      heartbeat.unusedImages === undefined ? {} : { unusedImagesJson: JSON.stringify(heartbeat.unusedImages) };
    const networks = heartbeat.networks === undefined ? {} : { networksJson: JSON.stringify(heartbeat.networks) };
    const volumes = heartbeat.volumes === undefined ? {} : { volumesJson: JSON.stringify(heartbeat.volumes) };
    // A host's first report has nothing to compare with.
    const changes = host.lastHeartbeatAt === null ? [] : changesBetween(previousReportOf(host), heartbeat);
    this.databaseHandle.database.transaction((transaction) => {
      transaction
        .update(hosts)
        .set({ ...reported, ...health, ...images, ...networks, ...volumes })
        .where(eq(hosts.id, host.id))
        .run();
      const rows = changes.map((change) => ({
        hostId: host.id,
        at,
        kind: change.kind,
        containerName: change.containerName,
        detailsJson: JSON.stringify(change.details),
      }));
      if (rows.length > 0) {
        transaction.insert(hostChanges).values(rows).run();
      }
      transaction
        .delete(hostChanges)
        .where(and(eq(hostChanges.hostId, host.id), lt(hostChanges.at, at - HOST_CHANGE_RETENTION_MILLISECONDS)))
        .run();
    });
  }

  /** What changed on the host, newest first; one container's changes only when it is named. */
  changes(hostId: string, filter: { containerName?: string | undefined; limit: number }): HostChangeView[] {
    const conditions: SQL[] = [eq(hostChanges.hostId, hostId)];
    if (filter.containerName !== undefined) {
      conditions.push(eq(hostChanges.containerName, filter.containerName));
    }
    return this.changesWhere(and(...conditions), filter.limit);
  }

  /** The host's own changes and the named containers' since that moment, newest first: what a decision hears of. */
  recentChanges(hostId: string, names: ReadonlySet<string>, since: number, limit: number): HostChangeView[] {
    const concerned = or(isNull(hostChanges.containerName), inArray(hostChanges.containerName, [...names]));
    return this.changesWhere(and(eq(hostChanges.hostId, hostId), gte(hostChanges.at, since), concerned), limit);
  }

  private changesWhere(condition: SQL | undefined, limit: number): HostChangeView[] {
    return (
      this.databaseHandle.database
        .select()
        .from(hostChanges)
        .where(condition)
        // Newest report first; within one, as it was recorded: the host's own changes, then its containers'.
        .orderBy(desc(hostChanges.at), asc(hostChanges.id))
        .limit(limit)
        .all()
        .map((row) => ({
          id: row.id,
          at: row.at,
          kind: row.kind,
          containerName: row.containerName,
          details: JSON.parse(row.detailsJson) as HostChangeDetails,
        }))
    );
  }

  /** The images no container on the host uses, newest first; null until its runner reports them. */
  unusedImages(hostId: string): UnusedImage[] | null {
    const host = this.databaseHandle.database
      .select({ unusedImagesJson: hosts.unusedImagesJson })
      .from(hosts)
      .where(eq(hosts.id, hostId))
      .get();
    if (host === undefined) {
      throw new DomainError(API_ERRORS.hostNotFound);
    }
    return host.unusedImagesJson === null ? null : (JSON.parse(host.unusedImagesJson) as UnusedImage[]);
  }

  hostImages(hostId: string): HostImagesView {
    const removals = and(eq(jobs.hostId, hostId), eq(jobs.action, JOB_ACTION.removeImages));
    return {
      images: this.unusedImages(hostId),
      lastRemoval: jobViews(this.databaseHandle, removals, 1)[0] ?? null,
    };
  }

  networks(hostId: string): NetworkReport[] | null {
    const host = this.databaseHandle.database
      .select({ networksJson: hosts.networksJson })
      .from(hosts)
      .where(eq(hosts.id, hostId))
      .get();
    if (host === undefined) {
      throw new DomainError(API_ERRORS.hostNotFound);
    }
    return host.networksJson === null ? null : (JSON.parse(host.networksJson) as NetworkReport[]);
  }

  volumes(hostId: string): VolumeReport[] | null {
    const host = this.databaseHandle.database
      .select({ volumesJson: hosts.volumesJson })
      .from(hosts)
      .where(eq(hosts.id, hostId))
      .get();
    if (host === undefined) {
      throw new DomainError(API_ERRORS.hostNotFound);
    }
    return host.volumesJson === null ? null : (JSON.parse(host.volumesJson) as VolumeReport[]);
  }

  hostVolumes(hostId: string): HostVolumesView {
    const changes = and(
      eq(jobs.hostId, hostId),
      inArray(jobs.action, [JOB_ACTION.createVolume, JOB_ACTION.removeVolumes]),
    );
    return { volumes: this.volumes(hostId), lastJob: jobViews(this.databaseHandle, changes, 1)[0] ?? null };
  }

  hostNetworks(hostId: string): HostNetworksView {
    const changes = and(
      eq(jobs.hostId, hostId),
      inArray(jobs.action, [JOB_ACTION.createNetwork, JOB_ACTION.removeNetworks]),
    );
    return { networks: this.networks(hostId), lastJob: jobViews(this.databaseHandle, changes, 1)[0] ?? null };
  }

  hosts(): HostView[] {
    const now = this.clock();
    return this.allHosts().map((host) => {
      const view = toHostView(
        host,
        now,
        this.metrics.latestHost(host.id),
        this.savedControls(host.id),
        this.sshConnectionOf(host.id),
      );
      const inPlace = this.inPlaceOf(host.id);
      const power = this.powerOf(host);
      return { ...view, ...(inPlace === null ? {} : { inPlace }), ...(power === null ? {} : { power }) };
    });
  }

  /** Each enrolled SSH host's session, for the self-test command. */
  sshSessions(): SshSessionReport[] {
    return this.allHosts()
      .filter((host) => host.kind === HOST_KIND.ssh && host.status !== HOST_STATUS_REVOKED)
      .map((host) => ({ label: host.label, session: this.sshConnectionOf(host.id) }));
  }

  /** Containers on hosts that are still enrolled, problems first. */
  containers(filter: ContainerFilter = {}): ContainerView[] {
    const now = this.clock();
    const search = filter.search?.toLowerCase();
    return this.allHosts()
      .filter((host) => host.status !== HOST_STATUS_REVOKED)
      .filter((host) => filter.hostId === undefined || host.id === filter.hostId)
      .flatMap((host) =>
        containerViewsOf(host, now, this.metrics.latestContainers(host.id), this.savedControls(host.id)),
      )
      .filter((container) => !filter.problemsOnly || container.problem !== null)
      .filter((container) => search === undefined || matches(container, search))
      .sort(byProblemThenName);
  }

  // The ticks someone set on the host's page; a container without any takes the host's default.
  private savedControls(hostId: string): Map<string, SavedControl> {
    const rows = this.databaseHandle.database
      .select()
      .from(containerControls)
      .where(eq(containerControls.hostId, hostId))
      .all();
    return new Map(rows.map((row) => [row.containerName, { restart: row.restartChoice, update: row.updateChoice }]));
  }

  /** A host's address on its network, as it last said: how the router's records are matched to it. */
  hostAddress(hostId: string): string | null {
    return this.hosts().find(({ id }) => id === hostId)?.health?.address ?? null;
  }

  homeAssistant(): HomeAssistantView {
    return this.homeAssistantInventory?.view() ?? NOT_CONFIGURED;
  }

  /** Everything on the overview but the tasks, which the tasks service counts. */
  overview(): Omit<OverviewView, "tasks"> {
    const enrolled = this.hosts().filter((host) => host.state !== HOST_STATE.revoked);
    const containers = this.containers().filter(isCounted);
    const running = countOf(containers, (container) => container.state === CONTAINER_STATE_RUNNING);
    return {
      hosts: {
        total: enrolled.length,
        online: countOf(enrolled, (host) => host.state === HOST_STATE.online),
        silent: countOf(enrolled, (host) => host.state === HOST_STATE.silent),
        neverSeen: countOf(enrolled, (host) => host.state === HOST_STATE.neverSeen),
      },
      containers: {
        total: containers.length,
        running,
        stopped: containers.length - running,
        problems: countOf(containers, (container) => container.problem !== null),
        updates: countOf(containers, hasUpdate),
      },
      homeAssistant: this.homeAssistantInventory?.summary() ?? null,
    };
  }

  private allHosts(): HostRow[] {
    return this.databaseHandle.database.select().from(hosts).orderBy(asc(hosts.label)).all();
  }
}
