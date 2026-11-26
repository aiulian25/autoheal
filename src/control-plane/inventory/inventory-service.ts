import type { VolumeReport } from "../../shared/volumes.js";
import type { NetworkReport } from "../../shared/networks.js";
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, type SQL } from "drizzle-orm";
import {
  API_ERRORS,
  UNKNOWN_HOME_ASSISTANT_SYSTEM,
  hasUpdate,
  type ContainerUsageView,
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
  MILLISECONDS_PER_SECOND,
  SSH_STATE,
  type HostChangeDetails,
} from "../../shared/constants.js";
import type { ContainerSnapshot, Heartbeat, HostHealth, UnusedImage } from "../../shared/protocol.js";
import type { OldImageView } from "../../shared/api.js";
import type { DatabaseHandle } from "../database/connection.js";
import { containerControls, hostChanges, hosts, ignoredVersions, jobs } from "../database/schema.js";
import { DomainError } from "../domain-error.js";
import type { HomeAssistantConnection } from "../home-assistant/home-assistant-inventory.js";
import type { SavedControl } from "../host-control/host-control.js";
import type { HostRow } from "../hosts/hosts-service.js";
import { jobViews } from "../jobs/job-views.js";
import { changedForDetectors, changesBetween } from "./host-changes.js";
import { containerViewsOf, hostStateOf, isCounted, toHostView } from "./host-views.js";
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

const NOTHING_SAVED: ReadonlyMap<string, SavedControl> = new Map();
const NOTHING_IGNORED: ReadonlyMap<string, string> = new Map();
const NO_USAGE: ReadonlyMap<string, ContainerUsageView> = new Map();

// The rows of a table kept for each container, as one map for each host.
function groupedByHost<Row extends { hostId: string }, Value>(
  rows: readonly Row[],
  entryOf: (row: Row) => [string, Value],
): Map<string, Map<string, Value>> {
  const byHost = new Map<string, Map<string, Value>>();
  for (const row of rows) {
    const [name, value] = entryOf(row);
    const forHost = byHost.get(row.hostId) ?? new Map<string, Value>();
    forHost.set(name, value);
    byHost.set(row.hostId, forHost);
  }
  return byHost;
}

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

// The host's clock as its report left, against this one's as it arrived: the moment on the way reads as behind.
const clockOffsetOf = (hostClock: number | undefined, at: number) =>
  hostClock === undefined ? null : Math.round((hostClock - at) / MILLISECONDS_PER_SECOND);

/** Since when a host that had Docker has reported without it; null while it has Docker, and when it never had it. */
function dockerLostSince(host: HostRow, hasDocker: boolean, at: number): number | null {
  if (hasDocker) return null;
  if (host.dockerLostAt !== null) return host.dockerLostAt;
  // A first report has nothing to lose: a host added without Docker is watched for its system alone, as it should be.
  const hadDocker = host.docker && host.lastHeartbeatAt !== null;
  return hadDocker ? at : null;
}

/** Everything Autoheal watches: what each runner last reported, and what Home Assistant knows. */
// Images stored before the dashboard noted when each was left unused have no such time.
const storedImagesOf = (json: string): OldImageView[] =>
  (JSON.parse(json) as (UnusedImage & { unusedSince?: number | null })[]).map((image) => ({
    ...image,
    unusedSince: image.unusedSince ?? null,
  }));

/** The reported images, each keeping when it was first reported unused; one new to the list is unused from now. */
function withUnusedSince(storedJson: string | null, reported: readonly UnusedImage[], at: number): OldImageView[] {
  const known = new Map((storedJson === null ? [] : storedImagesOf(storedJson)).map((image) => [image.id, image]));
  return reported.map((image) => {
    const before = known.get(image.id);
    return { ...image, unusedSince: before === undefined ? at : before.unusedSince };
  });
}

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
   * the last one goes into the host's journal, which keeps two weeks. Says whether the report changed anything the
   * detectors read.
   */
  recordHeartbeat(host: HostRow, received: Heartbeat): boolean {
    // An SSH host's runner lives in the control plane and beats on while its host is down: without its session the
    // beat says nothing of the host, which goes quiet as any other would.
    const unreachable = host.kind === HOST_KIND.ssh && this.sshConnectionOf(host.id)?.state !== SSH_STATE.connected;
    if (unreachable) return false;
    const at = this.clock();
    // Docker could not list them this time: the containers kept are the truest there is, dated from when they came,
    // and nothing in them changed.
    const stale = received.containersStale === true;
    const heartbeat = stale ? { ...received, containers: previousReportOf(host).containers } : received;
    const containersStaleSince = stale ? (host.containersStaleSince ?? host.lastHeartbeatAt ?? at) : null;
    const hasDocker = heartbeat.docker ?? true;
    const reported = {
      lastHeartbeatAt: at,
      runnerVersion: heartbeat.runnerVersion,
      dryRun: heartbeat.dryRun,
      eventStreamConnected: heartbeat.eventStreamConnected,
      protectedContainersJson: JSON.stringify(heartbeat.protectedContainers),
      applicationBackups: heartbeat.applicationBackups === true,
      rollouts: heartbeat.rollouts === true,
      tagChanges: heartbeat.tagChanges === true,
      operationPreviews: heartbeat.operationPreviews === true,
      ...(heartbeat.topology === undefined ? {} : { topologyJson: JSON.stringify(heartbeat.topology) }),
      serviceProbes: heartbeat.serviceProbes === true && heartbeat.probeAttempts === true,
      maintenanceGeneration: heartbeat.maintenanceGeneration ?? null,
      clockSkewSeconds: heartbeat.clockSkewSeconds ?? null,
      containersStaleSince,
      reportTrimmedJson: heartbeat.trimmed === undefined ? null : JSON.stringify(heartbeat.trimmed),
      restartBudgetJson: JSON.stringify(heartbeat.restartBudget),
      recoveryHoldJson: heartbeat.recoveryHold ? JSON.stringify(heartbeat.recoveryHold) : null,
      restartWaitJson: heartbeat.restartWait === undefined ? null : JSON.stringify(heartbeat.restartWait),
      containersJson: JSON.stringify(heartbeat.containers),
      containerAccess: heartbeat.containerAccess ?? false,
      hostTerminal: heartbeat.hostTerminal ?? null,
      hostDeploy: heartbeat.hostDeploy ?? null,
      docker: hasDocker,
      dockerLostAt: dockerLostSince(host, hasDocker, at),
    };
    // A host that could not be read this time keeps its last health, and when it was read, instead of losing it; its
    // images too. A full report says how far the host's clock is, or that its runner could not tell.
    const health =
      heartbeat.host === null
        ? {}
        : {
            healthJson: JSON.stringify(heartbeat.host),
            healthAt: at,
            clockOffsetSeconds: clockOffsetOf(heartbeat.hostClock, at),
          };
    const images =
      heartbeat.unusedImages === undefined
        ? {}
        : { unusedImagesJson: JSON.stringify(withUnusedSince(host.unusedImagesJson, heartbeat.unusedImages, at)) };
    const networks = heartbeat.networks === undefined ? {} : { networksJson: JSON.stringify(heartbeat.networks) };
    // A sidecar's report of its last update replaces the one before, null too; one without it leaves that as it was.
    const runnerUpdate =
      heartbeat.runnerUpdate === undefined
        ? {}
        : { runnerUpdateJson: heartbeat.runnerUpdate && JSON.stringify(heartbeat.runnerUpdate) };
    const volumes = heartbeat.volumes === undefined ? {} : { volumesJson: JSON.stringify(heartbeat.volumes) };
    // A host's first report has nothing to compare with.
    const previous = previousReportOf(host);
    const changes = host.lastHeartbeatAt === null ? [] : changesBetween(previous, heartbeat);
    const changed =
      host.lastHeartbeatAt === null ||
      changedForDetectors(
        { ...previous, docker: host.docker ?? true, eventStreamConnected: host.eventStreamConnected },
        {
          containers: heartbeat.containers,
          health: heartbeat.host ?? previous.health,
          docker: hasDocker,
          eventStreamConnected: heartbeat.eventStreamConnected,
        },
      );
    this.databaseHandle.database.transaction((transaction) => {
      transaction
        .update(hosts)
        .set({ ...reported, ...health, ...images, ...networks, ...volumes, ...runnerUpdate })
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
    return changed;
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
  unusedImages(hostId: string): OldImageView[] | null {
    const host = this.databaseHandle.database
      .select({ unusedImagesJson: hosts.unusedImagesJson })
      .from(hosts)
      .where(eq(hosts.id, hostId))
      .get();
    if (host === undefined) {
      throw new DomainError(API_ERRORS.hostNotFound);
    }
    return host.unusedImagesJson === null ? null : storedImagesOf(host.unusedImagesJson);
  }

  hostImages(hostId: string): HostImagesView {
    const removals = and(eq(jobs.hostId, hostId), eq(jobs.action, JOB_ACTION.removeImages));
    const newestUnusedFirst = (first: OldImageView, second: OldImageView) =>
      (second.unusedSince ?? 0) - (first.unusedSince ?? 0);
    return {
      images: this.unusedImages(hostId)?.toSorted(newestUnusedFirst) ?? null,
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
    const controls = this.savedControlsByHost();
    return this.allHosts().map((host) => this.hostViewOf(host, now, controls.get(host.id) ?? NOTHING_SAVED));
  }

  private hostViewOf(host: HostRow, now: number, saved: ReadonlyMap<string, SavedControl>): HostView {
    const view = toHostView(host, now, this.metrics.latestHost(host.id), saved, this.sshConnectionOf(host.id));
    const inPlace = this.inPlaceOf(host.id);
    const power = this.powerOf(host);
    return { ...view, ...(inPlace === null ? {} : { inPlace }), ...(power === null ? {} : { power }) };
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
    // One host's list reads that host's row alone; the fleet's reads each table once.
    const rows = filter.hostId === undefined ? this.allHosts() : this.hostRows(filter.hostId);
    const controls = this.savedControlsByHost(filter.hostId);
    const ignored = this.ignoredVersionsByHost(filter.hostId);
    return rows
      .filter((host) => host.status !== HOST_STATUS_REVOKED)
      .flatMap((host) =>
        containerViewsOf(
          host,
          now,
          this.metrics.latestContainers(host.id),
          controls.get(host.id) ?? NOTHING_SAVED,
          ignored.get(host.id) ?? NOTHING_IGNORED,
        ),
      )
      .filter((container) => !filter.problemsOnly || container.problem !== null)
      .filter((container) => search === undefined || matches(container, search))
      .sort(byProblemThenName);
  }

  // The ticks someone set on hosts' pages, by host and container; a container without any takes its host's default.
  private savedControlsByHost(hostId?: string): Map<string, Map<string, SavedControl>> {
    const rows = this.databaseHandle.database
      .select()
      .from(containerControls)
      .where(hostId === undefined ? undefined : eq(containerControls.hostId, hostId))
      .all();
    return groupedByHost(rows, (row) => [row.containerName, { restart: row.restartChoice, update: row.updateChoice }]);
  }

  // The newer version a person ignores for each container, by host and container.
  private ignoredVersionsByHost(hostId?: string): Map<string, Map<string, string>> {
    const rows = this.databaseHandle.database
      .select({
        hostId: ignoredVersions.hostId,
        containerName: ignoredVersions.containerName,
        version: ignoredVersions.version,
      })
      .from(ignoredVersions)
      .where(hostId === undefined ? undefined : eq(ignoredVersions.hostId, hostId))
      .all();
    return groupedByHost(rows, (row) => [row.containerName, row.version]);
  }

  /** A host's address on its network, as it last said: how the router's records are matched to it. */
  hostAddress(hostId: string): string | null {
    const [host] = this.hostRows(hostId);
    if (host === undefined) return null;
    return this.hostViewOf(host, this.clock(), NOTHING_SAVED).health?.address ?? null;
  }

  homeAssistant(): HomeAssistantView {
    return this.homeAssistantInventory?.view() ?? NOT_CONFIGURED;
  }

  /** Everything on the overview but the tasks, which the tasks service counts. */
  overview(): Omit<OverviewView, "tasks"> {
    const now = this.clock();
    const enrolled = this.allHosts().filter((host) => host.status !== HOST_STATUS_REVOKED);
    const controls = this.savedControlsByHost();
    const ignored = this.ignoredVersionsByHost();
    // Counts need no readings: each host's containers are read once, without their usage.
    const containers = enrolled
      .flatMap((host) =>
        containerViewsOf(
          host,
          now,
          NO_USAGE,
          controls.get(host.id) ?? NOTHING_SAVED,
          ignored.get(host.id) ?? NOTHING_IGNORED,
        ),
      )
      .filter(isCounted);
    const running = countOf(containers, (container) => container.state === CONTAINER_STATE_RUNNING);
    const states = enrolled.map((host) => hostStateOf(host, now));
    return {
      hosts: {
        total: enrolled.length,
        online: countOf(states, (state) => state === HOST_STATE.online),
        silent: countOf(states, (state) => state === HOST_STATE.silent),
        neverSeen: countOf(states, (state) => state === HOST_STATE.neverSeen),
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

  private hostRows(hostId: string): HostRow[] {
    return this.databaseHandle.database.select().from(hosts).where(eq(hosts.id, hostId)).all();
  }
}
