import type { ContainerBackups } from "./container-backups.js";
import { STACK_OUTCOMES } from "../shared/constants.js";
import { VOLUME_SHARE, type NewVolume, type VolumeRemoval } from "../shared/volumes.js";
import { operationFingerprint, publicOperationResources, OPERATION_SCOPE_CHANGED } from "./operation-impact.js";
import type { OperationPreviewAnswer, PreviewAction } from "../shared/topology.js";
import {
  isolatedOperatorContainer,
  OPERATOR_REFUSAL,
  OPERATOR_ISOLATION_REFUSAL,
  OPERATOR_MOUNTS_REFUSAL,
  operatorAccessTarget,
  operatorTarget,
  unchangedOperatorBoundaries,
  type OperatorJobAuthorizer,
  type OperatorTarget,
} from "./operator-authorization.js";
import { sharesRollbackData } from "./rollback-data.js";
import { updateGroupOf } from "./update-group.js";
import {
  HOST_DEPLOY_REFUSALS,
  INSTALL_OUTCOMES,
  CONTAINER_ACCESS_REFUSALS,
  EDIT_OUTCOMES,
  JOB_ACTION,
  JOB_OUTCOMES,
  JOB_OUTPUT_CHARACTERS,
  JOB_VERBS,
  OUTCOME_TEXT_LIMIT,
  PRUNE_OUTCOMES,
  STOP_GRACE_SECONDS,
  OLD_CONTAINER_SUFFIX,
  UPDATE_PHASE,
  NETWORK_MODE_CONTAINER_PREFIX,
  isParkedContainer,
  updatedNameOf,
  NETWORK_OUTCOMES,
  VOLUME_OUTCOMES,
  type ContainerAction,
} from "../shared/constants.js";
import { describeError } from "../shared/errors.js";
import { isLocked, type NetworkRemoval, type NewNetwork } from "../shared/networks.js";
import type {
  ContainerJob,
  ContainerSettings,
  DockerJob,
  JobResult,
  StackAction,
  StackJob,
  BackupJob,
  UpdateProgress,
} from "../shared/protocol.js";
import { redactSecrets } from "../shared/redaction.js";
import type { ActionResult, ContainerUpdater } from "./container-updater.js";
import type { DockerClient, DockerNetwork, ImageSummary } from "./docker-client.js";
import type { ImageUpdateChecker } from "./image-updates.js";
import type { RemedyGuard } from "./remedy-guard.js";
import { networksReport } from "./networks.js";
import type { SettingsWrite, Stacks } from "./stacks.js";
import { volumesReport } from "./volumes.js";
import { isKeptByUpdate, namesOf, sizeOf, unusedImages } from "./unused-images.js";
import { containerResources } from "./operation-coordinator.js";
import type { ContainerDetails } from "./incident-report.js";
import type { InstallDetails } from "../shared/install.js";
import type { Installs } from "./installs.js";
import { UpdateReport } from "./update-progress.js";

export interface ContainerJobsDependencies {
  authorizeOperator?: OperatorJobAuthorizer;
  maintenanceHeld?: (name: string) => boolean;
  docker: Pick<
    DockerClient,
    | "inspect"
    | "restart"
    | "start"
    | "stop"
    | "pause"
    | "unpause"
    | "removeStopped"
    | "logs"
    | "allEnvironmentEntries"
    | "containerSummaries"
    | "images"
    | "removeImage"
    | "pruneBuildCache"
    | "networks"
    | "createNetwork"
    | "removeNetwork"
    | "connect"
    | "allVolumes"
    | "volumeSizes"
    | "createVolume"
    | "removeVolume"
  > &
    Partial<Pick<DockerClient, "inspectVolume" | "inspectImage">>;
  updater: Pick<ContainerUpdater, "update" | "rollBack" | "edit" | "editRefusal" | "recreate" | "dependentsOf">;
  // A container given to Ollama: its update is undone at once when the new version starts badly.
  undoesFailedUpdate: (name: string) => boolean;
  // The settings an edit applies, fetched from the control plane when it runs: they are kept nowhere.
  settingsOf: (jobId: string) => Promise<ContainerSettings>;
  // Putting a new app on the host, where this runner can; its details fetched as an edit's settings are.
  installs?: Pick<Installs, "install" | "installOwn" | "uninstall">;
  stacks?: Pick<Stacks, "run" | "membersOf" | "applySettings">;
  backups?: Pick<ContainerBackups, "run">;
  installSpecOf?: (jobId: string) => Promise<InstallDetails>;
  updates: Pick<ImageUpdateChecker, "checkAll">;
  guard: Pick<RemedyGuard, "hold" | "release" | "operations" | "rollbackOf" | "persisted" | "noteKill"> &
    Partial<Pick<RemedyGuard, "externalRecoveryBlocked">>;
  settings: {
    containerAccess: boolean;
    dryRun: boolean;
    protectedContainers: ReadonlySet<string>;
    selfContainerName: string;
  };
  // Called after an update check or a clean-up, so the dashboard sees the results without waiting for a heartbeat.
  reportInventory: () => void;
  // An update's or a recreate's progress, for the dashboard to show as it happens; lost ones are no matter.
  reportProgress: (jobId: string, progress: UpdateProgress) => Promise<unknown>;
  // Whether the host's page has an image clean-up clear Docker's build cache too.
  clearBuildCache: () => boolean;
}

type ChangingAction = Exclude<
  ContainerAction,
  | typeof JOB_ACTION.logs
  | typeof JOB_ACTION.checkUpdates
  | typeof JOB_ACTION.pruneImages
  | typeof JOB_ACTION.removeImages
  | typeof JOB_ACTION.createNetwork
  | typeof JOB_ACTION.removeNetworks
  | typeof JOB_ACTION.createVolume
  | typeof JOB_ACTION.removeVolumes
  | typeof JOB_ACTION.backupContainer
  | typeof JOB_ACTION.restoreContainer
  | StackAction
  | typeof JOB_ACTION.install
  | typeof JOB_ACTION.uninstall
  | typeof JOB_ACTION.uninstallWithData
>;

// Docker's own local driver mounts the share: nothing needs installing on the host beyond what mounting it takes.
function shareOptionsOf({ kind, address, path }: NonNullable<NewVolume["share"]>): Record<string, string> {
  return kind === VOLUME_SHARE.nfs
    ? { type: "nfs", o: `addr=${address},rw`, device: `:${path}` }
    : { type: "cifs", o: `addr=${address},guest`, device: `//${address}${path}` };
}

const STACK_ACTIONS: ReadonlySet<string> = new Set([
  JOB_ACTION.stackUp,
  JOB_ACTION.stackRebuild,
  JOB_ACTION.stackStop,
  JOB_ACTION.stackStart,
  JOB_ACTION.stackRemove,
]);
const isStackJob = (job: DockerJob): job is StackJob => STACK_ACTIONS.has(job.action);
const isBackupJob = (job: DockerJob): job is BackupJob =>
  job.action === JOB_ACTION.backupContainer || job.action === JOB_ACTION.restoreContainer;

const asJobResult = ({ succeeded, outcome }: ActionResult): JobResult => ({ succeeded, outcome, output: null });

// The actions that recreate or restart a container together with those in its network.
const GROUP_ACTIONS: ReadonlySet<string> = new Set([JOB_ACTION.update, JOB_ACTION.rollBack]);

/**
 * Container actions a person asked for in the dashboard. The host decides as for healing: protected
 * containers and the runner itself are never changed, and in dry-run nothing is changed at all.
 * Reading logs and checking for updates change nothing, so they always run.
 */
export class ContainerJobs {
  private readonly changes: Record<
    ChangingAction,
    (name: string, job: ContainerJob, authorize?: () => Promise<boolean>) => Promise<ActionResult>
  >;

  constructor(private readonly dependencies: ContainerJobsDependencies) {
    const { docker, updater, stacks, settingsOf, undoesFailedUpdate, reportProgress } = dependencies;
    const reportFor = (job: ContainerJob) =>
      new UpdateReport((progress) => void reportProgress(job.id, progress).catch(() => undefined));
    const done = (verb: string, name: string): ActionResult => ({
      succeeded: true,
      outcome: JOB_OUTCOMES.done(verb, name),
    });
    this.changes = {
      [JOB_ACTION.restart]: async (name) => {
        await docker.restart(name);
        return done(JOB_VERBS.restart, name);
      },
      [JOB_ACTION.start]: async (name) => {
        await docker.start(name);
        return done(JOB_VERBS.start, name);
      },
      [JOB_ACTION.stop]: async (name) => {
        await docker.stop(name, STOP_GRACE_SECONDS);
        return done(JOB_VERBS.stop, name);
      },
      [JOB_ACTION.pause]: async (name) => {
        await docker.pause(name);
        return done(JOB_VERBS.pause, name);
      },
      [JOB_ACTION.unpause]: async (name) => {
        await docker.unpause(name);
        return done(JOB_VERBS.unpause, name);
      },
      // A running one is stopped first, as gently as a stop: removing it never kills it outright.
      [JOB_ACTION.remove]: async (name) => {
        if ((await docker.inspect(name))?.State.Running === true) {
          await docker.stop(name, STOP_GRACE_SECONDS);
        }
        await docker.removeStopped(name);
        return done(JOB_VERBS.remove, name);
      },
      [JOB_ACTION.update]: (name, job, authorize) =>
        updater.update(name, job.undoIfUnhealthy === true || undoesFailedUpdate(name), reportFor(job), {
          allowWithoutCheckpoint: !job.rollout && job.allowWithoutCheckpoint === true,
          ...(job.rollout ? { rollout: job.rollout } : {}),
          ...(authorize ? { authorize } : {}),
        }),
      [JOB_ACTION.rollBack]: (name, _job, authorize) =>
        authorize ? updater.rollBack(name, authorize) : updater.rollBack(name),
      [JOB_ACTION.recreate]: (name, job, authorize) =>
        authorize ? updater.recreate(name, reportFor(job), authorize) : updater.recreate(name, reportFor(job)),
      [JOB_ACTION.edit]: async (name, job, authorize) => {
        const settings = await settingsOf(job.id).catch(() => null);
        if (settings === null) {
          return { succeeded: false, outcome: EDIT_OUTCOMES.settingsGone };
        }
        if (job.operatorUserId !== undefined) {
          const target = await operatorAccessTarget(name, docker);
          if (target === null) return { succeeded: false, outcome: OPERATOR_ISOLATION_REFUSAL };
          const details = await docker.inspect(name);
          if (details === null || !unchangedOperatorBoundaries(details, settings))
            return { succeeded: false, outcome: OPERATOR_MOUNTS_REFUSAL };
          if (!(await authorize?.())) return { succeeded: false, outcome: OPERATOR_REFUSAL };
        }
        // An operator's reach is one container, not the file a whole stack shares.
        const write =
          job.operatorUserId === undefined && stacks !== undefined
            ? await this.throughCompose(name, settings)
            : { written: false as const, reason: null };
        if (write.written) return write.result;
        const edited = await (authorize ? updater.edit(name, settings, authorize) : updater.edit(name, settings));
        if (write.reason === null || !edited.succeeded) return edited;
        return { ...edited, outcome: `${edited.outcome} ${STACK_OUTCOMES.fileNotChanged(write.reason)}` };
      },
    };
  }

  /**
   * Always answers, and within what the control plane accepts: a job that throws becomes a failure
   * saying why, and a longer outcome (a long list of containers) is cut rather than refused.
   */
  async run(job: DockerJob): Promise<JobResult> {
    const result = await this.dispatch(job).catch((error: unknown) =>
      asJobResult({
        succeeded: false,
        outcome: JOB_OUTCOMES.failed(job.action, job.containerName, describeError(error)),
      }),
    );
    return { ...result, outcome: result.outcome.slice(0, OUTCOME_TEXT_LIMIT) };
  }

  /** Uses the identical discovery and atomic lock path as execution, while changing no workload. */
  async preview(name: string, action: PreviewAction): Promise<OperationPreviewAnswer> {
    try {
      return await this.dependencies.guard.operations.containers(
        () => this.affected(name, action),
        async (snapshot): Promise<OperationPreviewAnswer> => {
          const { settings } = this.dependencies;
          const members = [...new Set(snapshot.authorizationIdentities.map((member) => member.name))]
            .sort()
            .map((member) => ({
              name: member,
              protected: settings.protectedContainers.has(member) || member === settings.selfContainerName,
            }));
          const refusals: string[] = [];
          if (snapshot.root === null && snapshot.recovery === null) refusals.push(JOB_OUTCOMES.missing(name));
          if (settings.dryRun) refusals.push(JOB_OUTCOMES.dryRun(action, name));
          if (members.some((member) => member.protected))
            refusals.push("The affected lock set includes protected containers.");
          if (snapshot.recovery !== null && (action !== JOB_ACTION.rollBack || name !== snapshot.recovery.owner))
            refusals.push(JOB_OUTCOMES.rollbackPending(snapshot.recovery.owner));
          if (snapshot.pending !== null && (action !== JOB_ACTION.rollBack || snapshot.canonical !== snapshot.pending))
            refusals.push(JOB_OUTCOMES.groupPending(snapshot.pending));
          if (isParkedContainer(name)) refusals.push("Select the current container to recover its retained group.");
          let writableData: "none" | "present" | "unknown" = "none";
          for (const identity of snapshot.authorizationIdentities) {
            const inspected = identity.id ? await this.dependencies.docker.inspect(identity.id) : null;
            if (!inspected || !Array.isArray(inspected.Mounts) || !isolatedOperatorContainer(inspected)) {
              writableData = "unknown";
              break;
            }
            if (
              inspected.Mounts.some((mount) => mount.RW !== false && (mount.Type === "bind" || mount.Type === "volume"))
            )
              writableData = "present";
          }
          const image =
            snapshot.root?.Image && this.dependencies.docker.inspectImage
              ? await this.dependencies.docker.inspectImage(snapshot.root.Image)
              : null;
          const platform = image?.Os && image.Architecture ? `${image.Os}/${image.Architecture}` : null;
          return {
            ok: true,
            rolloutSafety: {
              writableData,
              platform,
              ...(snapshot.root?.Id ? { sourceContainerId: snapshot.root.Id } : {}),
            },
            fingerprint: operationFingerprint(snapshot.resources),
            members,
            resources: publicOperationResources(snapshot.resources),
            refusals,
          };
        },
      );
    } catch {
      return {
        ok: false,
        reason:
          "Could not discover a complete operation scope. Wait for Docker and the workload to settle, then retry.",
      };
    }
  }

  private maintenanceBlocks(job: DockerJob, names = [job.containerName]) {
    return job.automatic === true && names.some((name) => this.dependencies.maintenanceHeld?.(name));
  }
  private maintenanceRefusal(): JobResult {
    return {
      succeeded: false,
      outcome: "Automatic work paused: maintenance policy is active or unavailable.",
      output: null,
    };
  }
  private async operatorAllowed(job: DockerJob, targets: OperatorTarget[]): Promise<boolean> {
    if (job.operatorUserId === undefined) return true;
    if (targets.length === 0 || !this.dependencies.authorizeOperator) return false;
    return this.dependencies.authorizeOperator(job.id, targets).catch(() => false);
  }
  private dispatch(job: DockerJob): Promise<JobResult> {
    if (this.maintenanceBlocks(job)) return Promise.resolve(this.maintenanceRefusal());
    if (job.action === JOB_ACTION.checkUpdates) {
      return job.operatorUserId === undefined
        ? this.checkUpdates()
        : Promise.resolve(asJobResult({ succeeded: false, outcome: OPERATOR_REFUSAL }));
    }
    if (
      job.operatorUserId !== undefined &&
      (job.action === JOB_ACTION.pruneImages ||
        job.action === JOB_ACTION.removeImages ||
        job.action === JOB_ACTION.createNetwork ||
        job.action === JOB_ACTION.removeNetworks ||
        job.action === JOB_ACTION.createVolume ||
        job.action === JOB_ACTION.removeVolumes ||
        isBackupJob(job) ||
        isStackJob(job))
    )
      return Promise.resolve(asJobResult({ succeeded: false, outcome: OPERATOR_REFUSAL }));
    if (job.action === JOB_ACTION.pruneImages) {
      return this.dependencies.guard.operations.host(() =>
        this.maintenanceBlocks(job) ? Promise.resolve(this.maintenanceRefusal()) : this.pruneImages(),
      );
    }
    if (job.action === JOB_ACTION.removeImages) {
      return this.dependencies.guard.operations.host(() =>
        this.maintenanceBlocks(job) ? Promise.resolve(this.maintenanceRefusal()) : this.removeImages(job.images),
      );
    }
    if (job.action === JOB_ACTION.createNetwork) {
      return this.dependencies.guard.operations.host(() =>
        this.maintenanceBlocks(job) ? Promise.resolve(this.maintenanceRefusal()) : this.createNetwork(job.network),
      );
    }
    if (job.action === JOB_ACTION.removeNetworks) {
      return this.dependencies.guard.operations.host(() =>
        this.maintenanceBlocks(job) ? Promise.resolve(this.maintenanceRefusal()) : this.removeNetworks(job.removal),
      );
    }
    if (isBackupJob(job)) {
      // It holds only what it stops, not the host: a large copy must not hold up the rest for hours.
      if (this.maintenanceBlocks(job)) return Promise.resolve(this.maintenanceRefusal());
      const { backups, reportInventory } = this.dependencies;
      if (backups === undefined)
        return Promise.resolve(asJobResult({ succeeded: false, outcome: JOB_OUTCOMES.noBackupsHere }));
      return backups.run(job.id, job.action, job.backup).then((result) => {
        reportInventory();
        const recovery = result.recoveryBackupId === undefined ? {} : { recoveryBackupId: result.recoveryBackupId };
        return { ...asJobResult(result), ...recovery };
      });
    }
    if (isStackJob(job)) {
      return this.dependencies.guard.operations.host(() =>
        this.maintenanceBlocks(job) ? Promise.resolve(this.maintenanceRefusal()) : this.runStack(job),
      );
    }
    if (job.action === JOB_ACTION.createVolume) {
      return this.dependencies.guard.operations.host(() =>
        this.maintenanceBlocks(job) ? Promise.resolve(this.maintenanceRefusal()) : this.createVolume(job.volume),
      );
    }
    if (job.action === JOB_ACTION.removeVolumes) {
      return this.dependencies.guard.operations.host(() =>
        this.maintenanceBlocks(job) ? Promise.resolve(this.maintenanceRefusal()) : this.removeVolumes(job.removal),
      );
    }
    if (job.action === JOB_ACTION.logs) {
      return this.logs(job.containerName, job);
    }
    if (
      job.action === JOB_ACTION.install ||
      job.action === JOB_ACTION.uninstall ||
      job.action === JOB_ACTION.uninstallWithData
    ) {
      return job.operatorUserId === undefined
        ? this.installing(job)
        : Promise.resolve(asJobResult({ succeeded: false, outcome: OPERATOR_REFUSAL }));
    }
    return this.change(job, job.action);
  }

  private async installing(job: ContainerJob): Promise<JobResult> {
    const { installs, installSpecOf, reportProgress, reportInventory } = this.dependencies;
    if (installs === undefined || installSpecOf === undefined) {
      return asJobResult({ succeeded: false, outcome: HOST_DEPLOY_REFUSALS.off });
    }
    if (job.action !== JOB_ACTION.install) {
      const taken = await installs.uninstall(job.containerName, job.action === JOB_ACTION.uninstallWithData);
      reportInventory();
      return asJobResult(taken);
    }
    const spec = await installSpecOf(job.id).catch(() => null);
    if (spec === null) return asJobResult({ succeeded: false, outcome: INSTALL_OUTCOMES.gone });
    const report = new UpdateReport((progress) => void reportProgress(job.id, progress).catch(() => undefined));
    const run = (): ReturnType<typeof installs.install> =>
      "own" in spec ? installs.installOwn(spec, report) : installs.install(spec, report);
    // A retry may replace what it left, so it takes its turn: nothing else changes those containers meanwhile.
    const isRetry = "own" in spec && spec.retry !== null;
    const { logsOf, ...result } = await (isRetry ? this.dependencies.guard.operations.host(run) : run());
    reportInventory();
    if (logsOf === null) return asJobResult(result);
    // What went wrong is in its own words: its logs, masked as they always are.
    const logs = await this.logs(logsOf, job).catch(() => null);
    return { ...asJobResult(result), ...(logs?.output === undefined ? {} : { output: logs.output }) };
  }

  private async change(job: ContainerJob, action: ChangingAction): Promise<JobResult> {
    const name = job.containerName;
    const { guard, settings } = this.dependencies;
    // Changing a container's settings reaches inside it: only where the host's .env allows that.
    if (action === JOB_ACTION.edit && !settings.containerAccess) {
      return asJobResult({ succeeded: false, outcome: CONTAINER_ACCESS_REFUSALS.off });
    }
    if (name === settings.selfContainerName) {
      return asJobResult({ succeeded: false, outcome: JOB_OUTCOMES.refusedSelf });
    }
    if (settings.protectedContainers.has(name)) {
      return asJobResult({ succeeded: false, outcome: JOB_OUTCOMES.refusedProtected(name) });
    }
    // Rolling back puts it back; anything else would lose the copy kept for that, or run it beside its successor.
    if (isParkedContainer(name)) {
      return asJobResult({ succeeded: false, outcome: JOB_OUTCOMES.refusedParkedItself(name, updatedNameOf(name)) });
    }
    let queued = false;
    const progress = new UpdateReport(
      (update) => void this.dependencies.reportProgress(job.id, update).catch(() => undefined),
    );
    return guard.operations.containers(
      () => this.affected(name, action),
      async ({ root, group, canonical, pending, recovery, authorizationIdentities, resources }) => {
        if (
          authorizationIdentities.some((member) =>
            this.dependencies.guard.externalRecoveryBlocked?.(member.name, member.id ?? undefined),
          )
        ) {
          return asJobResult({
            succeeded: false,
            outcome:
              "Application data recovery is incomplete. Resume the reviewed application restore before changing or starting this group.",
          });
        }
        if (job.expectedResourcesFingerprint && operationFingerprint(resources) !== job.expectedResourcesFingerprint)
          return asJobResult({ succeeded: false, outcome: OPERATION_SCOPE_CHANGED });
        if (this.maintenanceBlocks(job, [name, canonical, ...group])) return this.maintenanceRefusal();
        if (recovery !== null && (action !== JOB_ACTION.rollBack || name !== recovery.owner)) {
          return asJobResult({ succeeded: false, outcome: JOB_OUTCOMES.rollbackPending(recovery.owner) });
        }
        if (pending !== null && (action !== JOB_ACTION.rollBack || canonical !== pending)) {
          return asJobResult({ succeeded: false, outcome: JOB_OUTCOMES.groupPending(pending) });
        }
        if (root === null && recovery === null) {
          return asJobResult({ succeeded: false, outcome: JOB_OUTCOMES.missing(name) });
        }
        if (canonical === settings.selfContainerName || settings.protectedContainers.has(canonical)) {
          return asJobResult({ succeeded: false, outcome: JOB_OUTCOMES.refusedProtected(canonical) });
        }
        const protectedInGroup = [
          ...new Set([...group, ...authorizationIdentities.map((identity) => identity.name)]),
        ].filter(
          (dependent) => settings.protectedContainers.has(dependent) || dependent === settings.selfContainerName,
        );
        if (protectedInGroup.length > 0) {
          return asJobResult({
            succeeded: false,
            outcome: JOB_OUTCOMES.refusedProtectedDependent(name, protectedInGroup),
          });
        }
        if (settings.dryRun) {
          return asJobResult({ succeeded: false, outcome: JOB_OUTCOMES.dryRun(action, name) });
        }
        if (queued) {
          progress.enter(UPDATE_PHASE.working);
        }
        let scopeChanged = false;
        const reviewStillCurrent = async () => {
          if (!job.expectedResourcesFingerprint) return true;
          const current = await this.affected(name, action);
          const matches = operationFingerprint(current.resources) === job.expectedResourcesFingerprint;
          if (!matches) scopeChanged = true;
          return matches;
        };
        let admittedScope = false;
        const operatorCheck = async () => {
          if (job.operatorUserId === undefined) return true;
          const targets: OperatorTarget[] = [];
          for (const identity of authorizationIdentities) {
            const current = identity.id === null ? null : await this.dependencies.docker.inspect(identity.id);
            if (current === null || current.Id !== identity.id) return false;
            targets.push({ ...operatorTarget(current), name: identity.name });
          }
          return this.operatorAllowed(job, targets);
        };
        const authorize =
          job.operatorUserId === undefined && !job.expectedResourcesFingerprint && !job.rollout
            ? undefined
            : async () => {
                // First updater admission is after image pulling and immediately before its first stop/rename.
                // Later checks must allow the operation's own replacement IDs while retaining current grant checks.
                if (!admittedScope && !(await reviewStillCurrent())) return false;
                if (
                  !admittedScope &&
                  job.rollout &&
                  !(await this.dependencies
                    .authorizeOperator?.(
                      job.id,
                      authorizationIdentities.map((member) => ({ name: member.name, composeProject: null })),
                    )
                    .catch(() => false))
                )
                  return false;
                if (!admittedScope && this.maintenanceBlocks(job, [name, canonical, ...group])) return false;
                if (!(await operatorCheck())) return false;
                admittedScope = true;
                return true;
              };
        if (!(await reviewStillCurrent())) return asJobResult({ succeeded: false, outcome: OPERATION_SCOPE_CHANGED });
        if (job.operatorUserId !== undefined && !(await operatorCheck()))
          return asJobResult({ succeeded: false, outcome: OPERATOR_REFUSAL });
        const held = [...new Set([name, canonical, ...group])];
        held.forEach((container) => {
          guard.hold(container);
          guard.noteKill(container);
        });
        try {
          await guard.persisted();
          if (this.maintenanceBlocks(job, held)) return this.maintenanceRefusal();
          if (!(await reviewStillCurrent())) return asJobResult({ succeeded: false, outcome: OPERATION_SCOPE_CHANGED });
          if (job.operatorUserId !== undefined && !(await operatorCheck()))
            return asJobResult({ succeeded: false, outcome: OPERATOR_REFUSAL });
          const result = await this.changes[action](name, job, authorize);
          if (scopeChanged && !result.succeeded)
            return asJobResult({ succeeded: false, outcome: OPERATION_SCOPE_CHANGED });
          return result.output === undefined
            ? asJobResult(result)
            : { ...result, output: await this.masked(result.output) };
        } finally {
          held.forEach((container) => guard.release(container));
          await guard.persisted();
        }
      },
      () => {
        if (!queued) {
          queued = true;
          progress.enter(UPDATE_PHASE.waiting);
        }
      },
    );
  }

  private async affected(name: string, action: ChangingAction) {
    const { docker, updater } = this.dependencies;
    const root = await docker.inspect(name);
    const recovery = await this.dependencies.guard.rollbackOf(name, root?.Id);
    const canonical = root?.Name.replace(/^\//, "") ?? name;
    const group = new Set<string>();
    const identities: { name: string; details: ContainerDetails | null }[] = [{ name, details: root }];
    if (root !== null && GROUP_ACTIONS.has(action)) {
      for (const member of await updater.dependentsOf(name)) {
        group.add(member);
      }
      // Rollback starts dependents still pointing at the parked provider, not necessarily its replacement.
      if (action === JOB_ACTION.rollBack) {
        const parked = `${canonical}${OLD_CONTAINER_SUFFIX}`;
        const old = await docker.inspect(parked);
        identities.push({ name: parked, details: old });
        if (old !== null) {
          for (const member of await updater.dependentsOf(parked)) {
            group.add(member);
          }
        }
      }
    }
    const members = await Promise.all(
      [...group].map(async (member) => ({ name: member, details: await docker.inspect(member) })),
    );
    identities.push(...members);
    // Sharing a provider's namespace conflicts with replacing or restarting that provider too.
    const providers = [
      ...new Set(
        identities.flatMap(({ details }) => {
          const mode = details?.HostConfig?.NetworkMode ?? "";
          return mode.startsWith(NETWORK_MODE_CONTAINER_PREFIX)
            ? [mode.slice(NETWORK_MODE_CONTAINER_PREFIX.length)]
            : [];
        }),
      ),
    ];
    identities.push(
      ...(await Promise.all(
        providers.map(async (provider) => ({ name: provider, details: await docker.inspect(provider) })),
      )),
    );
    for (const { details } of [...identities]) {
      const memberName = details?.Name.replace(/^\//, "");
      if (memberName !== undefined && isParkedContainer(memberName)) {
        const providerName = updatedNameOf(memberName);
        identities.push({ name: providerName, details: await docker.inspect(providerName) });
      }
    }
    let pending: string | null = null;
    if (recovery !== null) {
      pending = recovery.owner;
      for (const member of recovery.members) {
        group.add(member.name);
        identities.push({ name: member.name, details: await docker.inspect(member.name) });
        identities.push({ name: member.id, details: await docker.inspect(member.id) });
        if (member.replacementId !== null)
          identities.push({ name: member.replacementId, details: await docker.inspect(member.replacementId) });
      }
    }

    for (const { details } of [...identities]) {
      const retained = updateGroupOf(details);
      if (retained === null) continue;
      const original = await docker.inspect(retained.provider.id);
      if (original === null) continue; // A committed group's old provider no longer exists.
      pending = retained.provider.name;
      for (const member of [retained.provider, ...retained.dependents]) {
        group.add(member.name);
        identities.push({ name: member.name, details: await docker.inspect(member.name) });
        identities.push({ name: member.id, details: await docker.inspect(member.id) });
      }
    }
    if (action === JOB_ACTION.rollBack || action === JOB_ACTION.update) {
      const affected = identities.flatMap(({ details }) => (details === null ? [] : [details]));
      for (const summary of await docker.containerSummaries()) {
        const candidate = await docker.inspect(summary.Id);
        if (candidate !== null && affected.some((container) => sharesRollbackData(container, candidate))) {
          identities.push({ name: summary.Id, details: candidate });
        }
      }
    }
    const authorizationIdentities = [
      ...new Map(
        identities.flatMap(({ details }) => {
          if (details === null) return [];
          const target = operatorTarget(details);
          const logical = isParkedContainer(target.name) ? updatedNameOf(target.name) : target.name;
          return [[`${logical}:${details.Id}`, { name: logical, id: details.Id ?? null }]] as const;
        }),
      ).values(),
    ];
    return {
      authorizationIdentities,
      root,
      canonical,
      pending,
      recovery,
      group: [
        ...new Set([
          ...group,
          ...members.map(({ name: member, details }) => details?.Name.replace(/^\//, "") ?? member),
        ]),
      ],
      resources: identities.flatMap(({ name: member, details }) => containerResources(member, details)),
    };
  }

  // Every container's secrets masked, the newest lines kept.
  private async masked(text: string): Promise<string> {
    const environment = await this.dependencies.docker.allEnvironmentEntries();
    return redactSecrets(text, environment).slice(-JOB_OUTPUT_CHARACTERS);
  }

  private async logs(name: string, job: ContainerJob): Promise<JobResult> {
    const { docker } = this.dependencies;
    const container = await docker.inspect(name);
    if (container === null) {
      return asJobResult({ succeeded: false, outcome: JOB_OUTCOMES.missing(name) });
    }
    if (!(await this.operatorAllowed(job, [operatorTarget(container)])))
      return asJobResult({ succeeded: false, outcome: OPERATOR_REFUSAL });
    const [text, otherEnvironment] = await Promise.all([
      docker.logs(name, container.Config.Tty ?? false),
      docker.allEnvironmentEntries(),
    ]);
    const masked = redactSecrets(text, [...(container.Config.Env ?? []), ...otherEnvironment]);
    // The newest lines matter most: past the limit, the oldest go.
    return { succeeded: true, outcome: JOB_OUTCOMES.logs(name), output: masked.slice(-JOB_OUTPUT_CHARACTERS) };
  }

  /**
   * The images no container uses, but each container's previous one, kept for rolling back; Docker's build
   * cache too when the host's page says so.
   */
  private async pruneImages(): Promise<JobResult> {
    const { docker, settings, clearBuildCache, reportInventory } = this.dependencies;
    const unused = (await unusedImages(docker)).filter((image) => !isKeptByUpdate(image));
    const withCache = clearBuildCache();
    if (settings.dryRun) {
      return asJobResult({
        succeeded: false,
        outcome: PRUNE_OUTCOMES.dryRun(unused.length, sizeOf(unused), withCache),
      });
    }
    const removed = await this.removeEach(unused);
    const cacheBytes = withCache ? await docker.pruneBuildCache() : null;
    reportInventory();
    const refused = unused.length - removed.length;
    const outcome =
      PRUNE_OUTCOMES.pruned(removed.length, sizeOf(removed), cacheBytes) +
      (refused > 0 ? PRUNE_OUTCOMES.refused(refused) : "");
    return asJobResult({ succeeded: true, outcome });
  }

  /**
   * The images a person ticked on the host's page, kept ones too, but only those still unused: a container
   * may have taken one into use since the host's last report.
   */
  private async removeImages(ids: readonly string[]): Promise<JobResult> {
    const { docker, settings, reportInventory } = this.dependencies;
    const wanted = new Set(ids);
    const chosen = (await unusedImages(docker)).filter((image) => wanted.has(image.Id));
    if (settings.dryRun) {
      return asJobResult({ succeeded: false, outcome: PRUNE_OUTCOMES.dryRun(chosen.length, sizeOf(chosen), false) });
    }
    const removed = await this.removeEach(chosen);
    reportInventory();
    const stayed = wanted.size - removed.length;
    const outcome =
      PRUNE_OUTCOMES.removed(removed.length, sizeOf(removed)) + (stayed > 0 ? PRUNE_OUTCOMES.stayed(stayed) : "");
    return asJobResult({ succeeded: true, outcome });
  }

  // One at a time, never forced: Docker refuses one a container started using meanwhile, and the others still go.
  private async removeEach(images: readonly ImageSummary[]): Promise<ImageSummary[]> {
    const removed: ImageSummary[] = [];
    for (const image of images) {
      if (await this.removeImage(image)) {
        removed.push(image);
      }
    }
    return removed;
  }

  // By each of its names, as Docker refuses one with several by its id; one without a name goes by its id.
  private async removeImage(image: ImageSummary): Promise<boolean> {
    const names = namesOf(image);
    try {
      for (const reference of names.length > 0 ? names : [image.Id]) {
        await this.dependencies.docker.removeImage(reference);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Its containers are put on it one by one: one that cannot join does not undo the network. */
  private async createNetwork(network: NewNetwork): Promise<JobResult> {
    const { docker, settings, reportInventory } = this.dependencies;
    if (settings.dryRun) return asJobResult({ succeeded: false, outcome: NETWORK_OUTCOMES.dryRun });
    let created: DockerNetwork;
    try {
      created = await docker.createNetwork(network);
    } catch (error) {
      return asJobResult({
        succeeded: false,
        outcome: NETWORK_OUTCOMES.notCreated(network.name, describeError(error)),
      });
    }
    const joined: string[] = [];
    const problems: string[] = [];
    for (const container of network.containers) {
      try {
        if (settings.protectedContainers.has(container) || container === settings.selfContainerName) {
          throw new Error(NETWORK_OUTCOMES.protectedContainer);
        }
        await docker.connect(network.name, container, {});
        joined.push(container);
      } catch (error) {
        problems.push(NETWORK_OUTCOMES.notJoined(container, describeError(error)));
      }
    }
    reportInventory();
    const made =
      joined.length === 0 ? NETWORK_OUTCOMES.created(network.name) : NETWORK_OUTCOMES.createdWith(network.name, joined);
    return {
      succeeded: true,
      outcome: [made, ...problems].join(" "),
      output: created.IPAM?.Config?.[0]?.Subnet ?? null,
    };
  }

  /**
   * Looks again at who is on each: a container may have joined since the host's last report. One at a time, never
   * forced: Docker refuses one with something running on it, and the others still go.
   */
  private async removeNetworks(removal: NetworkRemoval): Promise<JobResult> {
    const { docker, settings, reportInventory } = this.dependencies;
    if (settings.dryRun) return asJobResult({ succeeded: false, outcome: NETWORK_OUTCOMES.dryRun });
    const report = await networksReport(docker, settings.selfContainerName);
    const removed: string[] = [];
    const stayed: string[] = [];
    let failed = false;
    for (const name of removal.names) {
      const network = report.find((each) => each.name === name);
      if (network === undefined) continue;
      if (isLocked(network)) {
        stayed.push(NETWORK_OUTCOMES.locked(name));
        continue;
      }
      const stopped = network.members.filter((member) => !member.running).map((member) => member.name);
      if (stopped.length > 0 && !removal.evenIfStoppedNeedIt) {
        stayed.push(NETWORK_OUTCOMES.neededByStopped(name, stopped));
        continue;
      }
      try {
        await docker.removeNetwork(name);
        removed.push(name);
      } catch (error) {
        failed = true;
        stayed.push(NETWORK_OUTCOMES.notRemoved(name, describeError(error)));
      }
    }
    reportInventory();
    const lines = removed.length === 0 ? stayed : [NETWORK_OUTCOMES.removed(removed), ...stayed];
    return asJobResult({ succeeded: !failed, outcome: lines.join(" ") });
  }

  private async throughCompose(name: string, settings: ContainerSettings): Promise<SettingsWrite> {
    const refusal = await this.dependencies.updater.editRefusal(name, settings);
    if (refusal !== null) return { written: true, result: { succeeded: false, outcome: refusal } };
    return this.dependencies.stacks!.applySettings(name, settings);
  }

  // Held while Compose works, so Autoheal does not take what it stops or replaces for a failure to heal.
  private async runStack(job: StackJob): Promise<JobResult> {
    const { stacks, guard, reportInventory } = this.dependencies;
    if (stacks === undefined) return asJobResult({ succeeded: false, outcome: HOST_DEPLOY_REFUSALS.off });
    const members = await stacks.membersOf(job.stack.project);
    members.forEach((member) => guard.hold(member));
    try {
      return await stacks.run(job.action, job.stack);
    } finally {
      members.forEach((member) => guard.release(member));
      reportInventory();
    }
  }

  private async createVolume({ name, share }: NewVolume): Promise<JobResult> {
    const { docker, settings, reportInventory } = this.dependencies;
    if (settings.dryRun) return asJobResult({ succeeded: false, outcome: VOLUME_OUTCOMES.dryRun });
    try {
      await docker.createVolume(name, {}, share === null ? {} : shareOptionsOf(share));
    } catch (error) {
      return asJobResult({ succeeded: false, outcome: VOLUME_OUTCOMES.notCreated(name, describeError(error)) });
    }
    reportInventory();
    return asJobResult({ succeeded: true, outcome: VOLUME_OUTCOMES.created(name) });
  }

  /**
   * Counts again what each holds, whatever the last report said: without a person's yes only what is empty now goes,
   * and what cannot be counted is not called empty. Autoheal's own records are never removed, whoever asks.
   */
  private async removeVolumes(removal: VolumeRemoval): Promise<JobResult> {
    const { docker, settings, reportInventory } = this.dependencies;
    if (settings.dryRun) return asJobResult({ succeeded: false, outcome: VOLUME_OUTCOMES.dryRun });
    const sizes = await docker.volumeSizes().catch(() => new Map<string, number>());
    const report = await volumesReport(docker, sizes);
    const removed: string[] = [];
    const stayed: string[] = [];
    let failed = false;
    for (const name of removal.names) {
      const volume = report.find((each) => each.name === name);
      if (volume === undefined) continue;
      if (volume.own) {
        stayed.push(VOLUME_OUTCOMES.locked(name));
        continue;
      }
      if (volume.members.length > 0) {
        stayed.push(
          VOLUME_OUTCOMES.attached(
            name,
            volume.members.map((member) => member.name),
          ),
        );
        continue;
      }
      if (volume.sizeBytes !== 0 && !removal.evenWithData) {
        stayed.push(VOLUME_OUTCOMES.notEmpty(name));
        continue;
      }
      try {
        await docker.removeVolume(name);
        removed.push(name);
      } catch (error) {
        failed = true;
        stayed.push(VOLUME_OUTCOMES.notRemoved(name, describeError(error)));
      }
    }
    reportInventory();
    const lines = removed.length === 0 ? stayed : [VOLUME_OUTCOMES.removed(removed), ...stayed];
    return asJobResult({ succeeded: !failed, outcome: lines.join(" ") });
  }

  private async checkUpdates(): Promise<JobResult> {
    const summary = await this.dependencies.updates.checkAll();
    this.dependencies.reportInventory();
    const outcome = JOB_OUTCOMES.updatesChecked(summary.images, summary.available, summary.unknown);
    return { succeeded: true, outcome, output: null };
  }
}
