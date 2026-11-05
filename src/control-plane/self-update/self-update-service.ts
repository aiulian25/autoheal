import { statSync } from "node:fs";
import { hostname } from "node:os";
import type { DockerClient } from "../../runner/docker-client.js";
import { containerNameOf, type ContainerDetails } from "../../runner/incident-report.js";
import { API_ERRORS, type SelfUpdateOutcome, type SelfUpdateView } from "../../shared/api.js";
import {
  ACTOR_SYSTEM,
  AUDIT_ACTIONS,
  COMMAND_SELF_UPDATE,
  DEFAULT_DATA_DIRECTORY,
  DEFAULT_DOCKER_SOCKET_PATH,
  IMAGE_ID_PREFIX,
  SELF_UPDATE,
  SELF_UPDATE_CLEARABLE_HELPER,
  SELF_UPDATE_FINAL,
  SELF_UPDATE_PHASE,
  SELF_UPDATE_STATUS,
  SELF_UPDATE_TEXT,
  SYSTEM_ACTOR_LABEL,
  TARGET_AUTOHEAL,
} from "../../shared/constants.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import { DomainError } from "../domain-error.js";
import {
  outcomeIn,
  unfinishedRecovery,
  unreadableReason,
  type JournalledOutcome,
  type SelfUpdateOutcomeFile,
  type SelfUpdateRecord,
} from "./self-update-outcome.js";

type SelfUpdateDocker = Pick<DockerClient, "inspect" | "inspectImage" | "pull" | "create" | "start" | "remove">;

export interface SelfUpdateDependencies {
  // Null where the control plane's container has no Docker socket.
  docker: SelfUpdateDocker | null;
  // AUTOHEAL_IMAGE: the image an update runs where its own container does not say, pulled first where it comes from a
  // registry.
  reference: string;
  outcomes: SelfUpdateOutcomeFile;
  auditLog: AuditLog;
  clock: () => number;
  // Docker names a container's hostname after its id: how the control plane finds its own container.
  ownContainer?: string;
  // The socket's group, which the helper is given as the control plane was.
  socketGroup?: () => number;
}

// Where a mount of its own container comes from, as Docker needs it for the helper's: a volume's name or a path.
function sourceOf(container: ContainerDetails, destination: string): string | null {
  const mount = container.Mounts?.find((candidate) => candidate.Destination === destination);
  return mount?.Name ?? mount?.Source ?? null;
}

const isClearable = (helper: ContainerDetails | null) =>
  helper === null || SELF_UPDATE_CLEARABLE_HELPER.includes(helper.State.Status ?? "");

/**
 * Autoheal updating itself: the control plane cannot replace its own container from inside it, so it
 * starts a one-shot helper of the new image which does (see self-update-helper.ts), with the Docker socket and the data
 * volume mounted and nothing else. The helper writes how it goes into the data volume; whichever control plane runs
 * reads it there.
 */
export class SelfUpdateService {
  private readonly ownContainer: string;
  private readonly socketGroup: () => number;
  // One update at a time, from before the first wait until its helper runs or it has failed: seeing no helper running
  // cannot be the lock, as a pull can take minutes and another request would see the same.
  private admitting = false;

  constructor(private readonly dependencies: SelfUpdateDependencies) {
    this.ownContainer = dependencies.ownContainer ?? hostname();
    this.socketGroup = dependencies.socketGroup ?? (() => statSync(DEFAULT_DOCKER_SOCKET_PATH).gid);
  }

  async view(): Promise<SelfUpdateView> {
    const { docker } = this.dependencies;
    const own = docker === null ? null : await docker.inspect(this.ownContainer);
    const record = this.dependencies.outcomes.read();
    const blocked = unreadableReason(record);
    return {
      unavailable: this.unavailable(docker, own),
      runningImage: own?.Image ?? null,
      reference: this.referenceOf(own),
      recoveryBlocked: blocked === null ? null : SELF_UPDATE_TEXT.recoveryBlocked(blocked),
      last: await this.lastSeen(docker, record),
    };
  }

  async start(actor: Actor): Promise<SelfUpdateView> {
    if (this.admitting) {
      throw new DomainError(API_ERRORS.selfUpdateRunning);
    }
    this.admitting = true;
    try {
      return await this.admit(actor);
    } finally {
      this.admitting = false;
    }
  }

  private async admit(actor: Actor): Promise<SelfUpdateView> {
    const { docker, outcomes, auditLog, clock } = this.dependencies;
    const own = docker === null ? null : await docker.inspect(this.ownContainer);
    if (docker === null || own === null || this.unavailable(docker, own) !== null) {
      throw new DomainError(API_ERRORS.selfUpdateUnavailable);
    }
    const reference = this.referenceOf(own);
    await this.refuseActiveHelper(docker);
    const record = outcomes.read();
    // An update may be unfinished behind a record that cannot be read: nothing new starts until a person has seen it.
    if (unreadableReason(record) !== null) {
      throw new DomainError(API_ERRORS.selfUpdateRecoveryBlocked);
    }
    const unfinished = outcomeIn(record);
    const recovery = unfinishedRecovery(unfinished);
    if (unfinished !== null && recovery !== null) {
      return this.takeUp(docker, own, unfinished, recovery.original);
    }
    // A local image, built or loaded on this machine, is used as it is: there is nothing to pull it from.
    await docker.pull(reference).catch(() => undefined);
    const image = await docker.inspectImage(reference);
    if (image === null) {
      throw new DomainError(API_ERRORS.selfUpdateUnavailable);
    }
    if (image.Id === own.Image) {
      throw new DomainError(API_ERRORS.selfUpdateNewest);
    }
    // Looked at again: the pull may have taken minutes, and this is the one step that could end a running update.
    await this.refuseActiveHelper(docker);
    await docker.remove(SELF_UPDATE.helperName);
    await this.createHelper(docker, own, own.Id ?? this.ownContainer, image.Id, reference);
    const outcome: JournalledOutcome = {
      status: SELF_UPDATE_STATUS.updating,
      from: own.Image ?? "",
      to: image.Id,
      reference,
      startedAt: clock(),
      finishedAt: null,
      message: SELF_UPDATE_TEXT.started,
      recovery: {
        version: SELF_UPDATE.recoveryVersion,
        phase: SELF_UPDATE_PHASE.preparing,
        original: own.Id ?? this.ownContainer,
        name: containerNameOf(own),
        snapshot: null,
      },
    };
    outcomes.write(outcome);
    await this.startHelper(docker, outcome);
    auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.selfUpdateStarted,
      { kind: TARGET_AUTOHEAL, id: own.Id ?? this.ownContainer },
      { reference, from: own.Image, to: image.Id },
    );
    return this.view();
  }

  // The tag this install was asked to run, as its compose file named it, or the name the last update noted: anything
  // else would leave that tag behind on the old image, for the next "docker compose up" to go back to.
  private referenceOf(own: ContainerDetails | null): string {
    const configured = own?.Config.Image;
    if (configured !== undefined && !configured.startsWith(IMAGE_ID_PREFIX)) return configured;
    return own?.Config.Labels?.[SELF_UPDATE.referenceLabel] ?? this.dependencies.reference;
  }

  // An update that stopped partway: a new helper takes it up by what was recorded, whichever container this is now.
  private async takeUp(
    docker: SelfUpdateDocker,
    own: ContainerDetails,
    unfinished: JournalledOutcome,
    original: string,
  ) {
    const image = await docker.inspectImage(unfinished.to);
    if (image === null) {
      throw new DomainError(API_ERRORS.selfUpdateUnavailable);
    }
    await docker.remove(SELF_UPDATE.helperName);
    await this.createHelper(docker, own, original, unfinished.to, unfinished.reference);
    await docker.start(SELF_UPDATE.helperName);
    return this.view();
  }

  private createHelper(
    docker: SelfUpdateDocker,
    own: ContainerDetails,
    original: string,
    image: string,
    reference: string,
  ) {
    return docker.create(SELF_UPDATE.helperName, {
      Image: image,
      Cmd: [COMMAND_SELF_UPDATE, original, image, reference],
      User: SELF_UPDATE.user,
      Labels: { [SELF_UPDATE.label]: "1" },
      HostConfig: {
        AutoRemove: true,
        Binds: [
          `${sourceOf(own, DEFAULT_DOCKER_SOCKET_PATH)}:${DEFAULT_DOCKER_SOCKET_PATH}`,
          `${sourceOf(own, DEFAULT_DATA_DIRECTORY)}:${DEFAULT_DATA_DIRECTORY}`,
        ],
        GroupAdd: [String(this.socketGroup())],
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        NetworkMode: "none",
      },
    });
  }

  // An unfinished update with no helper running is not going on, whatever it last wrote.
  private async lastSeen(docker: SelfUpdateDocker | null, record: SelfUpdateRecord) {
    const last = this.lastAudited(record);
    if (docker === null || last === null || unfinishedRecovery(outcomeIn(record)) === null) return last;
    if (last.status === SELF_UPDATE_STATUS.blocked) return last;
    const helper = await docker.inspect(SELF_UPDATE.helperName);
    if (helper?.State.Running === true) return last;
    return { ...last, status: SELF_UPDATE_STATUS.blocked, message: SELF_UPDATE_TEXT.interrupted };
  }

  private async refuseActiveHelper(docker: SelfUpdateDocker) {
    if (!isClearable(await docker.inspect(SELF_UPDATE.helperName))) {
      throw new DomainError(API_ERRORS.selfUpdateRunning);
    }
  }

  // A refused start has nothing replacing the control plane, so it is recorded as failed and cleared. If the answer was
  // only lost, the helper is running and has the update; if its state cannot be read, the next request looks again.
  private async startHelper(docker: SelfUpdateDocker, outcome: SelfUpdateOutcome) {
    const refusal = await docker.start(SELF_UPDATE.helperName).then(
      () => null,
      (error: unknown) => error,
    );
    if (refusal === null) return;
    const helper = await docker.inspect(SELF_UPDATE.helperName).catch(() => undefined);
    if (helper?.State.Running === true) return;
    if (helper === undefined || !isClearable(helper)) throw refusal;
    this.dependencies.outcomes.write({
      ...outcome,
      status: SELF_UPDATE_STATUS.failed,
      finishedAt: this.dependencies.clock(),
      message: SELF_UPDATE_TEXT.helperFailed(refusal instanceof Error ? refusal.message : String(refusal)),
    });
    await docker.remove(SELF_UPDATE.helperName).catch(() => undefined);
    throw refusal;
  }

  // Why it cannot update itself here, or null when it can: the socket, and its own container, both mounted as it needs.
  private unavailable(docker: SelfUpdateDocker | null, own: ContainerDetails | null): string | null {
    if (docker === null) {
      return SELF_UPDATE_TEXT.noSocket;
    }
    const mounted = own !== null && sourceOf(own, DEFAULT_DATA_DIRECTORY) !== null;
    if (!mounted || sourceOf(own, DEFAULT_DOCKER_SOCKET_PATH) === null) {
      return SELF_UPDATE_TEXT.noOwnContainer;
    }
    return null;
  }

  // The last update, put in the audit log once it has finished, by whichever control plane sees it finished first.
  private lastAudited(record: SelfUpdateRecord) {
    const { outcomes, auditLog } = this.dependencies;
    const stored = outcomeIn(record);
    if (stored === null) {
      return null;
    }
    const { audited, settled, recovery, dataRestored, ...outcome } = stored;
    if (!audited && SELF_UPDATE_FINAL.includes(outcome.status)) {
      auditLog.record({
        actorKind: ACTOR_SYSTEM,
        actorLabel: SYSTEM_ACTOR_LABEL,
        action: AUDIT_ACTIONS.selfUpdateFinished,
        targetKind: TARGET_AUTOHEAL,
        details: { status: outcome.status, reference: outcome.reference, from: outcome.from, to: outcome.to },
      });
      outcomes.write({ ...outcome, recovery, dataRestored }, { audited: true, settled });
    }
    return outcome;
  }
}
