import { statSync } from "node:fs";
import { handOverToRelease, lastUpdateOf } from "./runner-self-update.js";
import type { VolumeReport } from "../shared/volumes.js";
import { RUNNING_VERSION } from "../shared/build-version.js";
import { containerResources } from "./operation-coordinator.js";
import {
  ApplicationBackups,
  HelperImageMissing,
  type HelperImage,
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
  RUNNER_UPDATE_TEXT,
  EDIT_OUTCOMES,
  EVENT_STREAM_CHECK_MILLISECONDS,
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
  RUNNER_CAPABILITY,
  type RunnerCapability,
} from "../shared/constants.js";
import { describeError } from "../shared/errors.js";
import { postToGotify } from "../shared/gotify.js";
import { incidentMessage } from "../shared/incident-message.js";
import { log } from "../shared/log.js";
import { untilShutdown } from "../shared/shutdown.js";
import {
  TRIMMABLE_HEARTBEAT_PARTS,
  type ContainerSnapshot,
  type Heartbeat,
  type HeartbeatResponse,
  type HostHealth,
  type IncidentNotice,
  type UnusedImage,
} from "../shared/protocol.js";
import { touchAliveFile } from "./alive-file.js";
import { ContainerInventory } from "./container-inventory.js";
import { ContainerJobs } from "./container-jobs.js";
import { ContainerUpdater } from "./container-updater.js";
import { ControlPlaneClient, type ControlPlaneConnection } from "./control-plane-client.js";
import { Decider, type LocalModel } from "./decider.js";
import { DockerClient, type DockerConnection, type DockerEvent } from "./docker-client.js";
import { withRunnerToken } from "./runner-token.js";
import { EventStreamCheck } from "./event-stream-check.js";
import { Executor, restartChoiceOf } from "./executor.js";
import { allGpus, NvidiaGpus, runLocally, type HostCommand } from "./gpu-metrics.js";
import { answerHostProfile } from "./host-profile.js";
import { SysfsGpus } from "./sysfs-gpus.js";
import { LOCAL_HOST_FILES, type HostFiles } from "./host-files.js";
import { imageStoreOf, readHostHealth } from "./host-health.js";
import { HostMetricsSampler } from "./host-metrics.js";
import { ImageUpdateChecker } from "./image-updates.js";
import { EMPTY_TRUST_POLICY, type ImageTrustPolicy } from "../shared/image-provenance.js";
import { ImageProvenanceReader } from "./image-provenance.js";
import { PROBE_LIMITS } from "../shared/probes.js";
import type { JobResult, ProbeReport } from "../shared/protocol.js";
import { ServiceProbes } from "./service-probes.js";
import type { ProvenanceSource } from "./image-updates.js";
import type { RegistryAccess } from "../shared/registry-credentials.js";
import { RegistryClient, parseImageReference } from "./registry-client.js";
import { RemedyGuard } from "./remedy-guard.js";
import { Watcher } from "./watcher.js";
import { ApprovedWork } from "./approved-work.js";
import { followContainerAccess, type ContainerAccessDependencies } from "./container-access.js";
import { SettingsReader } from "./container-settings.js";
import { FileOperations } from "./file-operations.js";
import { TerminalSessions, type HostShellOpener } from "./terminal-sessions.js";
import { hostScriptThroughDocker, hostShellThroughDocker, removeLeftHelpers } from "./host-shell.js";
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
  // For a runner inside the control plane: its connection as the control plane has it now, read once the key it
  // trusted stops matching, as a renewed certificate may bring a new one. A runner container reads its join file.
  reconnect?: () => ControlPlaneConnection;
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
  results: ResultJournal;
  gpus: NvidiaGpus;
  installs: Installs;
  // What the control plane said at the last heartbeat: its Ollama and the dashboard's address.
  fromControlPlane: HeartbeatResponse | null;
  // The private registries this host may use, read at each pull and check: the control plane's last word on them.
  registries: { allowed: readonly RegistryAccess[] };
  // The publishers this fleet trusts and where an update waits for a signed image.
  trust: { policy: ImageTrustPolicy };
  // The service checks this host makes from where it is, and what the last ones it was given saw.
  serviceProbes: { checks: ServiceProbes; reports: ProbeReport[] };
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
  // The last containers reported, sent again if Docker cannot be listed for a moment, and whether that is so now.
  lastContainers: ContainerSnapshot[];
  containersStale: boolean;
  reportTimer: NodeJS.Timeout | null;
  // When the first change not reported yet came.
  firstUnreportedAt: number | null;
  maintenance: MaintenanceGate | null;
  heartbeatRunning: boolean;
  heartbeatAgain: boolean;
  metricsRunning: boolean;
  // What went wrong with the last stats report, logged once rather than every few seconds.
  metricsProblem: string | null;
  // Why the control plane's last maintenance policy was not taken, logged once rather than at every heartbeat.
  maintenanceProblem: string | null;
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

// Only a runner container of its own can be replaced from here: not the control plane looking after its own machine
// (in place, with its own alive file), nor a host reached over SSH (no local host, and no container of its own).
const isSidecar = (runtime: RunnerRuntime) => runtime.aliveFile === ALIVE_FILE_PATH;

/**
 * This sidecar runner handing itself over to the release its control plane runs: the job's outcome says whether it
 * was handed over, or why nothing changed. Its own container is the one its settings name, as for every other
 * job that needs it: a hostname is not the container's id on the host's network or with a hostname of its own.
 */
async function updateThisRunner(
  docker: DockerClient,
  selfContainerName: string,
  socketPath: string,
  release: string | null,
  provenance: ProvenanceSource,
): Promise<JobResult> {
  if (release === null) return { succeeded: false, outcome: RUNNER_UPDATE_TEXT.noRelease, output: null };
  const own = { reference: selfContainerName, socketPath, socketGroup: statSync(socketPath).gid };
  const handed = await handOverToRelease(docker, own, release, provenance);
  return { succeeded: handed.handedOver || handed.upToDate === true, outcome: handed.outcome, output: null };
}

export async function createRuntime(
  config: RunnerConfig,
  ports: RunnerPorts = localRunnerPorts(config),
): Promise<RunnerRuntime> {
  const { localHost } = ports;
  const registries: { allowed: readonly RegistryAccess[] } = { allowed: [] };
  // Which publishers this fleet trusts and where a signed image is required: the control plane's last word on it.
  const trust: { policy: ImageTrustPolicy } = { policy: EMPTY_TRUST_POLICY };
  const transport = new DockerClient(ports.docker, () => registries.allowed);
  const shutdownJournal = new ShutdownJournal(transport, localHost?.currentBoot);
  const docker = shutdownJournal.docker(transport);
  const journal = new OperationJournal(docker);
  const guardState = await GuardState.open(transport);
  const guard = new RemedyGuard(config.protectedContainers, undefined, journal, guardState);
  const maintenance = config.controlPlane === null ? null : new MaintenanceGate();
  guard.maintenanceHeld = (name) => maintenance?.held(name) ?? false;
  const joinFile = config.joinFile;
  const reload = ports.reconnect ?? (joinFile === null ? null : () => joinCodeInFile(joinFile));
  const controlPlane =
    config.controlPlane === null
      ? null
      : new ControlPlaneClient(config.controlPlane, reload, runnerCapabilities(config));
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
  const provenanceRegistry = new RegistryClient(fetch, () => registries.allowed);
  const provenance = new ImageProvenanceReader(provenanceRegistry, () => trust.policy);
  const provenanceSource: ProvenanceSource = {
    policy: () => trust.policy,
    read: (reference, digest) => provenance.read(reference, digest),
  };
  const updates = new ImageUpdateChecker(docker, provenanceRegistry, Date.now, provenanceSource);
  const hostScript = ports.hostScript ?? hostScriptThroughDocker(docker, config.selfContainerName, sleep, Date.now);
  const registry = new RegistryClient(fetch, () => registries.allowed);
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
    results,
    gpus,
    installs,
    fromControlPlane: null,
    registries,
    trust,
    serviceProbes: { checks: new ServiceProbes(), reports: [] },
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
    containersStale: false,
    reportTimer: null,
    firstUnreportedAt: null,
    maintenance,
    heartbeatRunning: false,
    heartbeatAgain: false,
    metricsRunning: false,
    metricsProblem: null,
    maintenanceProblem: null,
  };
  // Data is copied and backed up by helpers of Autoheal's image: this runner's own container's, or on an SSH host,
  // which has none, the image the control plane names, pulled there the first time.
  const helperImage: HelperImage =
    ports.helperImageReference === null
      ? async () => {
          const self = await docker.inspect(config.selfContainerName);
          if (!self?.Image) throw new HelperImageMissing(APPLICATION_HELPER_ERRORS.selfMissing);
          return self.Image;
        }
      : imageOnHost(transport, ports.helperImageReference);
  const checkpoints = new VolumeCheckpoints({ docker, helperImage, limitBytes: config.checkpointLimitBytes });
  const containerBackups = new ContainerBackups({
    docker,
    stacks,
    guard,
    settings: config,
    helperImage,
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
    checkpoints,
    ...(isSidecar(runtime)
      ? {
          updateRunner: () =>
            updateThisRunner(
              docker,
              config.selfContainerName,
              config.dockerSocketPath,
              runtime.fromControlPlane?.release?.image ?? null,
              provenanceSource,
            ),
        }
      : {}),
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
      JOB_OUTCOMES.checkpointUnavailable,
      (imageId, reference) => updates.confirmCurrent(imageId, reference),
      provenanceSource,
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

/** Every hour: which images have a newer one behind their tag. The dashboard hears at once. */
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

/** One look at the container listing: a break the stream missed at two looks in a row drops it, to connect again. */
async function lookAtStream(runtime: RunnerRuntime, check: EventStreamCheck, silent: AbortController) {
  // Docker not answering says nothing either way: the next look asks again.
  const summaries = await runtime.docker.containerSummaries().catch(() => null);
  const missed = summaries === null ? null : check.missed(summaries);
  if (missed === null || silent.signal.aborted) return;
  log(RUNNER_MESSAGES.eventStreamSilent(missed));
  silent.abort();
}

/**
 * Follows Docker's events for as long as the runner runs, connecting again when the stream drops, or when it falls
 * silent: Docker writes nothing while nothing happens, so the container listing is looked at for what it missed.
 */
export async function watchEvents(
  runtime: RunnerRuntime,
  signal: AbortSignal,
  lookEvery: number = EVENT_STREAM_CHECK_MILLISECONDS,
) {
  let streamLostAt: number | null = null;
  while (!signal.aborted) {
    const silent = new AbortController();
    const check = new EventStreamCheck();
    // The last moment this stream was known to work: when it connected, or its latest event.
    let heardAt = Date.now();
    let looking = false;
    const look = () => {
      if (looking) return;
      looking = true;
      void runtime.lifecycle
        .run(() => lookAtStream(runtime, check, silent))
        .finally(() => {
          looking = false;
        });
    };
    let looks: NodeJS.Timeout | undefined;
    try {
      const events = await runtime.docker.events(AbortSignal.any([signal, silent.signal]));
      runtime.eventStreamConnected = true;
      heardAt = Date.now();
      touchAlive(runtime);
      void runtime.lifecycle.run(() => catchUp(runtime, streamLostAt));
      look();
      looks = setInterval(look, lookEvery);
      for await (const event of events) {
        heardAt = Date.now();
        check.note(event);
        await runtime.watcher.handleEvent(event);
        noteContainerChange(runtime, event);
      }
    } catch (error) {
      if (!signal.aborted && !silent.signal.aborted) {
        log(RUNNER_MESSAGES.eventStreamLost(describeError(error)));
      }
    } finally {
      clearInterval(looks);
    }
    // A failed attempt to connect again leaves this as it was. Catching up starts from the stream's last word, not
    // from when it was found gone: one that fell silent stopped telling before that.
    if (runtime.eventStreamConnected) {
      streamLostAt = heardAt;
    }
    runtime.eventStreamConnected = false;
    // A silent stream is replaced at once; one that failed is tried again in a moment.
    if (!silent.signal.aborted) {
      await sleep(EVENT_STREAM_RETRY_MILLISECONDS, undefined, { signal }).catch(() => undefined);
    }
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
      void runtime.lifecycle.run(() => heartbeat(runtime, { containersOnly: true }));
    },
    reportDelay(runtime.firstUnreportedAt, now),
  );
}

async function currentContainers(runtime: RunnerRuntime): Promise<ContainerSnapshot[]> {
  try {
    runtime.lastContainers = await runtime.inventory.snapshot();
    runtime.containersStale = false;
  } catch (error) {
    log(RUNNER_MESSAGES.inventoryFailed(describeError(error)));
    runtime.containersStale = true;
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
/** What this runner can do, as its .env allows: the list its requests name, and its heartbeat says field by field. */
export function runnerCapabilities(config: RunnerConfig): RunnerCapability[] {
  // A tag change edits the Compose files, and keeps the data of what it moves aside first.
  const changesTags = config.containerAccess && config.hostDeploy && config.checkpointLimitBytes > 0 && !config.dryRun;
  return [
    RUNNER_CAPABILITY.resourcePermissions,
    RUNNER_CAPABILITY.operationPreviews,
    RUNNER_CAPABILITY.rollouts,
    RUNNER_CAPABILITY.applicationBackups,
    RUNNER_CAPABILITY.applicationBootDrills,
    ...(changesTags ? [RUNNER_CAPABILITY.tagChanges] : []),
  ];
}

/**
 * The heartbeat as it fits the runner API: what it can do without left out, least needed first, until it fits, and
 * named in it. A host with more than fits otherwise stays on the dashboard, its containers always reported.
 */
export function fitted(payload: Heartbeat, limit: number = RUNNER_BODY_LIMIT_BYTES): Heartbeat {
  const fits = (report: Heartbeat) => Buffer.byteLength(JSON.stringify(report)) <= limit;
  if (fits(payload)) return payload;
  let report: Heartbeat = { ...payload, trimmed: [] };
  for (const part of TRIMMABLE_HEARTBEAT_PARTS) {
    // Only what it carries can be left out of it.
    const carried = part === "host" ? report.host !== null : report[part] !== undefined;
    if (!carried) continue;
    report = { ...report, [part]: part === "host" ? null : undefined, trimmed: [...report.trimmed!, part] };
    if (fits(report)) break;
  }
  return report;
}

/**
 * The maintenance policy an answer gives. One this runner cannot take (its clock too far off, say) keeps its automatic
 * actions paused, as the gate holds them, and is said once in the log: the rest of the answer still counts.
 */
function applyMaintenance(runtime: RunnerRuntime, policy: unknown) {
  try {
    runtime.maintenance?.apply(policy);
    runtime.maintenanceProblem = null;
  } catch (error) {
    const problem = describeError(error);
    if (problem !== runtime.maintenanceProblem) log(problem);
    runtime.maintenanceProblem = problem;
  }
}

/**
 * A report to the control plane. One made because containers changed carries them alone: the rest changes rarely, the
 * full report every 30 seconds brings it, and absent (the host's health, null) the dashboard keeps what it was told.
 */
async function heartbeat(runtime: RunnerRuntime, { containersOnly = false }: { containersOnly?: boolean } = {}) {
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
    const full = !containersOnly;
    const [host, containers, unusedImages, networks, volumes, clockOffset, runnerUpdate] = await Promise.all([
      full ? currentHostHealth(runtime) : null,
      currentContainers(runtime),
      full ? currentUnusedImages(runtime) : undefined,
      full ? currentNetworks(runtime) : undefined,
      full ? currentVolumes(runtime) : undefined,
      full ? runtime.ports.hostFiles.clockOffset() : null,
      full && isSidecar(runtime) ? lastUpdateOf(runtime.docker).catch(() => undefined) : undefined,
    ]);
    const driftReport = full ? runtime.stacks.currentDrift() : null;
    const clockOffSeconds = runtime.maintenance?.clockOffSeconds ?? null;
    // The dashboard keeps these fields, and checks the same names on each request.
    const capabilities = new Set(runnerCapabilities(runtime.config));
    const payload: Heartbeat = {
      applicationBackups: capabilities.has(RUNNER_CAPABILITY.applicationBackups),
      rollouts: capabilities.has(RUNNER_CAPABILITY.rollouts),
      operationPreviews: capabilities.has(RUNNER_CAPABILITY.operationPreviews),
      tagChanges: capabilities.has(RUNNER_CAPABILITY.tagChanges),
      topology: full ? (runtime.inventory.topology() ?? undefined) : undefined,
      resourcePermissions: capabilities.has(RUNNER_CAPABILITY.resourcePermissions),
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
      serviceProbes: true,
      ...(runtime.serviceProbes.reports.length === 0 ? {} : { probeResults: runtime.serviceProbes.reports }),
      ...(driftReport === null ? {} : { stackDrift: driftReport }),
      ...(clockOffSeconds === null ? {} : { clockSkewSeconds: clockOffSeconds }),
      ...(clockOffset === null ? {} : { hostClock: Date.now() + clockOffset }),
      ...(runnerUpdate === undefined ? {} : { runnerUpdate }),
      ...(runtime.containersStale ? { containersStale: true } : {}),
    };
    const answer = await runtime.controlPlane.heartbeat(fitted(payload));
    applyMaintenance(runtime, answer?.control?.maintenance);
    runtime.fromControlPlane = answer ?? runtime.fromControlPlane;
    // A rotated or revoked credential stops being used from the next pull or check on, and a changed trust policy
    // makes every image's provenance a fresh question.
    if (answer !== null) {
      runtime.registries.allowed = answer.registries ?? [];
      runtime.trust.policy = answer.imageTrust ?? EMPTY_TRUST_POLICY;
      // What was reported has been taken; the checks this answer gives are made before the next report.
      runtime.serviceProbes.reports = [];
      const given = answer.probes ?? [];
      if (given.length > 0) {
        // The whole batch is bounded by the deadline the control plane waits for, each check by its own timeout.
        const deadline = AbortSignal.timeout(PROBE_LIMITS.vantageDeadlineSeconds * MILLISECONDS_PER_SECOND);
        runtime.serviceProbes.reports = await runtime.serviceProbes.checks.run(given, deadline).catch(() => []);
        runtime.heartbeatAgain = true;
      }
    }
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
    hostShell:
      runtime.ports.hostShell ?? hostShellThroughDocker(docker, config.selfContainerName, config.hostTerminalUser),
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
        details: (summary) => runtime.inventory.detailsOf(summary),
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
  // Before anything here can open a shell or run a script on the host.
  await removeLeftHelpers(runtime.docker).catch((error: unknown) => log(describeError(error)));
  await runtime.applicationBackups.flush();
  await runtime.approvedWork?.flush().catch((error: unknown) => log(describeError(error)));
  await runtime.shutdownJournal.settleReboots();
  await runtime.shutdownJournal.settleUntouched();
  await runtime.shutdownJournal.assertClean();
  // Nothing is half done now: what jobs an earlier runner never finished no longer hold their containers.
  await runtime.results.settleInterrupted();
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
  const given = loadRunnerConfig(process.env);
  const runtime = await createRuntime(await withRunnerToken(given, new DockerClient(given.dockerSocketPath)));
  return untilShutdown(await startRunner(runtime));
}
