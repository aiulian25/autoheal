import type { VolumeReport } from "../shared/volumes.js";
import { RUNNING_VERSION } from "../shared/build-version.js";
import { containerResources } from "./operation-coordinator.js";
import {
  ApplicationBackups,
  HelperImageMissing,
  imageOnHost,
  type ApplicationBackupClient,
} from "./application-backups.js";
import { ContainerBackups } from "./container-backups.js";
import { BACKUP_TEXT } from "../shared/container-backups.js";
import { APPLICATION_HELPER_ERRORS } from "../shared/application-backups.js";
import { randomUUID } from "node:crypto";
import { MaintenanceGate } from "./maintenance.js";
import { ResultJournal } from "./result-journal.js";
import { GuardState, kernelBootId } from "./guard-state.js";
import { RuntimeLifecycle } from "../shared/runtime-lifecycle.js";
import { ShutdownJournal } from "./shutdown-journal.js";
import { OperationJournal } from "./operation-journal.js";
import { setTimeout as sleep } from "node:timers/promises";
import { joinCodeInFile, loadRunnerConfig, type RunnerConfig } from "../config/runner-config.js";
import type { OllamaSettings } from "../config/shared-settings.js";
import { OllamaClient } from "../ollama/ollama-client.js";
import {
  INSTALL_OUTCOMES,
  RUNNER_MESSAGES,
  CONTROL_PLANE_CALLS,
  HOST_PACKAGE_OUTCOMES,
  JOB_OUTCOMES,
  NVIDIA_SMI,
  ALIVE_FILE_PATH,
  EDIT_OUTCOMES,
  EVENT_STREAM_RETRY_MILLISECONDS,
  EXEC_EVENT_PREFIX,
  HEARTBEAT_INTERVAL_MILLISECONDS,
  RUNNER_BODY_LIMIT_BYTES,
  HOST_TEXT_LIMIT,
  INVENTORY_REPORT_DELAY_MILLISECONDS,
  INVENTORY_REPORT_LATEST_MILLISECONDS,
  METRICS_INTERVAL_MILLISECONDS,
  MILLISECONDS_PER_SECOND,
  SETTLE_SECONDS,
  UPDATE_CHECK_INTERVAL_MILLISECONDS,
  UPDATE_FIRST_CHECK_MILLISECONDS,
  WORK_POLL_INTERVAL_MILLISECONDS,
} from "../shared/constants.js";
import { describeError } from "../shared/errors.js";
import { postToGotify } from "../shared/gotify.js";
import { incidentMessage } from "../shared/incident-message.js";
import { log } from "../shared/log.js";
import { untilShutdown } from "../shared/shutdown.js";
import type {
  ContainerSnapshot,
  HeartbeatResponse,
  HostHealth,
  IncidentNotice,
  UnusedImage,
} from "../shared/protocol.js";
import { touchAliveFile } from "./alive-file.js";
import { ContainerInventory } from "./container-inventory.js";
import { ContainerJobs } from "./container-jobs.js";
import { ContainerUpdater } from "./container-updater.js";
import { ControlPlaneClient } from "./control-plane-client.js";
import { Decider, type LocalModel } from "./decider.js";
import { DockerClient, type DockerConnection, type DockerEvent } from "./docker-client.js";
import { Executor, restartChoiceOf } from "./executor.js";
import { allGpus, NvidiaGpus, runLocally, type HostCommand } from "./gpu-metrics.js";
import { answerHostProfile } from "./host-profile.js";
import { SysfsGpus } from "./sysfs-gpus.js";
import { LOCAL_HOST_FILES, type HostFiles } from "./host-files.js";
import { imageStoreOf, readHostHealth } from "./host-health.js";
import { HostMetricsSampler } from "./host-metrics.js";
import { ImageUpdateChecker } from "./image-updates.js";
import { RegistryClient, parseImageReference } from "./registry-client.js";
import { RemedyGuard } from "./remedy-guard.js";
import { Watcher } from "./watcher.js";
import { ApprovedWork } from "./approved-work.js";
import { followContainerAccess, type ContainerAccessDependencies } from "./container-access.js";
import { SettingsReader } from "./container-settings.js";
import { FileOperations } from "./file-operations.js";
import { TerminalSessions, type HostShellOpener } from "./terminal-sessions.js";
import { hostScriptThroughDocker, hostShellThroughDocker } from "./host-shell.js";
import { Installs, type HostScript } from "./installs.js";
import { OwnCompose } from "./own-compose.js";
import { HostPackageJobs, type HostPackageJobsDependencies, type PackageUnitStarter } from "./host-package-jobs.js";
import { LocalDockerConnection } from "./local-docker-connection.js";
import type { NetworkReport } from "../shared/networks.js";
import { networksReport } from "./networks.js";
import { STACK_DRIFT } from "../shared/stacks.js";
import { Stacks, imageExistsWith } from "./stacks.js";
import { lookInsideVolume } from "./volume-look.js";
import { VolumeSizes, volumesReport } from "./volumes.js";
import { unusedImagesReport } from "./unused-images.js";
import { VolumeCheckpoints } from "./volume-checkpoints.js";

/** What the runner reaches besides the control plane: a Docker engine, the host's files, and commands on the host. */
export interface RunnerPorts {
  docker: DockerConnection;
  // The host's files, under the configuration's host root.
  hostFiles: HostFiles;
  hostCommand: HostCommand;
  // The machine the runner runs on, when that is the host: its boot id, and the alive file the health check reads.
  // Null for a host reached over SSH.
  localHost: { currentBoot: () => string | null; aliveFile: string } | null;
  // How a host reached over SSH starts its package jobs: as root, with the password a person saved for it; null
  // without one. A runner on its own host starts them through its helper container instead.
  packageUnits: PackageUnitStarter | null;
  // Autoheal's image as the control plane names it, which a host reached over SSH runs its helpers in once it is
  // there; null on a runner's own host, whose helpers run its own container's image.
  helperImageReference: string | null;
  // A shell on the host: the SSH user's, over its session; null on a runner's own host, where a helper opens root's.
  hostShell: HostShellOpener | null;
  // Runs a script on the host; null where that goes through a helper container of its own.
  hostScript: HostScript | null;
}

/** A runner container's own: the Docker socket it mounts, and the host it runs on. */
export const localRunnerPorts = (config: RunnerConfig): RunnerPorts => ({
  docker: new LocalDockerConnection(config.dockerSocketPath),
  hostFiles: LOCAL_HOST_FILES,
  hostCommand: runLocally,
  localHost: { currentBoot: kernelBootId, aliveFile: ALIVE_FILE_PATH },
  packageUnits: null,
  helperImageReference: null,
  hostShell: null,
  hostScript: null,
});

// Package jobs for a host reached over SSH with no root password saved: each refused, none to follow.
const NO_HOST_PACKAGE_JOBS = {
  run: async () => ({ succeeded: false, outcome: HOST_PACKAGE_OUTCOMES.noRootPassword, output: null }),
  followable: async () => [],
};

/**
 * Package jobs as the host allows them: through the runner's helper container on its own host; over SSH as root,
 * with the host's files read over the session; refused on an SSH host whose root password is not saved.
 */
export function hostPackageJobsOf(
  ports: Pick<RunnerPorts, "localHost" | "packageUnits" | "hostFiles">,
  dependencies: HostPackageJobsDependencies,
): Pick<HostPackageJobs, "run" | "followable"> {
  if (ports.localHost !== null) {
    return new HostPackageJobs(dependencies);
  }
  if (ports.packageUnits === null) {
    return NO_HOST_PACKAGE_JOBS;
  }
  return new HostPackageJobs({ ...dependencies, files: ports.hostFiles, startUnit: ports.packageUnits });
}

interface RunnerRuntime {
  volumeSizes: VolumeSizes;
  stacks: Stacks;
  containerBackups: ContainerBackups | null;
  config: RunnerConfig;
  ports: RunnerPorts;
  // The health check's alive file; null where nothing checks one.
  aliveFile: string | null;
  lifecycle: RuntimeLifecycle;
  shutdownJournal: ShutdownJournal;
  gpus: NvidiaGpus;
  installs: Installs;
  // What the control plane said at the last heartbeat: its Ollama and the dashboard's address.
  fromControlPlane: HeartbeatResponse | null;
  // The Ollama client for the settings in use, made again only when they change.
  localModel: { settings: OllamaSettings; client: OllamaClient } | null;
  // Whether the last heartbeat got through: the first one that does after none did is logged.
  reachingControlPlane: boolean;
  docker: DockerClient;
  guard: RemedyGuard;
  controlPlane: ControlPlaneClient | null;
  decider: Decider;
  watcher: Watcher;
  approvedWork: ApprovedWork | null;
  applicationBackups: ApplicationBackups;
  jobs: ContainerJobs | null;
  inventory: ContainerInventory;
  updates: ImageUpdateChecker;
  hostMetrics: HostMetricsSampler;
  eventStreamConnected: boolean;
  // The last containers reported, sent again if Docker cannot be listed for a moment.
  lastContainers: ContainerSnapshot[];
  reportTimer: NodeJS.Timeout | null;
  // When the first change not reported yet came.
  firstUnreportedAt: number | null;
  maintenance: MaintenanceGate | null;
  heartbeatRunning: boolean;
  heartbeatAgain: boolean;
  metricsRunning: boolean;
  // What went wrong with the last stats report, logged once rather than every few seconds.
  metricsProblem: string | null;
}

// The .env's Ollama wins; else the control plane's, once it has said; else none yet.
function localModelOf(runtime: RunnerRuntime): LocalModel {
  const settings = runtime.config.ollama ?? runtime.fromControlPlane?.ollama ?? null;
  if (settings === null) {
    return null;
  }
  if (runtime.localModel === null || JSON.stringify(runtime.localModel.settings) !== JSON.stringify(settings)) {
    runtime.localModel = { settings, client: new OllamaClient(() => settings) };
  }
  return { client: runtime.localModel.client, contextTokens: settings.contextTokens };
}

/**
 * Tells people about a handled incident through the control plane, which knows their channels.
 * While it is away, this runner's own Gotify gets it instead, when it has one; the log always does.
 */
async function tellPeople(runtime: RunnerRuntime, notice: IncidentNotice) {
  const { config, controlPlane } = runtime;
  const publicBaseUrl = config.publicBaseUrl ?? runtime.fromControlPlane?.publicBaseUrl ?? null;
  const message = incidentMessage(config.hostLabel, notice, publicBaseUrl);
  log(RUNNER_MESSAGES.notification(message.title, message.body));
  const relayed =
    controlPlane !== null &&
    (await controlPlane.notify({ ...notice, notificationId: notice.notificationId ?? randomUUID() }).then(
      () => true,
      (error: unknown) => {
        log(RUNNER_MESSAGES.controlPlaneCall(CONTROL_PLANE_CALLS.notification, describeError(error)));
        return false;
      },
    ));
  if (relayed || config.gotify === null) {
    return;
  }
  await postToGotify(config.gotify, message.title, message.body, message.priority);
}

export async function createRuntime(
  config: RunnerConfig,
  ports: RunnerPorts = localRunnerPorts(config),
): Promise<RunnerRuntime> {
  const { localHost } = ports;
  const transport = new DockerClient(ports.docker);
  const shutdownJournal = new ShutdownJournal(transport, localHost?.currentBoot);
  const docker = shutdownJournal.docker(transport);
  const journal = new OperationJournal(docker);
  const guardState = await GuardState.open(transport);
  const guard = new RemedyGuard(config.protectedContainers, undefined, journal, guardState);
  const maintenance = config.controlPlane === null ? null : new MaintenanceGate();
  guard.maintenanceHeld = (name) => maintenance?.held(name) ?? false;
  const joinFile = config.joinFile;
  const controlPlane =
    config.controlPlane === null
      ? null
      : new ControlPlaneClient(config.controlPlane, joinFile === null ? null : () => joinCodeInFile(joinFile));
  // Recovery identity survives configuration changes, including switching this runner to standalone mode.
  const unavailable = () =>
    Promise.reject(new Error("Application backup reporting requires its enrolled control plane."));
  const standaloneClient: ApplicationBackupClient = {
    authorizeApplicationBackup: async () => false,
    uploadApplicationBackup: unavailable,
    downloadApplicationBackup: unavailable,
    reportApplicationBackup: unavailable,
  };
  const applicationBackups = new ApplicationBackups({
    docker,
    guard,
    selfContainerName: config.selfContainerName,
    ...(ports.helperImageReference === null ? {} : { helperImage: imageOnHost(transport, ports.helperImageReference) }),
    protectedContainers: config.protectedContainers,
    dryRun: () => config.dryRun,
    client: controlPlane ?? standaloneClient,
  });
  await applicationBackups.initialize();
  guard.externalRecoveryBlocked = (name, id) => applicationBackups.isBlocked(name, id);
  const results = await ResultJournal.open(transport);
  const decider = new Decider(controlPlane, () => localModelOf(runtime), undefined, results);
  await decider.flushOutbox();
  const executorCore = new Executor(docker, guard, config, (name) =>
    restartChoiceOf(controlPlane !== null, runtime.fromControlPlane, name),
  );
  const executor = {
    watches: (name: string) => executorCore.watches(name),
    carryOut: (...args: Parameters<Executor["carryOut"]>) =>
      shutdownJournal.run(`healing:${args[0].action}`, args[0].target, async () => {
        const result = await executorCore.carryOut(...args);
        await guard.persisted();
        return result;
      }),
  };
  const notifyPeople = (notice: IncidentNotice) => tellPeople(runtime, notice);
  const watcher = new Watcher({
    docker,
    guard,
    decider,
    executor,
    notify: notifyPeople,
    settings: config,
    settleMilliseconds: SETTLE_SECONDS * MILLISECONDS_PER_SECOND,
  });
  const gpus = new NvidiaGpus(NVIDIA_SMI.command, ports.hostCommand);
  const kernelGpus = new SysfsGpus(config.hostRoot, ports.hostFiles);
  const updates = new ImageUpdateChecker(docker, new RegistryClient());
  const hostScript = ports.hostScript ?? hostScriptThroughDocker(docker, config.selfContainerName, sleep, Date.now);
  const registry = new RegistryClient();
  const stackImageExists = imageExistsWith(
    (reference) => docker.inspectImage(reference),
    async (reference) => {
      const parsed = parseImageReference(reference);
      return parsed === null ? null : registry.digest(parsed);
    },
  );
  const stacks = new Stacks({
    docker,
    hostScript,
    imageExists: stackImageExists,
    settings: config,
    wait: sleep,
    clock: Date.now,
  });
  const installs = new Installs({
    docker,
    registry,
    files: ports.hostFiles,
    hostRoot: config.hostRoot,
    hostScript,
    settings: config,
    wait: sleep,
    clock: Date.now,
    own: new OwnCompose({
      docker,
      files: ports.hostFiles,
      hostRoot: config.hostRoot,
      hostScript,
      imageExists: stackImageExists,
      settings: config,
      maintenanceHeld: (name) => maintenance?.held(name) ?? false,
      wait: sleep,
      clock: Date.now,
    }),
  });
  const runtime: RunnerRuntime = {
    stacks,
    volumeSizes: new VolumeSizes(docker, Date.now, (problem) => log(RUNNER_MESSAGES.volumeSizesFailed(problem))),
    config,
    ports,
    aliveFile: localHost?.aliveFile ?? null,
    lifecycle: new RuntimeLifecycle(),
    shutdownJournal,
    gpus,
    installs,
    fromControlPlane: null,
    localModel: null,
    reachingControlPlane: false,
    docker,
    guard,
    controlPlane,
    decider,
    watcher,
    approvedWork: null,
    applicationBackups,
    jobs: null,
    containerBackups: null,
    inventory: new ContainerInventory(docker, Date.now, updates, journal),
    updates,
    hostMetrics: new HostMetricsSampler({
      hostRoot: config.hostRoot,
      readGpus: () => allGpus(gpus, kernelGpus),
      files: ports.hostFiles,
    }),
    eventStreamConnected: false,
    lastContainers: [],
    reportTimer: null,
    firstUnreportedAt: null,
    maintenance,
    heartbeatRunning: false,
    heartbeatAgain: false,
    metricsRunning: false,
    metricsProblem: null,
  };
  // Data is copied by a helper of this runner's own image; an SSH host has no runner container of its own to take
  // it from, so its updates keep no data, and say so, until that image is pulled there.
  const checkpoints =
    localHost === null
      ? null
      : new VolumeCheckpoints({
          docker,
          selfContainerName: config.selfContainerName,
          limitBytes: config.checkpointLimitBytes,
        });
  const containerBackups = new ContainerBackups({
    docker,
    stacks,
    guard,
    settings: config,
    helperImage:
      ports.helperImageReference === null
        ? async () => {
            const self = await docker.inspect(config.selfContainerName);
            if (!self?.Image) throw new HelperImageMissing(APPLICATION_HELPER_ERRORS.selfMissing);
            return self.Image;
          }
        : imageOnHost(transport, ports.helperImageReference),
    openKey: (jobId, sealedKey) =>
      controlPlane === null
        ? Promise.reject(new Error(BACKUP_TEXT.gone))
        : controlPlane.openBackupKey(jobId, sealedKey),
    reportProgress: (jobId, update) => controlPlane?.reportJobProgress(jobId, { update }) ?? Promise.resolve(),
  });
  await containerBackups.recover().catch(() => undefined);
  runtime.containerBackups = containerBackups;
  guard.externalRecoveryBlocked = (name, id) =>
    applicationBackups.isBlocked(name, id) || containerBackups.isBlocked(name);
  const jobs = new ContainerJobs({
    installs,
    backups: containerBackups,
    stacks,
    installSpecOf: (jobId) =>
      controlPlane === null ? Promise.reject(new Error(INSTALL_OUTCOMES.gone)) : controlPlane.jobInstall(jobId),
    authorizeOperator: (jobId, members) => controlPlane?.authorizeOperatorJob(jobId, members) ?? Promise.resolve(false),
    maintenanceHeld: (name) => maintenance?.held(name) ?? false,
    docker,
    updater: new ContainerUpdater(
      docker,
      sleep,
      Date.now,
      checkpoints,
      journal,
      checkpoints === null ? JOB_OUTCOMES.noDataCopyHere : JOB_OUTCOMES.checkpointUnavailable,
      (imageId, reference) => updates.confirmCurrent(imageId, reference),
    ),
    // An edit job's settings come from the control plane; a runner on its own gets no jobs at all.
    settingsOf: (jobId) =>
      controlPlane === null ? Promise.reject(new Error(EDIT_OUTCOMES.settingsGone)) : controlPlane.jobSettings(jobId),
    updates,
    guard,
    settings: config,
    reportInventory: () => void runtime.lifecycle.run(() => heartbeat(runtime)),
    reportProgress: (jobId, update) => controlPlane?.reportJobProgress(jobId, { update }) ?? Promise.resolve(),
    clearBuildCache: () => runtime.fromControlPlane?.control?.clearBuildCache ?? false,
    undoesFailedUpdate: (name) => runtime.fromControlPlane?.control?.undoFailedUpdates?.includes(name) ?? false,
  });
  runtime.jobs = jobs;
  const hostJobs = hostPackageJobsOf(ports, {
    applicationRecoveryPending: () => applicationBackups.hasPendingRecovery(),
    journal: shutdownJournal,
    docker,
    guard,
    settings: config,
    progress: (jobId, output) => controlPlane?.reportJobProgress(jobId, { output }) ?? Promise.resolve(),
  });
  runtime.approvedWork =
    controlPlane === null
      ? null
      : new ApprovedWork(
          {
            controlPlane,
            docker,
            executor,
            jobs: {
              run: (job) =>
                shutdownJournal.run(`job:${job.id}:${job.action}`, job.containerName, async () => {
                  const result = await jobs.run(job);
                  await guard.persisted();
                  return result;
                }),
            },
            hostJobs: {
              run: (job) => hostJobs.run(job),
              followable: async () => {
                const runs = await hostJobs.followable();
                await shutdownJournal.reconcileHostRuns(runs);
                return runs;
              },
            },
            notify: notifyPeople,
            settings: config,
            maintenanceHeld: (name) => maintenance?.held(name) ?? false,
          },
          results,
        );
  return runtime;
}

/** Every 6 hours: which images have a newer one behind their tag. The dashboard hears at once. */
async function checkUpdates(runtime: RunnerRuntime) {
  try {
    await runtime.updates.checkAll();
    await heartbeat(runtime);
  } catch (error) {
    log(RUNNER_MESSAGES.updateCheckFailed(describeError(error)));
  }
}

function touchAlive(runtime: RunnerRuntime) {
  if (runtime.aliveFile !== null) touchAliveFile(runtime.aliveFile, Date.now());
}

/** Containers that broke while no event stream was connected are handled once it is. */
async function catchUp(runtime: RunnerRuntime, streamLostAt: number | null) {
  try {
    // The events that would have told the inventory what changed were missed too.
    runtime.inventory.invalidateAll();
    const count = runtime.watcher.catchUp(await runtime.inventory.snapshot(), Date.now(), streamLostAt);
    if (count > 0) {
      log(RUNNER_MESSAGES.catchingUp(count));
    }
  } catch (error) {
    log(RUNNER_MESSAGES.catchUpFailed(describeError(error)));
  }
}

/** Follows Docker's events for as long as the runner runs, reconnecting when the stream drops. */
async function watchEvents(runtime: RunnerRuntime, signal: AbortSignal) {
  let streamLostAt: number | null = null;
  while (!signal.aborted) {
    try {
      const events = await runtime.docker.events(signal);
      runtime.eventStreamConnected = true;
      touchAlive(runtime);
      void runtime.lifecycle.run(() => catchUp(runtime, streamLostAt));
      for await (const event of events) {
        await runtime.watcher.handleEvent(event);
        noteContainerChange(runtime, event);
      }
    } catch (error) {
      if (!signal.aborted) {
        log(RUNNER_MESSAGES.eventStreamLost(describeError(error)));
      }
    }
    // A failed attempt to connect again leaves the moment the runner stopped listening as it was.
    if (runtime.eventStreamConnected) {
      streamLostAt = Date.now();
    }
    runtime.eventStreamConnected = false;
    await sleep(EVENT_STREAM_RETRY_MILLISECONDS, undefined, { signal }).catch(() => undefined);
  }
}

/** How long to wait to report changes: until Docker is quiet for a moment, never long after the first of them. */
export const reportDelay = (firstUnreportedAt: number, now: number) =>
  Math.min(
    INVENTORY_REPORT_DELAY_MILLISECONDS,
    Math.max(0, firstUnreportedAt + INVENTORY_REPORT_LATEST_MILLISECONDS - now),
  );

/** A container started, stopped, died or changed health: report it in seconds, not at the next heartbeat. */
function noteContainerChange(runtime: RunnerRuntime, event: DockerEvent) {
  const name = event.Actor?.Attributes?.name;
  if (name === undefined || (event.Action ?? "").startsWith(EXEC_EVENT_PREFIX)) {
    return;
  }
  runtime.inventory.invalidate(name);
  const now = Date.now();
  runtime.firstUnreportedAt ??= now;
  clearTimeout(runtime.reportTimer ?? undefined);
  runtime.reportTimer = setTimeout(
    () => {
      runtime.reportTimer = null;
      runtime.firstUnreportedAt = null;
      void runtime.lifecycle.run(() => heartbeat(runtime));
    },
    reportDelay(runtime.firstUnreportedAt, now),
  );
}

async function currentContainers(runtime: RunnerRuntime): Promise<ContainerSnapshot[]> {
  try {
    runtime.lastContainers = await runtime.inventory.snapshot();
  } catch (error) {
    log(RUNNER_MESSAGES.inventoryFailed(describeError(error)));
  }
  return runtime.lastContainers;
}

// Undefined when Docker could not list them this time: the dashboard keeps the last list.
function currentUnusedImages(runtime: RunnerRuntime): Promise<UnusedImage[] | undefined> {
  return unusedImagesReport(runtime.docker).catch((error: unknown) => {
    log(RUNNER_MESSAGES.imagesFailed(describeError(error)));
    return undefined;
  });
}

// Undefined when Docker could not list them this time: the dashboard keeps the last list.
function currentNetworks(runtime: RunnerRuntime): Promise<NetworkReport[] | undefined> {
  return networksReport(runtime.docker, runtime.config.selfContainerName).catch((error: unknown) => {
    log(RUNNER_MESSAGES.networksFailed(describeError(error)));
    return undefined;
  });
}

// Undefined when Docker could not list them this time: the dashboard keeps the last list.
function currentVolumes(runtime: RunnerRuntime): Promise<VolumeReport[] | undefined> {
  return volumesReport(runtime.docker, runtime.volumeSizes.current()).catch((error: unknown) => {
    log(RUNNER_MESSAGES.volumesFailed(describeError(error)));
    return undefined;
  });
}

function currentHostHealth(runtime: RunnerRuntime): Promise<HostHealth | null> {
  const settings = {
    hostRoot: runtime.config.hostRoot,
    filesystems: runtime.config.hostFilesystems,
    packages: runtime.config.hostPackages,
    files: runtime.ports.hostFiles,
  };
  const dockerVersion = runtime.docker.version().then(
    (version) => version.slice(0, HOST_TEXT_LIMIT),
    () => null,
  );
  const imageStore = runtime.docker.info().then(imageStoreOf, () => null);
  // Only a runner container can be given the host's GPUs; an SSH host's are asked for where they are.
  const gpuNotGiven = runtime.ports.localHost === null ? false : runtime.gpus.notGiven(runtime.config.hostRoot);
  return Promise.all([readHostHealth(settings), dockerVersion, imageStore, gpuNotGiven])
    .then(([health, version, store, notGiven]) => ({
      ...health,
      dockerVersion: version,
      imageStore: store,
      gpuNotGiven: notGiven,
    }))
    .catch((error: unknown) => {
      log(RUNNER_MESSAGES.hostHealthFailed(describeError(error)));
      return null;
    });
}

/**
 * Every 30 s and after container events: prove liveness, report the host, its containers and the images
 * none uses, send what was decided while the control plane was away. One report at a time; a request that arrives
 * meanwhile runs once more afterwards, so the latest change is never left unreported.
 */
async function heartbeat(runtime: RunnerRuntime) {
  if (runtime.eventStreamConnected) {
    touchAlive(runtime);
  }
  if (runtime.controlPlane === null) {
    return;
  }
  if (runtime.heartbeatRunning) {
    runtime.heartbeatAgain = true;
    return;
  }
  runtime.heartbeatRunning = true;
  try {
    const [host, containers, unusedImages, networks, volumes] = await Promise.all([
      currentHostHealth(runtime),
      currentContainers(runtime),
      currentUnusedImages(runtime),
      currentNetworks(runtime),
      currentVolumes(runtime),
    ]);
    const driftReport = runtime.stacks.currentDrift();
    const payload: import("../shared/protocol.js").Heartbeat = {
      applicationBackups: true,
      rollouts: true,
      operationPreviews: true,
      topology: runtime.inventory.topology() ?? undefined,
      resourcePermissions: true,
      maintenanceGeneration: runtime.maintenance?.generation,
      runnerVersion: RUNNING_VERSION,
      hostLabel: runtime.config.hostLabel,
      dryRun: runtime.config.dryRun,
      eventStreamConnected: runtime.eventStreamConnected,
      protectedContainers: [...runtime.config.protectedContainers].sort(),
      restartBudget: runtime.guard.restartsUsed(),
      recoveryHold: runtime.guard.recoveryHold(),
      restartWait: runtime.guard.restartWait(Date.now()),
      host,
      containers,
      unusedImages,
      networks,
      volumes,
      containerAccess: runtime.config.containerAccess,
      docker: true,
      hostTerminal: runtime.config.hostTerminal,
      hostDeploy: runtime.config.hostDeploy,
      ...(driftReport === null ? {} : { stackDrift: driftReport }),
    };
    if (Buffer.byteLength(JSON.stringify(payload)) > RUNNER_BODY_LIMIT_BYTES) delete payload.topology;
    const answer = await runtime.controlPlane.heartbeat(payload);
    runtime.maintenance?.apply(answer?.control?.maintenance);
    runtime.fromControlPlane = answer ?? runtime.fromControlPlane;
    // A reset it had not heard of: the dashboard learns at once, from the report that follows this one.
    if (runtime.guard.resetRestarts(answer?.control?.restartsResetAt, Date.now())) runtime.heartbeatAgain = true;
    if (!runtime.reachingControlPlane) {
      log(RUNNER_MESSAGES.reachedControlPlane(runtime.config.controlPlane?.url ?? ""));
    }
    runtime.reachingControlPlane = true;
    await runtime.decider.flushOutbox();
    await runtime.applicationBackups.flush();
  } catch (error) {
    runtime.reachingControlPlane = false;
    log(RUNNER_MESSAGES.controlPlaneCall(CONTROL_PLANE_CALLS.heartbeat, describeError(error)));
  } finally {
    runtime.heartbeatRunning = false;
  }
  if (runtime.heartbeatAgain && !runtime.lifecycle.stopping) {
    runtime.heartbeatAgain = false;
    await heartbeat(runtime);
  }
}

/**
 * Every 5 s: the host's and its containers' usage, for the dashboard's dials and charts. A part
 * that cannot be read is left out rather than holding back the rest, and a report still on its way
 * when the next is due means that one is skipped.
 */
async function reportMetrics(runtime: RunnerRuntime) {
  const controlPlane = runtime.controlPlane;
  if (controlPlane === null || runtime.metricsRunning) {
    return;
  }
  runtime.metricsRunning = true;
  const problems: string[] = [];
  const noted =
    <Fallback>(fallback: Fallback) =>
    (error: unknown) => {
      problems.push(describeError(error));
      return fallback;
    };
  const [host, containers] = await Promise.all([
    runtime.hostMetrics.sample().catch(noted(null)),
    runtime.inventory.sampleUsage().catch(noted([])),
  ]);
  if (host !== null || containers.length > 0) {
    await controlPlane.reportMetrics({ host, containers }).catch(noted(null));
  }
  const problem = problems.join("; ") || null;
  if (problem !== null && problem !== runtime.metricsProblem) {
    log(RUNNER_MESSAGES.metricsFailed(problem));
  }
  runtime.metricsProblem = problem;
  runtime.metricsRunning = false;
}

async function runApprovedWork(runtime: RunnerRuntime) {
  await runtime.approvedWork
    ?.runOnce()
    .catch((error: unknown) => log(RUNNER_MESSAGES.controlPlaneCall(CONTROL_PLANE_CALLS.work, describeError(error))));
}

/** Shared admission checks for shells/files and application writer operations. */
export function createContainerAccess(runtime: RunnerRuntime) {
  const { controlPlane, docker, config } = runtime;
  if (controlPlane === null) return null;
  const accessScope = async (name: string) => {
    const details = await docker.inspect(name);
    return { details, resources: containerResources(name, details) };
  };
  const requireRecovered = (name: string, id?: string) => {
    if (runtime.applicationBackups.isBlocked(name, id))
      throw new Error("Application data recovery is incomplete. Resume or resolve it before opening this container.");
  };
  const terminals = new TerminalSessions({
    docker: {
      inspect: (name) => docker.inspect(name),
      containerSummaries: () => docker.containerSummaries(),
      inspectVolume: (name) => docker.inspectVolume(name),
      openShell: (name, columns, rows) =>
        runtime.guard.operations.containers(
          () => accessScope(name),
          async ({ details }) => {
            requireRecovered(name, details?.Id);
            return docker.openShell(name, columns, rows);
          },
        ),
    },
    hostShell: runtime.ports.hostShell ?? hostShellThroughDocker(docker, config.selfContainerName),
    controlPlane,
    settings: config,
    authorizeOperator: (requestId, member) => controlPlane.authorizeOperatorAccess("terminal", requestId, member),
  });
  const files = new FileOperations({
    docker,
    settings: config,
    authorizeOperator: (requestId, member) => controlPlane.authorizeOperatorAccess("file", requestId, member),
  });
  const settings = new SettingsReader({
    docker,
    settings: config,
    reportInventory: () => void runtime.lifecycle.run(() => heartbeat(runtime)),
    authorizeOperator: (requestId, member) => controlPlane.authorizeOperatorAccess("settings", requestId, member),
  });
  const dependencies: ContainerAccessDependencies = {
    controlPlane,
    terminals,
    applicationBackups: runtime.applicationBackups,
    recoveryBlocked: (name) =>
      runtime.applicationBackups.isBlocked(name) || runtime.containerBackups?.isBlocked(name) === true,
    backups: {
      answer: (request) =>
        runtime.containerBackups === null
          ? Promise.reject(new Error(JOB_OUTCOMES.noBackupsHere))
          : runtime.containerBackups.answer(request),
    },
    lookInsideVolume: (name) => lookInsideVolume(docker, config, name),
    stacks: runtime.stacks,
    previews: { answer: (request) => runtime.jobs!.preview(request.containerName, request.action) },
    files: {
      answer: (request) =>
        runtime.guard.operations.containers(
          () => accessScope(request.containerName),
          async ({ details }) => {
            if (runtime.applicationBackups.isBlocked(request.containerName, details?.Id))
              return {
                error: "Application data recovery is incomplete. Resume or resolve it before opening this container.",
                entries: null,
                content: null,
                truncated: false,
              };
            return runtime.shutdownJournal.run(`file:${request.id}`, request.containerName, () =>
              files.answer(request),
            );
          },
        ),
    },
    settings,
    installs: runtime.installs,
    profile: () =>
      answerHostProfile({
        docker,
        files: runtime.ports.hostFiles,
        hostRoot: config.hostRoot,
        containerAccess: config.containerAccess,
      }),
  };
  return { terminals, dependencies };
}

/** Checks what the last run left, then starts the runner's loops; the function it gives stops them. */
export async function startRunner(runtime: RunnerRuntime): Promise<() => Promise<void>> {
  const { config, lifecycle } = runtime;
  await runtime.applicationBackups.flush();
  await runtime.approvedWork?.flush().catch((error: unknown) => log(describeError(error)));
  await runtime.shutdownJournal.settleReboots();
  await runtime.shutdownJournal.settleUntouched();
  await runtime.shutdownJournal.assertClean();
  log(
    RUNNER_MESSAGES.watching(
      config.dryRun,
      config.ollama?.model ?? RUNNER_MESSAGES.modelFromControlPlane,
      [...config.protectedContainers].sort(),
      config.controlPlane?.url ?? RUNNER_MESSAGES.standalone,
    ),
  );
  // Reacquire host-operation exclusion before events, healing or newly delivered work can run.
  await runtime.approvedWork?.resumeHostRuns();
  const stopping = new AbortController();
  const watching = watchEvents(runtime, stopping.signal);
  // Shells and files only where this host's .env lets people reach inside its containers.
  const access = createContainerAccess(runtime);
  const terminals = access?.terminals;
  const accessing = access === null ? Promise.resolve() : followContainerAccess(access.dependencies, stopping.signal);
  const heartbeatTimer = setInterval(
    () => void lifecycle.run(() => heartbeat(runtime)),
    HEARTBEAT_INTERVAL_MILLISECONDS,
  );
  const refreshDrift = () =>
    void lifecycle.run(() => runtime.stacks.refreshDrift().catch((error: unknown) => log(describeError(error))));
  const driftFirst = setTimeout(refreshDrift, STACK_DRIFT.firstCheckMilliseconds);
  const driftTimer = setInterval(refreshDrift, STACK_DRIFT.checkEveryMilliseconds);
  const workTimer = setInterval(
    () => void lifecycle.run(() => runApprovedWork(runtime)),
    WORK_POLL_INTERVAL_MILLISECONDS,
  );
  const metricsTimer = setInterval(
    () => void lifecycle.run(() => reportMetrics(runtime)),
    METRICS_INTERVAL_MILLISECONDS,
  );
  // Only a runner that reports somewhere has anyone to tell about updates.
  const updatesFirst =
    config.controlPlane === null
      ? null
      : setTimeout(() => void lifecycle.run(() => checkUpdates(runtime)), UPDATE_FIRST_CHECK_MILLISECONDS);
  const updatesTimer =
    config.controlPlane === null
      ? null
      : setInterval(() => void lifecycle.run(() => checkUpdates(runtime)), UPDATE_CHECK_INTERVAL_MILLISECONDS);
  void lifecycle.run(() => reportMetrics(runtime));
  void lifecycle.run(() => heartbeat(runtime));
  return async () => {
    lifecycle.stop();
    runtime.approvedWork?.stop();
    runtime.watcher.stop();
    terminals?.stop();
    clearInterval(heartbeatTimer);
    clearTimeout(driftFirst);
    clearInterval(driftTimer);
    clearInterval(workTimer);
    clearInterval(metricsTimer);
    clearTimeout(updatesFirst ?? undefined);
    clearInterval(updatesTimer ?? undefined);
    clearTimeout(runtime.reportTimer ?? undefined);
    stopping.abort();
    await Promise.all([
      watching,
      accessing,
      lifecycle.settled(),
      runtime.approvedWork?.settled(),
      runtime.watcher.settled(),
      terminals?.settled(),
    ]);
    await runtime.guard.persisted();
    await runtime.shutdownJournal.hostLaunchesSettled();
    await runtime.applicationBackups.flush();
    await runtime.approvedWork?.flush();
    await runtime.decider.flushOutbox();
    if (runtime.decider.pendingHandled > 0)
      throw new Error("Locally decided outcomes remain unacknowledged at shutdown.");
  };
}

export async function runRunner(): Promise<number> {
  const runtime = await createRuntime(loadRunnerConfig(process.env));
  return untilShutdown(await startRunner(runtime));
}
