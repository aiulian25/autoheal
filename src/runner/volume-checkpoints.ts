import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { z } from "zod";
import type { VolumeCopyReport } from "../commands/volume-copy.js";
import {
  CHECKPOINT,
  COMMAND_VOLUME_COPY,
  HOST_HELPER,
  JOB_OUTCOMES,
  MOUNT_TYPE_BIND,
  MOUNT_TYPE_VOLUME,
  VOLUME_COPY_MESSAGES,
  VOLUME_COPY_OUTCOME,
  VOLUME_COPY_OUTCOMES,
  VOLUME_COPY_VERB,
  sizeText,
} from "../shared/constants.js";
import { describeError } from "../shared/errors.js";
import type { HelperImage } from "./application-backups.js";
import type { DockerClient, DockerVolume } from "./docker-client.js";
import type { ContainerDetails } from "./incident-report.js";

export interface VolumeCheckpointsDependencies {
  docker: Pick<
    DockerClient,
    | "inspect"
    | "create"
    | "start"
    | "remove"
    | "removeStopped"
    | "containerSummaries"
    | "logs"
    | "createVolume"
    | "removeVolume"
    | "volumes"
  >;
  // Autoheal's image, which the helper runs: the runner's own container's, or the one pulled onto an SSH host.
  helperImage: HelperImage;
  // How much one checkpoint may hold; 0 turns them off.
  limitBytes: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<unknown>;
}

export const RESTORE_OWNER_LABEL = "autoheal.checkpoint.restore-owner";

const volumeCopyReportSchema = z.object({
  outcome: z.enum(VOLUME_COPY_OUTCOMES),
  fidelity: z.literal(CHECKPOINT.fidelity).optional(),
  bytes: z.number().int().min(0),
  availableBytes: z.number().min(0),
  reason: z.string().nullable(),
});

/** What a roll back did with the data kept before the update: when it was kept, and what went wrong. */
export interface RestoredData {
  at: number | null;
  problem: string | null;
}

/** A mount the helper reaches: a named volume, or a path on the host. */
interface HelperMount {
  type: typeof MOUNT_TYPE_VOLUME | typeof MOUNT_TYPE_BIND;
  source: string;
}

export interface DataMount extends HelperMount {
  // Where the container sees it.
  target: string;
}

/** Copy coverage is a safety decision, separate from its display text. */
export interface TakenCheckpoint {
  containerId: string | null;
  mounts: DataMount[];
  complete: boolean;
  outcome: string;
  // Not kept only because there was too much of it: over the host's limit, or more than half its free space.
  oversized?: true;
}

const manifestSchema = z.object({
  version: z.literal(2),
  fidelity: z.literal(CHECKPOINT.fidelity),
  limitations: z.tuple([z.literal(CHECKPOINT.fidelityLimitations[0]), z.literal(CHECKPOINT.fidelityLimitations[1])]),
  mounts: z
    .array(
      z.object({
        type: z.enum([MOUNT_TYPE_VOLUME, MOUNT_TYPE_BIND]),
        source: z.string().min(1),
        target: z.string().min(1),
        volume: z.string().min(1),
      }),
    )
    .min(1),
});

type CopyPair = { from: HelperMount; to: HelperMount };
interface RestorePlan extends RestoredData {
  pairs: CopyPair[];
}

/** No service is safe only for a container without writable persistent mounts; `reason` says why there is none. */
export function unavailableCheckpoint(
  details: ContainerDetails,
  reason: string = JOB_OUTCOMES.checkpointUnavailable,
): TakenCheckpoint {
  const mounts = dataMountsOf(details);
  return {
    containerId: details.Id ?? null,
    mounts,
    complete: mounts.length === 0,
    outcome: mounts.length === 0 ? "" : JOB_OUTCOMES.checkpointSkipped(reason),
  };
}

const SKIPPED_TARGETS: ReadonlySet<string> = new Set(CHECKPOINT.skippedTargets);

/** A container's writable volumes and bind mounts: the data an update may change. */
export function dataMountsOf(details: ContainerDetails): DataMount[] {
  return (details.Mounts ?? []).flatMap((mount) => {
    const type = mount.Type === MOUNT_TYPE_VOLUME || mount.Type === MOUNT_TYPE_BIND ? mount.Type : null;
    const source = type === MOUNT_TYPE_VOLUME ? mount.Name : mount.Source;
    const writable = mount.RW !== false && !SKIPPED_TARGETS.has(mount.Destination);
    return type !== null && writable ? [{ type, source: source ?? "", target: mount.Destination }] : [];
  });
}

// The helper's last line says how it went; anything else is what it printed instead.
function reportIn(printed: string): VolumeCopyReport {
  const lastLine = printed.trim().split("\n").at(-1) ?? "";
  try {
    const parsed = volumeCopyReportSchema.safeParse(JSON.parse(lastLine));
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // Not JSON: reported below.
  }
  return { outcome: VOLUME_COPY_OUTCOME.failed, bytes: 0, availableBytes: 0, reason: VOLUME_COPY_MESSAGES.noReport };
}

/**
 * The data a container keeps in writable volumes and bind mounts, copied aside before an update replaces it
 * and put back when the update is rolled back: a new version may migrate its data, and the old one cannot read
 * that. Each checkpoint lives only while a roll back can use it.
 */
export class VolumeCheckpoints {
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<unknown>;

  constructor(private readonly dependencies: VolumeCheckpointsDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.sleep = dependencies.sleep ?? wait;
  }

  /**
   * Copies a stopped container's data aside. A completion manifest is published only after every copy succeeds.
   * The caller decides whether incomplete coverage may proceed (never for automatic undo).
   */
  async take(name: string, details: ContainerDetails): Promise<TakenCheckpoint> {
    const { docker, limitBytes } = this.dependencies;
    const mounts = dataMountsOf(details);
    const result = (complete: boolean, outcome: string): TakenCheckpoint => ({
      containerId: details.Id ?? null,
      mounts,
      complete,
      outcome,
    });
    if (mounts.length === 0) {
      return result(true, "");
    }
    if (limitBytes === 0) {
      return result(false, JOB_OUTCOMES.checkpointSkipped(JOB_OUTCOMES.checkpointOff));
    }
    if (details.Id === undefined || mounts.some((mount) => mount.source === "")) {
      return result(false, JOB_OUTCOMES.checkpointSkipped(VOLUME_COPY_MESSAGES.incomplete));
    }
    // Kept for containers no roll back can return to now.
    await this.discard(name);
    const takenAt = this.now();
    const generation = `${CHECKPOINT.volumePrefix}${name}-${takenAt}-${randomUUID()}`;
    const volumes = mounts.map((_mount, index) => `${generation}-${index}`);
    const manifest = `${generation}-manifest`;
    try {
      for (const [index, mount] of mounts.entries()) {
        await docker.createVolume(volumes[index]!, {
          [CHECKPOINT.ofLabel]: name,
          [CHECKPOINT.containerLabel]: details.Id ?? "",
          [CHECKPOINT.targetLabel]: mount.target,
          [CHECKPOINT.takenAtLabel]: String(takenAt),
        });
      }
      const pairs = mounts.map((mount, index) => ({
        from: mount,
        to: { type: MOUNT_TYPE_VOLUME, source: volumes[index]! } as const,
      }));
      const report = await this.copy(VOLUME_COPY_VERB.keep, [String(limitBytes)], pairs);
      if (report.outcome === VOLUME_COPY_OUTCOME.kept && report.fidelity === CHECKPOINT.fidelity) {
        await docker.createVolume(manifest, {
          [CHECKPOINT.ofLabel]: name,
          [CHECKPOINT.containerLabel]: details.Id,
          [CHECKPOINT.takenAtLabel]: String(takenAt),
          [CHECKPOINT.manifestLabel]: JSON.stringify({
            version: 2,
            fidelity: CHECKPOINT.fidelity,
            limitations: CHECKPOINT.fidelityLimitations,
            mounts: mounts.map((mount, index) => ({ ...mount, volume: volumes[index]! })),
          }),
        });
        return result(true, JOB_OUTCOMES.checkpointTaken(mounts.length, sizeText(report.bytes)));
      }
      await this.removeEach(volumes);
      const oversized = report.outcome === VOLUME_COPY_OUTCOME.tooBig || report.outcome === VOLUME_COPY_OUTCOME.noRoom;
      const skipped = result(false, JOB_OUTCOMES.checkpointSkipped(this.whyNotKept(report)));
      return oversized ? { ...skipped, oversized: true } : skipped;
    } catch (error) {
      await this.removeEach([...volumes, manifest]);
      return result(false, JOB_OUTCOMES.checkpointSkipped(describeError(error)));
    }
  }

  /**
   * Puts back data only after the completion manifest and every mount's identity and presence have checked out.
   */
  async restore(name: string, parked: ContainerDetails): Promise<RestoredData> {
    const plan = await this.restorePlan(name, parked);
    if (plan.problem !== null || plan.pairs.length === 0) {
      return { at: plan.at, problem: plan.problem };
    }
    try {
      // An interrupted runner may leave its helper copying. Never start a second copy or the application beside it.
      for (const helper of await this.dependencies.docker.containerSummaries()) {
        if (helper.Labels?.[RESTORE_OWNER_LABEL] !== parked.Id) continue;
        await this.untilExited(helper.Id);
        if ((await this.dependencies.docker.inspect(helper.Id)) !== null)
          await this.dependencies.docker.removeStopped(helper.Id);
      }
      const report = await this.copy(
        VOLUME_COPY_VERB.restore,
        [],
        plan.pairs,
        async () => {
          const attached = await this.verify(name, parked);
          if (attached.problem !== null) throw new Error(attached.problem);
        },
        parked.Id,
      );
      const restored = report.outcome === VOLUME_COPY_OUTCOME.restored && report.fidelity === CHECKPOINT.fidelity;
      return { at: plan.at, problem: restored ? null : (report.reason ?? VOLUME_COPY_MESSAGES.noReport) };
    } catch (error) {
      return { at: null, problem: describeError(error) };
    }
  }

  /** Read-only preflight before the updater removes or renames any container. Restore checks again before copying. */
  async verify(name: string, parked: ContainerDetails): Promise<RestoredData> {
    const { at, problem } = await this.restorePlan(name, parked);
    return { at, problem };
  }

  private async restorePlan(name: string, parked: ContainerDetails): Promise<RestorePlan> {
    const mounts = dataMountsOf(parked);
    if (mounts.length === 0) {
      return { at: null, problem: null, pairs: [] };
    }
    const invalid = { at: null, problem: VOLUME_COPY_MESSAGES.incomplete, pairs: [] };
    try {
      if (parked.Id === undefined) {
        return invalid;
      }
      const kept = (await this.checkpointsOf(name)).filter(
        (volume) => volume.Labels?.[CHECKPOINT.containerLabel] === parked.Id,
      );
      const manifests = kept.filter((volume) => volume.Labels?.[CHECKPOINT.manifestLabel] !== undefined);
      if (manifests.length !== 1) {
        return invalid;
      }
      const labels = manifests[0]!.Labels!;
      const at = Number(labels[CHECKPOINT.takenAtLabel]);
      const manifest = manifestSchema.safeParse(JSON.parse(labels[CHECKPOINT.manifestLabel]!));
      if (!Number.isSafeInteger(at) || at <= 0 || !manifest.success || manifest.data.mounts.length !== mounts.length) {
        return invalid;
      }
      const coverage = manifest.data.mounts;
      if (
        new Set(coverage.map((mount) => mount.target)).size !== mounts.length ||
        new Set(coverage.map((mount) => mount.volume)).size !== mounts.length
      ) {
        return invalid;
      }
      const pairs: CopyPair[] = [];
      for (const mount of mounts) {
        const entry = coverage.find(
          (candidate) =>
            candidate.target === mount.target && candidate.type === mount.type && candidate.source === mount.source,
        );
        const volume = kept.find((candidate) => candidate.Name === entry?.volume);
        if (
          entry === undefined ||
          volume === undefined ||
          volume === manifests[0] ||
          volume.Labels?.[CHECKPOINT.takenAtLabel] !== labels[CHECKPOINT.takenAtLabel] ||
          volume.Labels?.[CHECKPOINT.targetLabel] !== mount.target
        ) {
          return invalid;
        }
        pairs.push({ from: { type: MOUNT_TYPE_VOLUME, source: volume.Name }, to: mount });
      }
      return { at, problem: null, pairs };
    } catch (error) {
      return { at: null, problem: describeError(error), pairs: [] };
    }
  }

  /** Removes a container's checkpoints: once no roll back can use them, they are only copies of its data. */
  async discard(name: string) {
    const volumes = await this.checkpointsOf(name).catch((): DockerVolume[] => []);
    await this.removeEach(volumes.map((volume) => volume.Name));
  }

  private checkpointsOf(name: string) {
    return this.dependencies.docker.volumes(`${CHECKPOINT.ofLabel}=${name}`);
  }

  private async removeEach(volumes: readonly string[]) {
    for (const volume of volumes) {
      await this.dependencies.docker.removeVolume(volume).catch(() => undefined);
    }
  }

  private whyNotKept(report: VolumeCopyReport): string {
    if (report.outcome === VOLUME_COPY_OUTCOME.tooBig) {
      return JOB_OUTCOMES.checkpointTooBig(sizeText(this.dependencies.limitBytes));
    }
    if (report.outcome === VOLUME_COPY_OUTCOME.noRoom) {
      return JOB_OUTCOMES.checkpointNoRoom(sizeText(report.bytes));
    }
    return report.reason ?? VOLUME_COPY_MESSAGES.noReport;
  }

  /**
   * The helper: Autoheal's image as root, with only the capabilities copying files needs, no network,
   * and each pair of mounts under /from and /to; read-only where it copies from.
   */
  private async copy(
    verb: (typeof VOLUME_COPY_VERB)[keyof typeof VOLUME_COPY_VERB],
    commandArguments: readonly string[],
    pairs: readonly { from: HelperMount; to: HelperMount }[],
    beforeStart?: () => Promise<unknown>,
    restoreOwner?: string,
  ): Promise<VolumeCopyReport> {
    const { docker, helperImage } = this.dependencies;
    const image = await helperImage();
    const mountOf = (mount: HelperMount, target: string, readOnly: boolean) => ({
      Type: mount.type,
      Source: mount.source,
      Target: target,
      ReadOnly: readOnly,
      // An empty volume is not filled from the helper's image.
      ...(mount.type === MOUNT_TYPE_VOLUME ? { VolumeOptions: { NoCopy: true } } : {}),
    });
    const helper = `${HOST_HELPER.containerPrefix}${CHECKPOINT.helperPrefix}${randomUUID()}`;
    await docker.create(helper, {
      Image: image,
      Cmd: [COMMAND_VOLUME_COPY, verb, ...commandArguments],
      User: HOST_HELPER.user,
      Labels: {
        [HOST_HELPER.label]: HOST_HELPER.labelValue,
        ...(restoreOwner === undefined ? {} : { [RESTORE_OWNER_LABEL]: restoreOwner }),
      },
      NetworkDisabled: true,
      Healthcheck: { Test: [HOST_HELPER.noHealthcheck] },
      HostConfig: {
        Mounts: pairs.flatMap(({ from, to }, index) => [
          mountOf(from, `${CHECKPOINT.fromTarget}/${index}`, true),
          mountOf(to, `${CHECKPOINT.toTarget}/${index}`, false),
        ]),
        ReadonlyRootfs: true,
        CapDrop: [HOST_HELPER.allCapabilities],
        CapAdd: [...CHECKPOINT.capabilities],
        SecurityOpt: [HOST_HELPER.noNewPrivileges, HOST_HELPER.noSelinuxLabel],
        NetworkMode: HOST_HELPER.network,
        Memory: CHECKPOINT.memoryBytes,
        PidsLimit: HOST_HELPER.pidsLimit,
      },
    });
    try {
      await beforeStart?.();
      await docker.start(helper);
      await this.untilExited(helper);
      return reportIn(await docker.logs(helper, false));
    } finally {
      await docker.remove(helper).catch(() => undefined);
    }
  }

  private async untilExited(helper: string) {
    const deadline = this.now() + CHECKPOINT.exitDeadlineMilliseconds;
    while (this.now() < deadline) {
      const details = await this.dependencies.docker.inspect(helper);
      if (details === null || !details.State.Running) {
        return;
      }
      await this.sleep(HOST_HELPER.exitPollMilliseconds);
    }
    throw new Error(VOLUME_COPY_MESSAGES.didNotFinish);
  }
}
