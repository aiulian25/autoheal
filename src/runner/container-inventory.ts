import { topologyOf } from "./topology.js";
import type { TopologySnapshot } from "../shared/topology.js";
import type { OperationJournal } from "./operation-journal.js";
import {
  BLOCK_IO_READ,
  BLOCK_IO_WRITE,
  COMPOSE_PROJECT_LABEL,
  COMPOSE_SERVICE_LABEL,
  CONTAINER_HEALTH_NONE,
  CONTAINER_HEALTHS,
  CONTAINER_STATE_EXITED,
  CONTAINER_STATE_RUNNING,
  CONTAINER_STATES,
  CONTAINER_STATS_CONCURRENCY,
  DEFAULT_CPU_PERIOD_MICROSECONDS,
  HEALTH_IN_STATUS_PATTERN,
  HIGHEST_PORT,
  HOMEPAGE_LINK_LABEL,
  HOST_HELPER,
  HOST_NETWORK_MODE,
  HOST_TERMINAL_HELPER,
  MILLISECONDS_PER_SECOND,
  NANOCPUS_PER_CPU,
  PAGE_CACHE_KEYS,
  PORT_PROTOCOLS,
  PORTS_PER_CONTAINER,
  RECLAIMABLE_MEMORY_KEYS,
  REPORT_LIMITS,
  RESTART_POLICY_CHARACTERS,
  SELF_UPDATE,
  SHORT_CONTAINER_ID_LENGTH,
  UPDATE_LABEL,
  UPDATE_POLICIES,
  type ContainerHealthName,
  type ContainerStateName,
  type UpdatePolicy,
} from "../shared/constants.js";
import type { ContainerSnapshot, ContainerUsage, ImageLabels, PublishedPort } from "../shared/protocol.js";
import type { ContainerStatsSample, ContainerSummary, DockerClient, NetworkStats } from "./docker-client.js";
import type { ImageUpdateChecker } from "./image-updates.js";
import { restartPolicyOf, type ContainerDetails } from "./incident-report.js";
import { perSecond, shareOf } from "./rates.js";
import { imageLabelsOf } from "./registry-client.js";
import { webLinkOf } from "../shared/urls.js";

// A container's counters at one moment; usage is the difference between two of these.
interface UsageReading {
  at: number;
  containerNanoseconds: number;
  systemNanoseconds: number;
  readBytes: number;
  writtenBytes: number;
  receivedBytes: number;
  transmittedBytes: number;
  droppedPackets: number;
  periods: number;
  throttledPeriods: number;
}

export const nameOf = (summary: ContainerSummary) => (summary.Names[0] ?? summary.Id).replace(/^\//, "");

/** The health a listing's status gives a container: "healthy", "unhealthy", "health: starting", or "" for none. */
export const listedHealth = (summary: ContainerSummary) => HEALTH_IN_STATUS_PATTERN.exec(summary.Status)?.[1] ?? "";

/** A container as its listing tells it apart: which one it is, its state and its health. */
export const listingKey = (summary: ContainerSummary) => `${summary.Id}|${summary.State}|${listedHealth(summary)}`;

// The short-lived containers Autoheal starts for its own work: never one of the host's containers.
const HELPER_LABELS: readonly string[] = [HOST_HELPER.label, HOST_TERMINAL_HELPER.label, SELF_UPDATE.label];
const isAutohealHelper = (summary: ContainerSummary) =>
  HELPER_LABELS.some((label) => summary.Labels?.[label] !== undefined);

/**
 * The container Compose is replacing, whose name it prefixes with its own short id for the moment it takes to make
 * the new one: the name it stands for, or null for any other container.
 */
function composeCopyOf(summary: ContainerSummary): string | null {
  const name = nameOf(summary);
  const prefix = `${summary.Id.slice(0, SHORT_CONTAINER_ID_LENGTH)}_`;
  const fromCompose = summary.Labels?.[COMPOSE_PROJECT_LABEL] !== undefined;
  return fromCompose && name.startsWith(prefix) ? name.slice(prefix.length) : null;
}

const isState = (value: string): value is ContainerStateName => CONTAINER_STATES.some((state) => state === value);

const isHealth = (value: string): value is ContainerHealthName => CONTAINER_HEALTHS.some((health) => health === value);

function healthOf(details: ContainerDetails): ContainerHealthName {
  const status = details.State.Health?.Status ?? CONTAINER_HEALTH_NONE;
  return isHealth(status) ? status : CONTAINER_HEALTH_NONE;
}

// Docker writes "0001-01-01T00:00:00Z" for a moment that never happened.
function timestampOf(isoTime: string | undefined): number | null {
  const milliseconds = Date.parse(isoTime ?? "");
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : null;
}

const labelOf = (value: string | undefined) => value?.slice(0, REPORT_LIMITS.nameCharacters) ?? null;

// What a running image's labels say that its container's row shows: its version, and where its code lives.
type RunningImageLabels = Pick<ImageLabels, "version" | "source">;
const NO_IMAGE_LABELS: RunningImageLabels = { version: null, source: null };

// Only http and https: a label is written by whoever wrote the compose file, and ends up as a link.
const updatePolicyOf = (value: string | undefined): UpdatePolicy | null =>
  UPDATE_POLICIES.find((policy) => policy === value) ?? null;

export const isPort = (value: number | undefined): value is number =>
  value !== undefined && Number.isInteger(value) && value >= 1 && value <= HIGHEST_PORT;

// What it publishes, once each and lowest first: Docker lists a binding once per address family, and an
// exposed port it does not publish without a host port.
function portsOf(summary: ContainerSummary): PublishedPort[] {
  const published = new Map<string, PublishedPort>();
  for (const binding of summary.Ports ?? []) {
    const protocol = PORT_PROTOCOLS.find((known) => known === binding.Type);
    if (protocol === undefined || !isPort(binding.PublicPort) || !isPort(binding.PrivatePort)) {
      continue;
    }
    published.set(`${binding.PublicPort}/${protocol}`, {
      published: binding.PublicPort,
      target: binding.PrivatePort,
      protocol,
    });
  }
  return [...published.values()]
    .toSorted((first, second) => first.published - second.published)
    .slice(0, PORTS_PER_CONTAINER);
}

const sumOf = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0);

function memoryInUse(sample: ContainerStatsSample): number {
  const stats = sample.memory_stats?.stats ?? {};
  const reclaimable = RECLAIMABLE_MEMORY_KEYS.map((key) => stats[key]).find((value) => value !== undefined) ?? 0;
  return Math.max(0, (sample.memory_stats?.usage ?? 0) - reclaimable);
}

function pageCacheOf(sample: ContainerStatsSample): number {
  const stats = sample.memory_stats?.stats ?? {};
  return PAGE_CACHE_KEYS.map((key) => stats[key]).find((value) => value !== undefined) ?? 0;
}

// cgroup v2 names the operations "read" and "write", v1 "Read" and "Write".
function blockIoBytes(sample: ContainerStatsSample, operation: string): number {
  const entries = sample.blkio_stats?.io_service_bytes_recursive ?? [];
  return sumOf(entries.filter((entry) => entry.op?.toLowerCase() === operation).map((entry) => entry.value ?? 0));
}

function readingOf(sample: ContainerStatsSample, at: number): UsageReading {
  const networks = Object.values(sample.networks ?? {});
  const total = (counter: (network: NetworkStats) => number | undefined) =>
    sumOf(networks.map((network) => counter(network) ?? 0));
  return {
    at,
    containerNanoseconds: sample.cpu_stats?.cpu_usage?.total_usage ?? 0,
    systemNanoseconds: sample.cpu_stats?.system_cpu_usage ?? 0,
    readBytes: blockIoBytes(sample, BLOCK_IO_READ),
    writtenBytes: blockIoBytes(sample, BLOCK_IO_WRITE),
    receivedBytes: total((network) => network.rx_bytes),
    transmittedBytes: total((network) => network.tx_bytes),
    droppedPackets: total((network) => (network.rx_dropped ?? 0) + (network.tx_dropped ?? 0)),
    periods: sample.cpu_stats?.throttling_data?.periods ?? 0,
    throttledPeriods: sample.cpu_stats?.throttling_data?.throttled_periods ?? 0,
  };
}

// --cpus sets NanoCpus; the older --cpu-quota sets a quota per period instead.
function cpuLimitOf(details: ContainerDetails): number | null {
  const hostConfig = details.HostConfig ?? {};
  const nanoCpus = hostConfig.NanoCpus ?? 0;
  if (nanoCpus > 0) {
    return nanoCpus / NANOCPUS_PER_CPU;
  }
  const quota = hostConfig.CpuQuota ?? 0;
  return quota > 0 ? quota / (hostConfig.CpuPeriod || DEFAULT_CPU_PERIOD_MICROSECONDS) : null;
}

function memoryLimitOf(details: ContainerDetails): number | null {
  const limit = details.HostConfig?.Memory ?? 0;
  return limit > 0 ? limit : null;
}

/**
 * What a running container used between two samples. Like docker stats, CPU is its share of all
 * the CPU time that passed; it is reported against its own limit, or the whole host without one.
 */
function usageOf(
  name: string,
  details: ContainerDetails,
  sample: ContainerStatsSample,
  previous: UsageReading,
  current: UsageReading,
): ContainerUsage {
  const seconds = (current.at - previous.at) / MILLISECONDS_PER_SECOND;
  const grown = (counter: keyof UsageReading) => Math.max(0, current[counter] - previous[counter]);
  const rate = (counter: keyof UsageReading) => perSecond(current[counter], previous[counter], seconds);
  const onlineCpus = sample.cpu_stats?.online_cpus ?? 1;
  const systemTime = grown("systemNanoseconds");
  const coresUsed = systemTime > 0 ? (grown("containerNanoseconds") / systemTime) * onlineCpus : 0;
  const cpuLimitCores = cpuLimitOf(details);
  const memoryBytes = memoryInUse(sample);
  const hasNetwork = Object.keys(sample.networks ?? {}).length > 0;
  return {
    name: name.slice(0, REPORT_LIMITS.nameCharacters),
    cpuPercent: shareOf(coresUsed, cpuLimitCores ?? onlineCpus),
    cpuLimitCores,
    throttledPercent: cpuLimitCores === null ? null : shareOf(grown("throttledPeriods"), grown("periods")),
    memoryBytes,
    // Docker's limit is the host's memory for a container without one of its own.
    memoryPercent: shareOf(memoryBytes, sample.memory_stats?.limit ?? 0),
    memoryLimitBytes: memoryLimitOf(details),
    cacheBytes: pageCacheOf(sample),
    readBytesPerSecond: rate("readBytes"),
    writeBytesPerSecond: rate("writtenBytes"),
    receiveBytesPerSecond: hasNetwork ? rate("receivedBytes") : null,
    transmitBytesPerSecond: hasNetwork ? rate("transmittedBytes") : null,
    droppedPackets: hasNetwork ? grown("droppedPackets") : null,
    processes: sample.pids_stats?.current ?? null,
  };
}

/**
 * Every container on this host, as the dashboard shows it. `docker inspect` is asked again only
 * when a container's id, state or health changes (or an event says it did), so a host with a
 * hundred containers costs one list call per report.
 */
export class ContainerInventory {
  private lastTopology: TopologySnapshot | null = null;
  topology(): TopologySnapshot | null {
    return this.lastTopology;
  }
  private readonly details = new Map<string, { key: string; details: ContainerDetails }>();
  private readonly readings = new Map<string, UsageReading>();
  // What each image's labels say, by image id: an image does not change.
  private readonly imageLabels = new Map<string, RunningImageLabels>();

  constructor(
    private readonly docker: Pick<DockerClient, "containerSummaries" | "inspect" | "statsOnce" | "inspectImage">,
    private readonly clock: () => number = Date.now,
    private readonly updates: Pick<ImageUpdateChecker, "resultFor"> | null = null,
    private readonly journal: Pick<OperationJournal, "pending"> | null = null,
  ) {}

  async snapshot(): Promise<ContainerSnapshot[]> {
    const recoveries = (await this.journal?.pending()) ?? [];
    const summaries = (await this.docker.containerSummaries())
      .filter((summary) => !isAutohealHelper(summary))
      .slice(0, REPORT_LIMITS.containers);
    const present = new Set(summaries.map(nameOf));
    for (const name of this.details.keys()) {
      if (!present.has(name)) {
        this.details.delete(name);
      }
    }
    const snapshots: ContainerSnapshot[] = [];
    const topologyEntries: { name: string; details: ContainerDetails }[] = [];
    const imagesInUse = new Set<string>();
    for (const summary of summaries) {
      // One row while Compose swaps it: the old one under its own name until the new one has it.
      const copyOf = composeCopyOf(summary);
      if (copyOf !== null && present.has(copyOf)) continue;
      const details = await this.detailsOf(summary);
      if (details === null) {
        continue;
      }
      const imageId = details.Image ?? summary.ImageID;
      if (imageId !== undefined) {
        imagesInUse.add(imageId);
      }
      const snapshot = this.snapshotOf(summary, details, await this.labelsOf(imageId));
      if (copyOf !== null) snapshot.name = copyOf;
      for (const operation of recoveries) {
        const member = operation.members.find(
          ({ id, replacementId, name }) => summary.Id === id || summary.Id === replacementId || snapshot.name === name,
        );
        if (member === undefined) continue;
        snapshot.recovery = { owner: operation.owner };
        // Keep the existing action target reachable during the remove/rename gap.
        if (summary.Id === member.id && !present.has(member.name)) snapshot.name = member.name;
      }
      snapshots.push(snapshot);
      topologyEntries.push({ name: snapshot.name, details });
    }
    for (const imageId of this.imageLabels.keys()) {
      if (!imagesInUse.has(imageId)) {
        this.imageLabels.delete(imageId);
      }
    }
    this.lastTopology = topologyOf(topologyEntries, this.clock());
    return snapshots.sort((first, second) => first.name.localeCompare(second.name));
  }

  /** Look at this container again next time, whatever its listing says; called on its events. */
  invalidate(name: string) {
    this.details.delete(name);
  }

  /** Look at every container again next time: after events were missed. */
  invalidateAll() {
    this.details.clear();
  }

  /** Every running container's usage since the last call; a container's first sample is only a baseline. */
  async sampleUsage(): Promise<ContainerUsage[]> {
    const running = (await this.docker.containerSummaries())
      .filter((summary) => summary.State === CONTAINER_STATE_RUNNING)
      .slice(0, REPORT_LIMITS.containers);
    const usages: (ContainerUsage | null)[] = [];
    for (let start = 0; start < running.length; start += CONTAINER_STATS_CONCURRENCY) {
      const batch = running.slice(start, start + CONTAINER_STATS_CONCURRENCY);
      usages.push(...(await Promise.all(batch.map((summary) => this.sampleOne(summary)))));
    }
    const stillRunning = new Set(running.map((summary) => summary.Id));
    for (const containerId of this.readings.keys()) {
      if (!stillRunning.has(containerId)) {
        this.readings.delete(containerId);
      }
    }
    return usages.filter((usage) => usage !== null);
  }

  /** A container's details, from Docker only when its listing changed since they were last read. */
  async detailsOf(summary: ContainerSummary): Promise<ContainerDetails | null> {
    const name = nameOf(summary);
    const key = listingKey(summary);
    const known = this.details.get(name);
    if (known?.key === key) {
      return known.details;
    }
    // Null when it was removed between the listing and this call.
    const details = await this.docker.inspect(summary.Id);
    if (details !== null) {
      this.details.set(name, { key, details });
    }
    return details;
  }

  // Docker not answering leaves them unknown this time, and asked again the next.
  private async labelsOf(imageId: string | undefined): Promise<RunningImageLabels> {
    if (imageId === undefined) {
      return NO_IMAGE_LABELS;
    }
    const known = this.imageLabels.get(imageId);
    if (known !== undefined) {
      return known;
    }
    const image = await this.docker.inspectImage(imageId).catch(() => undefined);
    if (image === undefined) {
      return NO_IMAGE_LABELS;
    }
    const { version, source } = image === null ? NO_IMAGE_LABELS : imageLabelsOf(image.Config?.Labels ?? {});
    const labels = { version, source };
    this.imageLabels.set(imageId, labels);
    return labels;
  }

  private snapshotOf(
    summary: ContainerSummary,
    details: ContainerDetails,
    { version, source }: RunningImageLabels,
  ): ContainerSnapshot {
    const state = isState(summary.State) ? summary.State : CONTAINER_STATE_EXITED;
    const running = state === CONTAINER_STATE_RUNNING;
    const labels = summary.Labels ?? {};
    return {
      name: nameOf(summary).slice(0, REPORT_LIMITS.nameCharacters),
      containerId: summary.Id.slice(0, SHORT_CONTAINER_ID_LENGTH),
      image: details.Config.Image.slice(0, REPORT_LIMITS.imageCharacters),
      state,
      // A stopped container keeps its last health status; only a running one's means anything.
      health: running ? healthOf(details) : CONTAINER_HEALTH_NONE,
      startedAt: timestampOf(details.State.StartedAt),
      finishedAt: running ? null : timestampOf(details.State.FinishedAt),
      exitCode: running ? null : (details.State.ExitCode ?? null),
      oomKilled: details.State.OOMKilled ?? false,
      restartCount: details.RestartCount ?? 0,
      restartPolicy: restartPolicyOf(details).slice(0, RESTART_POLICY_CHARACTERS),
      composeProject: labelOf(labels[COMPOSE_PROJECT_LABEL]),
      composeService: labelOf(labels[COMPOSE_SERVICE_LABEL]),
      link: webLinkOf(labels[HOMEPAGE_LINK_LABEL]),
      version,
      source,
      updatePolicy: updatePolicyOf(labels[UPDATE_LABEL]),
      update: this.updates?.resultFor(details.Image ?? summary.ImageID, details.Config.Image) ?? null,
      ports: portsOf(summary),
      hostNetwork: summary.HostConfig?.NetworkMode === HOST_NETWORK_MODE,
    };
  }

  private async sampleOne(summary: ContainerSummary): Promise<ContainerUsage | null> {
    const [details, sample] = await Promise.all([
      this.detailsOf(summary).catch(() => null),
      this.docker.statsOnce(summary.Id).catch(() => null),
    ]);
    if (details === null || sample === null) {
      return null;
    }
    const current = readingOf(sample, this.clock());
    const previous = this.readings.get(summary.Id);
    this.readings.set(summary.Id, current);
    if (previous === undefined || current.at <= previous.at) {
      return null;
    }
    return usageOf(nameOf(summary), details, sample, previous, current);
  }
}
