import { provenanceSchema, type ImageTrustPolicy } from "./image-provenance.js";
import { PROBE_LIMITS, type ProbeBody } from "./probes.js";
import type { RegistryAccess } from "./registry-credentials.js";
import { BACKUP_ID, type BackupJobDetails, type BackupRequest } from "./container-backups.js";
import { stackDriftReportSchema, type StackJobDetails, type StackRequest } from "./stacks.js";
import { volumeReportSchema, type NewVolume, type VolumeLookRequest, type VolumeRemoval } from "./volumes.js";
import { networkReportSchema, type NetworkRemoval, type NewNetwork } from "./networks.js";
import type { RolloutJob } from "./rollouts.js";
import type { ApplicationBackupTask } from "./application-backups.js";
import { topologySnapshotSchema, type OperationPreviewRequest } from "./topology.js";
import type { MaintenancePolicy } from "./maintenance.js";
import { z } from "zod";
import {
  ALLOWED_ACTIONS,
  APT_HISTORY,
  BOOT_ID_PATTERN,
  CONTAINER_HEALTHS,
  CPU_TEMPERATURE_LIMIT,
  DRIVE_KINDS,
  CONTAINER_STATES,
  FILE_CONTENT_CHARACTERS,
  FILE_ENTRIES_LIMIT,
  FILE_FIELD_CHARACTERS,
  FILE_KINDS,
  FILE_PATH_CHARACTERS,
  MOUNT_KIND,
  RESTART_POLICIES,
  SETTINGS_LIMITS,
  VOLUME_NAME_PATTERN,
  type FileOperation,
  PACKAGE_NAME_CHARACTERS,
  PACKAGE_NAME_PATTERN,
  DIAGNOSIS_TEXT_LIMIT,
  DIGEST_PATTERN,
  SMART_WARNING_KINDS,
  ERROR_TEXT_LIMIT,
  IMAGE_LABEL_CHARACTERS,
  IMAGE_TAG_PATTERN,
  CONTAINER_DETAILS,
  HOST_PROFILE,
  GPU_LIMIT,
  HOST_DISK_LIMIT,
  HOST_LABEL_PATTERN,
  HOST_PACKAGE_LIMIT,
  HOST_PACKAGE_MANAGERS,
  HOST_PACKAGES_SETTINGS,
  HOST_TEXT_LIMIT,
  HIGHEST_PORT,
  JOB_OUTPUT_CHARACTERS,
  LAYER_STATES,
  LEGACY_NO_APT,
  LOAD_AVERAGE_PERIODS,
  METRICS_DEVICE_LIMIT,
  OS_RELEASE_VALUE_CHARACTERS,
  OUTCOME_TEXT_LIMIT,
  PACKAGE_ORIGIN_CHARACTERS,
  PACKAGE_ORIGINS_PER_PACKAGE,
  PACKAGE_SUMMARY_CHARACTERS,
  PACKAGE_VERSION_CHARACTERS,
  PACKAGE_VERSION_PATTERN,
  PACKAGES_UNSUPPORTED,
  PACKAGES_UNSUPPORTED_REASONS,
  PERCENT,
  PORT_PROTOCOLS,
  PORTS_PER_CONTAINER,
  PULL_PROGRESS_LIMITS,
  REBOOT_PACKAGES_LIMIT,
  RECOVERY_HOLD_REASONS,
  REPORT_LIMITS,
  RESTART_POLICY_CHARACTERS,
  RUNNER_VERSION_MAXIMUM_LENGTH,
  SHORT_CONTAINER_ID_LENGTH,
  TERMINAL_OUTPUT_CHUNK_BYTES,
  TIME_ZONE_CHARACTERS,
  UPDATE_PHASES,
  UPDATE_POLICIES,
  UPDATE_STATUSES,
  VERDICTS,
  WEB_LINK_CHARACTERS,
  WEB_LINK_PATTERN,
  type ACTION_ESCALATE,
  type JOB_ACTION,
  isHostPackageAction,
  type AllowedAction,
  type ContainerAction,
  type HostPackageAction,
  type RestartChoice,
} from "./constants.js";
import type { InstallRequest } from "./install.js";
import type { Decision } from "./decision.js";
import { incidentReportSchema } from "./report.js";

// The runner ↔ control plane contract. The control plane listens for runners on its own LAN-only
// port, never through the internet-facing proxy.

export const RUNNER_ROUTES = {
  applicationBackupWork: "/runner/v1/application-backups/work",
  applicationBackupResult: "/runner/v1/application-backups/result",
  applicationBackupAuthorization: "/runner/v1/application-backups/:taskId/authorize",
  applicationBackupUpload: "/runner/v1/application-backups/:taskId/artifacts/:artifactId/upload",
  applicationBackupDownload: "/runner/v1/application-backups/:taskId/artifacts/:artifactId/download",
  operationPreviewAnswer: "/runner/v1/operation-previews/:requestId/answer",
  jobAuthorization: "/runner/v1/jobs/:jobId/authorize",
  terminalAuthorization: "/runner/v1/terminals/:requestId/authorize",
  fileAuthorization: "/runner/v1/files/:requestId/authorize",
  settingsAuthorization: "/runner/v1/settings/:requestId/authorize",
  resultDelivery: "/runner/v1/result-delivery",
  heartbeat: "/runner/v1/heartbeat",
  jobResult: "/runner/v1/jobs/:jobId/result",
  // A package job's output while it runs, so the dashboard can show it live.
  jobProgress: "/runner/v1/jobs/:jobId/progress",
  metrics: "/runner/v1/metrics",
  incidents: "/runner/v1/incidents",
  incidentOutcome: "/runner/v1/incidents/:incidentId/outcome",
  handledIncidents: "/runner/v1/incidents/handled",
  work: "/runner/v1/work",
  workResult: "/runner/v1/work/:workItemId/result",
  // Shells to open, files to reach and settings to read, waited for: the runner hears of each the moment a
  // person asks.
  containerAccess: "/runner/v1/container-access",
  fileAnswer: "/runner/v1/files/:requestId/answer",
  settingsAnswer: "/runner/v1/settings/:requestId/answer",
  hostProfileAnswer: "/runner/v1/host-profile/:requestId/answer",
  volumeLookAnswer: "/runner/v1/volume-look/:requestId/answer",
  stackAnswer: "/runner/v1/stacks/:requestId/answer",
  backupAnswer: "/runner/v1/backups/:requestId/answer",
  jobBackupKey: "/runner/v1/jobs/:jobId/backup-key",
  installAnswer: "/runner/v1/install/:requestId/answer",
  jobInstall: "/runner/v1/jobs/:jobId/install",
  // The settings an edit job applies, fetched once when the runner runs it: they are kept nowhere else.
  jobSettings: "/runner/v1/jobs/:jobId/settings",
  // A shell's keystrokes, waited for; what it prints; and its end.
  terminalInput: "/runner/v1/terminals/:terminalId/input",
  terminalOutput: "/runner/v1/terminals/:terminalId/output",
  terminalEnd: "/runner/v1/terminals/:terminalId/end",
  notifications: "/runner/v1/notifications",
} as const;

const containerName = z.string().min(1).max(REPORT_LIMITS.nameCharacters);
const byteCount = z.number().int().min(0);
const timestamp = z.number().int().positive().nullable();
const count = z.number().int().min(0);
const label = z.string().max(REPORT_LIMITS.nameCharacters).nullable();
const port = z.number().int().min(1).max(HIGHEST_PORT);

/** A port a container publishes on its host: the host's port, the container's, and the protocol. */
export const publishedPortSchema = z.object({ published: port, target: port, protocol: z.enum(PORT_PROTOCOLS) });
export type PublishedPort = z.infer<typeof publishedPortSchema>;

const imageLabel = z.string().max(IMAGE_LABEL_CHARACTERS).nullable();

/** What an image's build says it is, from its OCI labels; each null when the image does not say. */
export const imageLabelsSchema = z.object({
  version: imageLabel,
  revision: imageLabel,
  // Where its code lives; only http and https links.
  source: z.string().max(WEB_LINK_CHARACTERS).regex(WEB_LINK_PATTERN).nullable(),
  createdAt: timestamp,
});

export type ImageLabels = z.infer<typeof imageLabelsSchema>;

/** One container as its host's runner last saw it. */
export const containerSnapshotSchema = z.object({
  // Absent on older runners; durable rollback recovery can outlive a parked container name.
  recovery: z.object({ owner: containerName }).optional(),
  name: containerName,
  containerId: z.string().max(SHORT_CONTAINER_ID_LENGTH),
  image: z.string().max(REPORT_LIMITS.imageCharacters),
  state: z.enum(CONTAINER_STATES),
  health: z.enum(CONTAINER_HEALTHS),
  startedAt: timestamp,
  finishedAt: timestamp,
  exitCode: z.number().int().nullable(),
  oomKilled: z.boolean(),
  restartCount: z.number().int().min(0),
  restartPolicy: z.string().max(RESTART_POLICY_CHARACTERS),
  composeProject: label,
  composeService: label,
  // Its web interface, from a homepage.href label; only http and https links.
  link: z.string().max(WEB_LINK_CHARACTERS).regex(WEB_LINK_PATTERN).nullable(),
  // Its autoheal.update label; null without one.
  updatePolicy: z.enum(UPDATE_POLICIES).nullable(),
  // What it publishes on its host, and whether it uses the host's own network instead (then it publishes none).
  // Absent from runners from before them.
  ports: z.array(publishedPortSchema).max(PORTS_PER_CONTAINER).optional(),
  hostNetwork: z.boolean().optional(),
  // The version its image's labels name; null when they name none. Absent from runners from before it.
  version: imageLabel.optional(),
  // The runner's latest registry check of its image; null until checked, or when an image can't be
  // checked (built locally, or pinned to a digest).
  update: z
    .object({
      status: z.enum(UPDATE_STATUSES),
      checkedAt: z.number().int().positive(),
      remoteDigest: z.string().regex(DIGEST_PATTERN).nullable(),
      // What the newer image's labels say; null until read. Absent from runners from before it.
      remote: imageLabelsSchema.nullable().optional(),
      // Why the last check failed; null when it did not.
      reason: z.string().max(ERROR_TEXT_LIMIT).nullable().optional(),
      // Who published the newer image, where a trust rule asks for proof. Absent from runners from before it,
      // and null where nothing asks.
      provenance: provenanceSchema.nullable().optional(),
      // The newest tag on the line of the one it runs, when a newer one is out. Absent with none, and from runners
      // from before it.
      newerTag: z.string().regex(IMAGE_TAG_PATTERN).optional(),
    })
    .nullable(),
});

export type ContainerSnapshot = z.infer<typeof containerSnapshotSchema>;

export const packageNameSchema = z.string().max(PACKAGE_NAME_CHARACTERS).regex(PACKAGE_NAME_PATTERN);
const packageVersion = z.string().max(PACKAGE_VERSION_CHARACTERS).regex(PACKAGE_VERSION_PATTERN);

/** One apt run, from the host's own record of it. */
export const packageChangeSchema = z.object({
  endedAt: z.number().int().min(0),
  byUnattendedUpgrades: z.boolean(),
  upgraded: z.array(z.object({ name: packageNameSchema, version: packageVersion })).max(APT_HISTORY.packagesPerEntry),
  upgradedCount: z.number().int().min(0),
  installed: z.array(packageNameSchema).max(APT_HISTORY.packagesPerEntry),
  removed: z.array(packageNameSchema).max(APT_HISTORY.packagesPerEntry),
});

export type PackageChange = z.infer<typeof packageChangeSchema>;

const osReleaseValue = z.string().max(OS_RELEASE_VALUE_CHARACTERS);

/** What a host's own files say about its packages; read without running anything. */
export const packageFactsSchema = z.object({
  // HOST_PACKAGES from the host's .env.
  setting: z.enum(HOST_PACKAGES_SETTINGS),
  // Why its packages are out of reach whatever the setting says; null when they are not. A runner from
  // before dnf said no_apt for what is now no_package_manager.
  unsupported: z
    .union([z.enum(PACKAGES_UNSUPPORTED_REASONS), z.literal(LEGACY_NO_APT)])
    .transform((reason) => (reason === LEGACY_NO_APT ? PACKAGES_UNSUPPORTED.noPackageManager : reason))
    .nullable(),
  // Absent from runners from before dnf, which only knew apt.
  manager: z.enum(HOST_PACKAGE_MANAGERS).nullable().optional(),
  // /etc/os-release's ID and VERSION_ID, for how long the release gets security fixes.
  release: z.object({ id: osReleaseValue, versionId: osReleaseValue }).nullable().optional(),
  // A Proxmox VE node: its os-release says Debian, but its support ends on Proxmox's own dates.
  proxmox: z.boolean().optional(),
  // The host installs updates by itself: unattended-upgrades, or dnf-automatic set to apply them.
  unattendedUpgrades: z.boolean(),
  rebootPackages: z.array(packageNameSchema).max(REBOOT_PACKAGES_LIMIT),
  // A newer kernel installed than the one running: it starts at the next boot.
  kernelWaiting: z.string().max(HOST_TEXT_LIMIT).nullable(),
  timeZone: z.string().max(TIME_ZONE_CHARACTERS).nullable(),
  recentChanges: z.array(packageChangeSchema).max(APT_HISTORY.entries),
});

export type PackageFacts = z.infer<typeof packageFactsSchema>;

/** One drive as smartd last read it: wear and failure signs, and what smartd itself warned about. */
export const driveHealthSchema = z.object({
  device: z.string().max(HOST_TEXT_LIMIT),
  kind: z.enum(DRIVE_KINDS),
  // When smartd last wrote its state file: a drive asleep keeps an older reading.
  readAt: z.number().int().positive(),
  reallocatedSectors: count,
  pendingSectors: count,
  uncorrectableSectors: count,
  selfTestErrors: count,
  errorLogEntries: count,
  // NVMe only.
  percentageUsed: z.number().int().min(0).nullable(),
  availableSpare: z.number().int().min(0).nullable(),
  // NVMe only: the critical warning bits smartd's checks of the last week found, from its attribute log; null
  // where it keeps none, absent from runners older than this.
  criticalWarnings: z.number().int().min(0).nullable().optional(),
  warnings: z
    .array(z.object({ kind: z.string().max(HOST_TEXT_LIMIT), count, lastAt: z.number().int().min(0).nullable() }))
    .max(SMART_WARNING_KINDS.length),
});

export type DriveHealth = z.infer<typeof driveHealthSchema>;

export const hostHealthSchema = z.object({
  cpuCount: z.number().int().positive(),
  loadAverage: z.array(z.number().min(0)).length(LOAD_AVERAGE_PERIODS),
  memoryTotalBytes: byteCount,
  memoryAvailableBytes: byteCount,
  uptimeSeconds: z.number().min(0),
  disks: z
    .array(
      z.object({
        path: z.string().max(HOST_TEXT_LIMIT),
        totalBytes: byteCount,
        usedBytes: byteCount,
        availableBytes: byteCount,
      }),
    )
    .max(HOST_DISK_LIMIT),
  // Null when the host's filesystem is not mounted into the runner, or the host has no such signal.
  rebootRequired: z.boolean().nullable(),
  pendingUpdates: z.number().int().min(0).nullable(),
  operatingSystem: z.string().max(HOST_TEXT_LIMIT).nullable(),
  kernel: z.string().max(HOST_TEXT_LIMIT),
  // All absent from runners older than these fields.
  bootId: z.string().regex(BOOT_ID_PATTERN).nullable().optional(),
  packages: packageFactsSchema.nullable().optional(),
  hostname: z.string().max(HOST_TEXT_LIMIT).nullable().optional(),
  architecture: z.string().max(HOST_TEXT_LIMIT).optional(),
  cpuModel: z.string().max(HOST_TEXT_LIMIT).nullable().optional(),
  // Null when the host's filesystem is not mounted into the runner, whose own /proc shows only its container.
  processes: z.number().int().min(0).nullable().optional(),
  // The drives the kernel has a temperature sensor for, and those smartd last read.
  driveTemperatures: z
    .array(
      z.object({
        device: z.string().max(HOST_TEXT_LIMIT),
        celsius: z.number(),
        // The highest it declares it may run at, where its kernel sensor says.
        maximumCelsius: z.number().nullable().optional(),
      }),
    )
    .max(HOST_DISK_LIMIT)
    .optional(),
  // Each drive's health as smartd last read it; none on a host without smartd.
  drives: z.array(driveHealthSchema).max(HOST_DISK_LIMIT).optional(),
  dockerVersion: z.string().max(HOST_TEXT_LIMIT).nullable().optional(),
  // Where Docker keeps its images on the host; null when Docker does not say.
  imageStore: z.string().max(HOST_TEXT_LIMIT).nullable().optional(),
  // Its IPv4 address on its default route; null without one.
  address: z.ipv4().nullable().optional(),
  // An NVIDIA card its runner was not given, on a machine that is not a laptop: no GPU dial until it is.
  gpuNotGiven: z.boolean().optional(),
  // Each core's temperature where the sensor has them ("Core 1"), else each reading it has.
  cpuTemperatures: z
    .array(z.object({ label: z.string().max(HOST_TEXT_LIMIT), celsius: z.number() }))
    .max(CPU_TEMPERATURE_LIMIT)
    .optional(),
});

export type HostHealth = z.infer<typeof hostHealthSchema>;

/** An image no container on the host uses, not even a stopped one. */
export const unusedImageSchema = z.object({
  id: z.string().regex(DIGEST_PATTERN),
  // Its names; none once a newer pull took its name.
  tags: z.array(z.string().max(REPORT_LIMITS.imageCharacters)).max(REPORT_LIMITS.tagsPerImage),
  // Where it came from, which its digest still says without a name; null for one built on the host.
  repository: z.string().max(REPORT_LIMITS.imageCharacters).nullable(),
  sizeBytes: byteCount,
  // When it was built, not when it was pulled.
  createdAt: z.number().int().min(0),
  // The image a container ran before its last update, which a clean-up keeps for going back to it by hand.
  keptByUpdate: z.boolean(),
});

export type UnusedImage = z.infer<typeof unusedImageSchema>;

export const recoveryHoldSchema = z
  .object({
    reason: z.enum(RECOVERY_HOLD_REASONS),
    // When it ends by itself, in milliseconds; null when it lasts until someone fixes the runner.
    until: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type RecoveryHold = z.infer<typeof recoveryHoldSchema>;

// When a container's used-up restarts free again, and when Autoheal's wait after the last failure it handled
// there ends, on the wall clock in milliseconds; null while it has restarts left, or no wait.
export const restartWaitSchema = z
  .object({
    againAt: z.number().int().nonnegative().nullable(),
    looksAgainAt: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type RestartWait = z.infer<typeof restartWaitSchema>;

/** What a host saw when it made a check it was given. Public facts about a certificate only, as ever. */
export const probeReportSchema = z.object({
  id: z.string().max(PROBE_LIMITS.targetCharacters),
  generation: z.string().max(PROBE_LIMITS.nameCharacters),
  ok: z.boolean(),
  latencyMilliseconds: z.number().int().min(0).nullable(),
  problem: z.string().max(PROBE_LIMITS.problemCharacters).nullable(),
  certificate: z
    .object({
      fingerprint: z.string().max(PROBE_LIMITS.nameCharacters),
      subject: z.string().max(PROBE_LIMITS.targetCharacters),
      issuer: z.string().max(PROBE_LIMITS.targetCharacters),
      validFrom: z.number().int(),
      validTo: z.number().int(),
      name: z.string().max(PROBE_LIMITS.targetCharacters),
      nameMatches: z.boolean(),
      chainError: z.string().max(PROBE_LIMITS.problemCharacters).nullable(),
    })
    .optional(),
});
export type ProbeReport = z.infer<typeof probeReportSchema>;

export const heartbeatSchema = z.object({
  // Absent until a runner has looked: says nothing either way.
  stackDrift: stackDriftReportSchema.optional(),
  applicationBackups: z.boolean().optional(),
  rollouts: z.boolean().optional(),
  topology: topologySnapshotSchema.optional(),
  operationPreviews: z.boolean().optional(),
  resourcePermissions: z.boolean().optional(),
  maintenanceGeneration: z.number().int().nonnegative().safe().optional(),
  runnerVersion: z.string().max(RUNNER_VERSION_MAXIMUM_LENGTH),
  // What the runner calls its host; a host added without a name takes it.
  hostLabel: z.string().regex(HOST_LABEL_PATTERN).optional(),
  dryRun: z.boolean(),
  eventStreamConnected: z.boolean(),
  protectedContainers: z.array(containerName).max(REPORT_LIMITS.containers),
  // Restarts used per container in the current window.
  restartBudget: z.record(containerName, z.number().int().min(0)),
  // Why it restarts nothing on its own just now; null while it may, absent from runners from before it.
  recoveryHold: recoveryHoldSchema.nullable().optional(),
  // The containers whose restarts are used up, or that Autoheal waits on; absent from runners from before it,
  // which take no reset either.
  restartWait: z.record(containerName, restartWaitSchema).optional(),
  // Null when the host could not be read this time; the dashboard keeps showing the last good one.
  host: hostHealthSchema.nullable(),
  // Every container on the host, every time: a full picture can't drift the way changes can.
  containers: z.array(containerSnapshotSchema).max(REPORT_LIMITS.containers),
  // Absent from runners from before it, and when Docker could not list them this time.
  unusedImages: z.array(unusedImageSchema).max(REPORT_LIMITS.unusedImages).optional(),
  // Absent from runners from before it, and when Docker could not list them this time.
  networks: z.array(networkReportSchema).max(REPORT_LIMITS.networks).optional(),
  // Absent from runners from before it, and when Docker could not list them this time.
  volumes: z.array(volumeReportSchema).max(REPORT_LIMITS.volumes).optional(),
  // Its .env's CONTAINER_ACCESS; absent from runners from before it, which never allow it.
  containerAccess: z.boolean().optional(),
  // False from an SSH host without Docker, watched for its system alone; absent from runners, which have it.
  docker: z.boolean().optional(),
  // Its .env's HOST_TERMINAL; absent from runners from before it, which cannot open a shell on their host.
  hostTerminal: z.boolean().optional(),
  // Its .env's HOST_DEPLOY; absent from runners from before it, which cannot put a new app on their host.
  hostDeploy: z.boolean().optional(),
  // Whether this runner can make service checks from its own host. Absent from runners from before it, whose
  // checks stay with Autoheal rather than being assumed to work.
  serviceProbes: z.boolean().optional(),
  // What the checks it was given saw, each with the check and the generation it was given for.
  probeResults: z.array(probeReportSchema).max(PROBE_LIMITS.resultsPerReport).optional(),
});

export type Heartbeat = z.infer<typeof heartbeatSchema>;

/**
 * The control plane's answer to every heartbeat: where Ollama is, for deciding alone while the
 * control plane is away, and the dashboard's address, for links. A runner needs neither in its .env.
 */
/** What the host's page lets Autoheal do there on its own; absent from control planes before it. */
export interface HostControl {
  maintenance?: MaintenancePolicy;
  // Whether a failed container is restarted without asking a person first; one not named takes the default.
  restartByDefault: boolean;
  restart: Record<string, boolean>;
  // What Autoheal does when each one fails: restart it, ask first, only tell, or leave it unwatched. Absent
  // from control planes before it; a runner from before it reads restart above, false for all but restart.
  whenFailingByDefault?: RestartChoice;
  whenFailing?: Record<string, RestartChoice>;
  // An image clean-up clears Docker's build cache too.
  clearBuildCache: boolean;
  // Containers given to Ollama: an update of one that does not come back healthy is undone at once. Absent from
  // control planes before it, which leave the old container aside for a person.
  undoFailedUpdates?: string[];
  // When an admin cleared each container's restarts and its wait: what came before no longer counts. Absent from
  // control planes before it.
  restartsResetAt?: Record<string, number>;
}

export interface HeartbeatResponse {
  publicBaseUrl: string;
  ollama: { url: string; model: string; contextTokens: number };
  control?: HostControl;
  // The private registries this host may read and pull from, as Settings scoped them: absent from control planes
  // before them, and from the answer to a host no credential names, which pulls anonymously as before.
  registries?: RegistryAccess[];
  // Which publishers this fleet trusts and where a signed image is required: absent where nothing asks for proof,
  // and from control planes before it, which leaves every runner applying updates as it did.
  imageTrust?: ImageTrustPolicy;
  // The service checks this host is to make from where it is, due now. Absent where it has none.
  probes?: RemoteProbe[];
  // The exact release its control plane runs, which an "Update runner" job moves a sidecar runner pinned to an older release to. Absent from
  // control planes before it, whose runners are then never asked to update themselves.
  release?: { image: string; version: string };
}

/** One check a host is asked to make: which check it is, which version of it, and what to do. */
export interface RemoteProbe {
  id: string;
  // What the check was when it was handed out: a result for another generation is not an answer to this question.
  generation: string;
  body: ProbeBody;
}

// Live stats, every few seconds. Rates are averages since the runner's previous sample.
const share = z.number().min(0).max(PERCENT);
const perSecond = z.number().min(0);
const deviceName = z.string().max(HOST_TEXT_LIMIT);

export const hostMetricsSchema = z.object({
  cpu: z.object({
    // Busy is everything but idle and waiting for disks.
    busyPercent: share,
    userPercent: share,
    systemPercent: share,
    ioWaitPercent: share,
    stealPercent: share,
    // Null where the kernel or the hardware does not say.
    frequencyMegahertz: z.number().min(0).nullable(),
    temperatureCelsius: z.number().nullable(),
  }),
  memory: z.object({
    totalBytes: byteCount,
    usedBytes: byteCount,
    cacheBytes: byteCount,
    swapTotalBytes: byteCount,
    swapUsedBytes: byteCount,
  }),
  // The physical disks; null when the runner cannot see them.
  disk: z
    .object({
      devices: z.array(deviceName).max(METRICS_DEVICE_LIMIT),
      readBytesPerSecond: perSecond,
      writeBytesPerSecond: perSecond,
    })
    .nullable(),
  // The physical network cards; null when the host's filesystem is not mounted into the runner.
  network: z
    .object({
      interfaces: z
        .array(z.object({ name: deviceName, speedMegabitsPerSecond: z.number().int().positive().nullable() }))
        .max(METRICS_DEVICE_LIMIT),
      receiveBytesPerSecond: perSecond,
      transmitBytesPerSecond: perSecond,
      droppedPackets: count,
    })
    .nullable(),
  // NVIDIA's only where the runner was given them (see the README); Intel's and AMD's as the kernel lists them.
  gpus: z
    .array(
      z.object({
        name: deviceName,
        utilizationPercent: share,
        // The share is of its top clock, not of time spent busy: the only honest reading its driver gives.
        clockShare: z.boolean().optional(),
        memoryUsedBytes: byteCount,
        memoryTotalBytes: byteCount,
        powerWatts: z.number().min(0).nullable(),
        temperatureCelsius: z.number().nullable(),
      }),
    )
    .max(GPU_LIMIT),
});

export type HostMetrics = z.infer<typeof hostMetricsSchema>;

/** One running container's usage. Shares are of its own limit, or of the whole host when it has none. */
export const containerUsageSchema = z.object({
  name: containerName,
  cpuPercent: share,
  cpuLimitCores: z.number().positive().nullable(),
  // How often the CPU limit held it back; null without a limit.
  throttledPercent: share.nullable(),
  // In use, the reclaimable page cache left out, as docker stats counts it.
  memoryBytes: byteCount,
  memoryPercent: share,
  memoryLimitBytes: byteCount.nullable(),
  cacheBytes: byteCount,
  readBytesPerSecond: perSecond,
  writeBytesPerSecond: perSecond,
  // Null for a container on the host's network, whose traffic is the host's.
  receiveBytesPerSecond: perSecond.nullable(),
  transmitBytesPerSecond: perSecond.nullable(),
  droppedPackets: count.nullable(),
  processes: count.nullable(),
});

export type ContainerUsage = z.infer<typeof containerUsageSchema>;

export const metricsReportSchema = z.object({
  // Null when the host could not be read this time.
  host: hostMetricsSchema.nullable(),
  containers: z.array(containerUsageSchema).max(REPORT_LIMITS.containers),
});

export type MetricsReport = z.infer<typeof metricsReportSchema>;

export const incidentSubmissionSchema = z.object({
  report: incidentReportSchema,
  detectedAt: z.number().int().positive(),
});

export type IncidentSubmission = z.infer<typeof incidentSubmissionSchema>;

/** The answer to a submitted incident; the runner still re-checks it before acting. */
export interface DecisionResponse {
  incidentId: string;
  decision: Decision;
}

/** What the runner did with a decision. */
export const outcomeSchema = z.object({
  outcome: z.string().max(OUTCOME_TEXT_LIMIT),
  verdict: z.enum(VERDICTS),
  executed: z.boolean(),
});

export type Outcome = z.infer<typeof outcomeSchema>;

const decisionSchema = z.object({
  action: z.enum(ALLOWED_ACTIONS),
  target: containerName,
  diagnosis: z.string().max(DIAGNOSIS_TEXT_LIMIT),
});

/** An incident the runner decided on its own while the control plane was unreachable. */
export const handledIncidentSchema = incidentSubmissionSchema.extend({
  resultId: z.uuid().optional(),
  decision: decisionSchema,
  result: outcomeSchema,
});

export type HandledIncident = z.infer<typeof handledIncidentSchema>;

/** An incident a runner handled, for the control plane to tell people about on their channels. */
export const incidentNoticeSchema = z.object({
  notificationId: z.uuid().optional(),
  containerName,
  verdict: z.enum(VERDICTS),
  outcome: z.string().max(OUTCOME_TEXT_LIMIT),
  diagnosis: z.string().max(DIAGNOSIS_TEXT_LIMIT),
  stateSummary: z.string().max(REPORT_LIMITS.summaryCharacters),
  // Null when the runner decided alone and the incident is not on the dashboard yet.
  incidentId: z.uuid().nullable(),
});

export type IncidentNotice = z.infer<typeof incidentNoticeSchema>;

/** A person approved this action in the dashboard; the runner re-checks it before running it. */
export interface WorkItem {
  id: string;
  incidentId: string;
  containerName: string;
  action: Exclude<AllowedAction, typeof ACTION_ESCALATE>;
  target: string;
  approvedBy: string;
  expiresAt: number;
}

interface JobBase {
  operatorUserId?: string;
  automatic?: boolean;
  id: string;
  // Empty for a job about the host itself.
  containerName: string;
  requestedBy: string;
  expiresAt: number;
}

/** A container action a person (or Autoheal, within its policy) asked for; the runner re-checks it. */
export interface ContainerJob extends JobBase {
  rollout?: RolloutJob;
  expectedResourcesFingerprint?: string;
  action: Exclude<
    ContainerAction,
    | typeof JOB_ACTION.removeImages
    | typeof JOB_ACTION.createNetwork
    | typeof JOB_ACTION.removeNetworks
    | typeof JOB_ACTION.createVolume
    | typeof JOB_ACTION.removeVolumes
    | typeof JOB_ACTION.backupContainer
    | typeof JOB_ACTION.restoreContainer
    | StackAction
  >;
  // An update put back at once when the new container does not come back healthy: the owner chose so.
  undoIfUnhealthy?: boolean;
  // The control plane grants this only to an explicitly requested human update, never agent work.
  allowWithoutCheckpoint?: boolean;
}

/** The unused images a person ticked on the host's page; the runner removes only those still unused. */
export interface ImageJob extends JobBase {
  action: typeof JOB_ACTION.removeImages;
  // Docker's ids for them.
  images: string[];
}

/** A package job on the host itself, which the host's systemd runs; the runner re-checks it. */
export interface HostJob extends JobBase {
  action: HostPackageAction;
  // The packages an upgrade upgrades; empty for every other host job.
  packages: string[];
}

/** A new network, with the containers a person chose put on it. */
export interface NetworkCreationJob extends JobBase {
  action: typeof JOB_ACTION.createNetwork;
  network: NewNetwork;
}

/** Networks to take away; the runner looks again at who is on them first. */
export interface NetworkRemovalJob extends JobBase {
  action: typeof JOB_ACTION.removeNetworks;
  removal: NetworkRemoval;
}

/** A new volume, on the host or on a share. */
export interface VolumeCreationJob extends JobBase {
  action: typeof JOB_ACTION.createVolume;
  volume: NewVolume;
}

/** Volumes to take away; the runner counts again what each holds first. */
export interface VolumeRemovalJob extends JobBase {
  action: typeof JOB_ACTION.removeVolumes;
  removal: VolumeRemoval;
}

export type StackAction =
  | typeof JOB_ACTION.stackUp
  | typeof JOB_ACTION.stackRebuild
  | typeof JOB_ACTION.stackStop
  | typeof JOB_ACTION.stackStart
  | typeof JOB_ACTION.stackRemove;

/** A Compose project as one thing, done by the host's own Compose. */
export interface StackJob extends JobBase {
  action: StackAction;
  stack: StackJobDetails;
}

/** A container or a stack kept in a folder on its host, or put back from there. */
export interface BackupJob extends JobBase {
  action: typeof JOB_ACTION.backupContainer | typeof JOB_ACTION.restoreContainer;
  backup: BackupJobDetails;
}

/** What a runner does with Docker, as opposed to on the host itself. */
export type DockerJob =
  | BackupJob
  | StackJob
  | ContainerJob
  | ImageJob
  | NetworkCreationJob
  | NetworkRemovalJob
  | VolumeCreationJob
  | VolumeRemovalJob;

export type Job = DockerJob | HostJob;

export const isHostJob = (job: Job): job is HostJob => isHostPackageAction(job.action);

/**
 * A shell a person opened in the dashboard, for the runner to start in the container, or on the host itself when
 * there is none; it re-checks it first. Host shells only go to runners that said they can open them.
 */
export interface TerminalStart {
  operatorUserId?: string;
  id: string;
  containerName: string | null;
  columns: number;
  rows: number;
  requestedBy: string;
}

export interface WorkResponse {
  items: WorkItem[];
  jobs: Job[];
}

/** Something to do with a container's files, for its runner, which checks again first as for a shell. */
export interface FileRequest {
  operatorUserId?: string;
  id: string;
  containerName: string;
  operation: FileOperation;
  path: string;
  // A rename's new path; what a write puts in the file, base64.
  to: string | null;
  content: string | null;
  requestedBy: string;
}

/** A container's settings, for its runner to read as they are; or, asked for details, all but its settings. */
export interface SettingsRequest {
  operatorUserId?: string;
  id: string;
  containerName: string;
  requestedBy: string;
  details?: boolean;
  // Joins it to a network, or takes it off one, then answers with its details.
  network?: { name: string; joined: boolean };
}

/** How a host is set up, as its containers show it, for its runner to work out. */
export interface HostProfileRequest {
  id: string;
}

/** What the runner hands out the moment a person asks: shells to open, files to reach, settings to read. */
export interface ContainerAccessWork {
  applicationBackups?: ApplicationBackupTask[];
  previews?: OperationPreviewRequest[];
  terminals: TerminalStart[];
  files: FileRequest[];
  settings: SettingsRequest[];
  // From runners on: an older one never hears of these, and its host's profile waits, then says so.
  profiles?: HostProfileRequest[];
  // What a volume holds, when an admin looks. Only a runner that reports volumes is shown the way to ask.
  volumeLooks?: VolumeLookRequest[];
  // A stack's Compose files, when an admin opens or saves them.
  stacks?: StackRequest[];
  // A container's backups, when an admin opens its dialog.
  backups?: BackupRequest[];
  // Drafts and checks of a new app. Only a runner that says it can is ever asked.
  installs?: InstallRequest[];
}

const settingName = z
  .string()
  .min(1)
  .max(SETTINGS_LIMITS.nameCharacters)
  .regex(/^[^=\0]+$/u);
const settingValue = z
  .string()
  .max(SETTINGS_LIMITS.valueCharacters)
  .regex(/^[^\0]*$/u);
const containerPath = z
  .string()
  .min(1)
  .max(FILE_PATH_CHARACTERS)
  .startsWith("/")
  .regex(/^[^\0:]+$/u);
const settingPort = z.number().int().min(1).max(HIGHEST_PORT);
// A host path for a bind; a volume's name, as Docker takes it, for a volume.
const volumeName = z.string().min(1).max(SETTINGS_LIMITS.nameCharacters).regex(VOLUME_NAME_PATTERN);

/**
 * The settings of a container a person may change, as its runner reads them: its own environment and labels (not
 * what its image sets), published ports, mounts, and restart policy. Everything else stays as it is.
 */
export const containerSettingsSchema = z.object({
  environment: z.array(z.object({ name: settingName, value: settingValue })).max(SETTINGS_LIMITS.entries),
  labels: z.array(z.object({ name: settingName, value: settingValue })).max(SETTINGS_LIMITS.entries),
  ports: z
    .array(
      z.object({
        target: settingPort,
        protocol: z.enum(PORT_PROTOCOLS),
        published: settingPort,
        // Every address of the host when empty.
        address: z.union([z.literal(""), z.ipv4(), z.ipv6()]),
      }),
    )
    .max(SETTINGS_LIMITS.entries),
  mounts: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal(MOUNT_KIND.bind),
          source: containerPath,
          target: containerPath,
          readOnly: z.boolean(),
        }),
        z.object({
          kind: z.literal(MOUNT_KIND.volume),
          source: volumeName,
          target: containerPath,
          readOnly: z.boolean(),
        }),
      ]),
    )
    .max(SETTINGS_LIMITS.entries),
  restart: z.object({
    policy: z.enum(RESTART_POLICIES),
    retries: z.number().int().min(0).max(SETTINGS_LIMITS.retries),
  }),
});
export type ContainerSettings = z.infer<typeof containerSettingsSchema>;

const profileText = z.string().max(HOST_PROFILE.textCharacters);
const profileCount = z.number().int().nonnegative();
// What most of them do, and how many of those that say anything do it.
const profileHabit = z.object({ value: profileText, uses: profileCount, of: profileCount });

/** How a host is set up, worked out from its containers. Holds no environment value but its IDs and time zone. */
export const hostProfileSchema = z.object({
  containers: profileCount,
  user: profileHabit.nullable(),
  timeZone: profileHabit.nullable(),
  restartPolicy: profileHabit.nullable(),
  // The folder most Compose projects live in, each in a folder of its own.
  composeFolder: z.object({ path: profileText, projects: profileCount, of: profileCount }).nullable(),
  // Mounts of a folder beside their own Compose file: the app's own small data.
  mountsBesideCompose: profileCount,
  places: z
    .array(z.object({ path: profileText, mounts: profileCount, availableBytes: z.number().nonnegative().nullable() }))
    .max(HOST_PROFILE.places),
  // Those two or more apps share: what a new one might join.
  networks: z.array(z.object({ name: profileText, containers: profileCount })).max(HOST_PROFILE.networks),
  proxies: z
    .array(z.object({ kind: profileText, container: profileText, network: profileText.nullable() }))
    .max(HOST_PROFILE.proxies),
  databases: z.object({
    common: profileText.nullable(),
    ownToAnApp: profileCount,
    standingAlone: profileCount,
  }),
});
export type HostProfile = z.infer<typeof hostProfileSchema>;

export const hostProfileAnswerSchema = z.object({
  error: z.string().max(OUTCOME_TEXT_LIMIT).nullable(),
  profile: hostProfileSchema.nullable(),
});
export type HostProfileAnswer = z.infer<typeof hostProfileAnswerSchema>;

const detailText = z.string().max(CONTAINER_DETAILS.textCharacters);
const detailList = z.array(detailText).max(CONTAINER_DETAILS.entries);

/** What a container's panel shows beyond its settings, as Docker says it now. Never its environment. */
export const containerDetailsSchema = z.object({
  imageId: detailText.nullable(),
  createdAt: detailText.nullable(),
  startedAt: detailText.nullable(),
  command: detailList,
  workingFolder: detailText,
  user: detailText,
  hostname: detailText,
  networks: z
    .array(z.object({ name: detailText, address: detailText, gateway: detailText, aliases: detailList }))
    .max(CONTAINER_DETAILS.entries),
  // What it could join with a click; absent from runners from before that, and empty in a mode that cannot.
  availableNetworks: detailList.optional(),
  // Where Autoheal installed it; absent from what it did not install, which it will not take away.
  installedIn: detailText.optional(),
  networkMode: detailText.optional(),
  mounts: z
    .array(z.object({ kind: detailText, source: detailText, target: detailText, readOnly: z.boolean() }))
    .max(CONTAINER_DETAILS.entries),
  security: z.object({
    privileged: z.boolean(),
    capabilitiesAdded: detailList,
    capabilitiesDropped: detailList,
    readOnlyRoot: z.boolean(),
    noNewPrivileges: z.boolean(),
    appArmor: detailText,
    seccomp: detailText,
    dockerSocket: z.boolean(),
  }),
  resources: z.object({
    cpuCores: z.number().nonnegative().nullable(),
    memoryBytes: z.number().nonnegative().nullable(),
    processes: z.number().nonnegative().nullable(),
    oomKilled: z.boolean(),
  }),
  // Null when it has no health check.
  health: z
    .object({
      status: detailText,
      test: detailList,
      everySeconds: z.number().nonnegative().nullable(),
      timeoutSeconds: z.number().nonnegative().nullable(),
      failingStreak: z.number().int().nonnegative(),
      checks: z
        .array(z.object({ at: detailText, exitCode: z.number().int(), output: detailText }))
        .max(CONTAINER_DETAILS.healthChecks),
    })
    .nullable(),
  // Null when it runs nothing, or Docker could not say.
  processes: z
    .object({
      titles: detailList,
      rows: z.array(detailList).max(CONTAINER_DETAILS.processes),
    })
    .nullable(),
  layers: z
    .array(z.object({ sizeBytes: z.number().nonnegative(), createdAt: z.number().nonnegative(), step: detailText }))
    .max(CONTAINER_DETAILS.layers),
});
export type ContainerDetailsView = z.infer<typeof containerDetailsSchema>;

/** A runner's answer to reading a container's settings: why it could not, or the settings, or its details. */
export const settingsAnswerSchema = z.object({
  error: z.string().max(OUTCOME_TEXT_LIMIT).nullable(),
  settings: containerSettingsSchema.nullable(),
  details: containerDetailsSchema.nullable().optional(),
});
export type SettingsAnswer = z.infer<typeof settingsAnswerSchema>;

const fileField = z.string().max(FILE_FIELD_CHARACTERS);

/** One entry of a folder, as `ls -la` printed it: its date as printed too. */
export const fileEntrySchema = z.object({
  name: fileField,
  kind: z.enum(FILE_KINDS),
  size: z.number().int().nonnegative(),
  mode: fileField,
  owner: fileField,
  group: fileField,
  modified: fileField,
  linkTarget: z.string().max(FILE_PATH_CHARACTERS).nullable(),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

/** A runner's answer to a file request: why it failed, or a folder's entries, or a file's content (base64). */
export const fileAnswerSchema = z.object({
  error: z.string().max(OUTCOME_TEXT_LIMIT).nullable(),
  entries: z.array(fileEntrySchema).max(FILE_ENTRIES_LIMIT).nullable(),
  // The folder had more than one answer carries.
  truncated: z.boolean(),
  content: z.string().max(FILE_CONTENT_CHARACTERS).nullable(),
});
export type FileAnswer = z.infer<typeof fileAnswerSchema>;

/** What a shell's runner is to do next: type, change size, or end it; all empty when nothing came. */
export interface TerminalInput {
  data: string[];
  size: { columns: number; rows: number } | null;
  closed: boolean;
}

/** What a shell printed, base64: a terminal's bytes need not be text. */
export const terminalOutputSchema = z.object({ data: z.string().max(TERMINAL_OUTPUT_CHUNK_BYTES * 2) });

/** How a shell ended: its exit code when it ran, or why it could not start. */
export const terminalEndSchema = z.object({
  exitCode: z.number().int().nullable(),
  reason: z.string().max(OUTCOME_TEXT_LIMIT).nullable(),
});
export type TerminalEnd = z.infer<typeof terminalEndSchema>;

/** One package an upgrade would change, as apt's simulation of it says. */
export const packageUpdateSchema = z.object({
  name: packageNameSchema,
  installed: packageVersion,
  candidate: packageVersion,
  // Where the candidate comes from: apt's "Debian-Security:13/stable-security", dnf's repository id.
  origins: z.array(z.string().max(PACKAGE_ORIGIN_CHARACTERS)).max(PACKAGE_ORIGINS_PER_PACKAGE),
  // dnf says so from its advisories; apt leaves it to the origins.
  security: z.boolean().optional(),
  // What it is, in a line: apt's for the installed package, dnf's for the candidate. Absent from runners
  // from before it.
  summary: z.string().max(PACKAGE_SUMMARY_CHARACTERS).optional(),
});

export type PackageUpdate = z.infer<typeof packageUpdateSchema>;

/** What a check found: the lists refreshed, and what an upgrade would and would not change. */
export const packageCheckSchema = z.object({
  refreshed: z.boolean(),
  // apt's own words when the lists could not be refreshed; the rest is then from the old lists.
  refreshProblem: z.string().max(ERROR_TEXT_LIMIT).nullable(),
  // dpkg was left half-done: nothing installs until it is repaired.
  needsRepair: z.boolean(),
  upgradable: z.array(packageUpdateSchema).max(HOST_PACKAGE_LIMIT),
  // Held back by a plain upgrade: they need a package added or removed, or are phased in slowly.
  keptBack: z.array(packageUpdateSchema).max(HOST_PACKAGE_LIMIT),
  // What the package manager would remove as no longer needed: old kernels, and what only they needed.
  // Absent from runners from before it.
  removable: z
    .array(z.object({ name: packageNameSchema, installed: packageVersion }))
    .max(HOST_PACKAGE_LIMIT)
    .default([]),
  // dnf's own word on whether a reboot is needed; null where the host's files say it (apt).
  rebootRequired: z.boolean().nullable().default(null),
});

export type PackageCheck = z.infer<typeof packageCheckSchema>;

export const jobResultSchema = z.object({
  succeeded: z.boolean(),
  outcome: z.string().max(OUTCOME_TEXT_LIMIT),
  // Logs, for a logs job; masked before they leave the host.
  output: z.string().max(JOB_OUTPUT_CHARACTERS).nullable(),
  // What a package check found; absent for every other job.
  packages: packageCheckSchema.optional(),
  // A restore's safety copy of what was there, by name: what going back from it means. Absent when there is none.
  recoveryBackupId: z.string().regex(BACKUP_ID).optional(),
});

export type JobResult = z.infer<typeof jobResultSchema>;

/** A container's update as it happens: what it is doing, and each layer of the new image as Docker pulls it. */
export const updateProgressSchema = z.object({
  phase: z.enum(UPDATE_PHASES),
  layers: z
    .array(
      z.object({
        id: z.string().max(PULL_PROGRESS_LIMITS.layerIdCharacters),
        state: z.enum(LAYER_STATES),
        current: z.number().nonnegative(),
        total: z.number().nonnegative().nullable(),
      }),
    )
    .max(PULL_PROGRESS_LIMITS.layers),
  // Bytes come down so far, of how many; null until Docker says each layer's size.
  downloaded: z.number().nonnegative(),
  total: z.number().nonnegative().nullable(),
  bytesPerSecond: z.number().nonnegative().nullable(),
  // Docker's own lines, newest last: one for each layer, as its progress bar reads now.
  log: z.array(z.string().max(PULL_PROGRESS_LIMITS.logCharacters)).max(PULL_PROGRESS_LIMITS.logLines),
});

export type UpdateProgress = z.infer<typeof updateProgressSchema>;

// A package job's live output; or a container update's progress.
export const jobProgressSchema = z.object({
  output: z.string().max(JOB_OUTPUT_CHARACTERS).optional(),
  update: updateProgressSchema.optional(),
});

export type JobProgress = z.infer<typeof jobProgressSchema>;
