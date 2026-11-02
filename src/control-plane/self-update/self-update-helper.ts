import { setTimeout as wait } from "node:timers/promises";
import type { SelfUpdateOutcome } from "../../shared/api.js";
import {
  HEALTH_HEALTHY,
  SELF_UPDATE,
  SELF_UPDATE_PHASE,
  SELF_UPDATE_STATUS,
  SELF_UPDATE_TEXT,
  type SelfUpdatePhase,
} from "../../shared/constants.js";
import { describeError } from "../../shared/errors.js";
import { recreateSpecification } from "../../runner/container-updater.js";
import type { DockerClient } from "../../runner/docker-client.js";
import { containerNameOf, type ContainerDetails } from "../../runner/incident-report.js";

import type { DatabaseSnapshot, SelfUpdateDatabase } from "./self-update-database.js";
import { unfinishedRecovery, type JournalledOutcome } from "./self-update-outcome.js";

type HelperDocker = Pick<
  DockerClient,
  "inspect" | "inspectImage" | "stop" | "rename" | "create" | "connect" | "start" | "remove"
>;

export interface SelfUpdateRequest {
  // The control plane's container, by id, and the image to run it on: its id, and the name it was asked for by.
  container: string;
  image: string;
  reference: string;
}

export interface SelfUpdateTiming {
  healthyWithinMilliseconds: number;
  watchMilliseconds: number;
  pollMilliseconds: number;
}

export const SELF_UPDATE_TIMING: SelfUpdateTiming = SELF_UPDATE;

// Healthy by its own check where it has one; running, where it has none.
const isHealthy = (details: ContainerDetails | null) =>
  details !== null &&
  details.State.Running === true &&
  (details.State.Health === undefined || details.State.Health.Status === HEALTH_HEALTHY);

/**
 * Autoheal's own container on a new image, as its update helper does it, outside the container it replaces: the old
 * one stopped, its database copied and checked with no writer left, the old one kept aside under another name, the
 * new one made with everything the old one was given, then watched. One that holds sees the old one and the copy
 * removed. One that does not is stopped, and only when it has stopped is the database put back if the old version
 * could not open it, and the old one started. Each phase is recorded before it begins, outside the database, so a later
 * helper can take it up from what Docker shows. Where nothing can safely start, it says so and leaves everything kept.
 */
export async function selfUpdate(
  docker: HelperDocker,
  request: SelfUpdateRequest,
  record: (outcome: JournalledOutcome) => void,
  database: SelfUpdateDatabase,
  earlier: JournalledOutcome | null = null,
  timing: SelfUpdateTiming = SELF_UPDATE_TIMING,
  now: () => number = Date.now,
): Promise<SelfUpdateOutcome> {
  const resumed = unfinishedRecovery(earlier);
  if (resumed !== null && earlier?.to !== request.image) {
    throw new Error(`an update to ${earlier?.to} is unfinished`);
  }
  const original = resumed?.original ?? request.container;
  const old = await docker.inspect(original);
  if (old === null && resumed === null) {
    throw new Error(`no container ${request.container}`);
  }
  const name = resumed?.name ?? containerNameOf(old!);
  const previous = `${name}${SELF_UPDATE.previousSuffix}`;
  const startedAt = earlier !== null && resumed !== null ? earlier.startedAt : now();
  const from = (resumed !== null ? earlier?.from : old?.Image) ?? "";
  let phase: SelfUpdatePhase = resumed?.phase ?? SELF_UPDATE_PHASE.preparing;
  let snapshot: DatabaseSnapshot | null = resumed?.snapshot ?? null;
  const step = (status: SelfUpdateOutcome["status"], message: string, final: boolean) => {
    const outcome = {
      status,
      from,
      to: request.image,
      reference: request.reference,
      startedAt,
      finishedAt: final ? now() : null,
      message,
    };
    const recovery = final ? null : { version: SELF_UPDATE.recoveryVersion, phase, original, name, snapshot };
    record({ ...outcome, recovery });
    return outcome;
  };
  const healthyBefore = async (deadline: number) => {
    while (now() < deadline) {
      if (isHealthy(await docker.inspect(name))) return true;
      await wait(timing.pollMilliseconds);
    }
    return false;
  };
  const staysHealthy = async (deadline: number) => {
    while (now() < deadline) {
      if (!isHealthy(await docker.inspect(name))) return false;
      await wait(timing.pollMilliseconds);
    }
    return true;
  };
  // Asked to stop, and seen to have: nothing is done to its data on the word of the stop alone.
  const stopped = async (container: string) => {
    await docker.stop(container, SELF_UPDATE.stopTimeoutSeconds);
    if ((await docker.inspect(container))?.State.Running === true) {
      throw new Error(`${container} did not stop`);
    }
  };
  const blocked = (error: unknown) =>
    step(SELF_UPDATE_STATUS.blocked, SELF_UPDATE_TEXT.blocked(describeError(error)), false);
  const finish = (status: SelfUpdateOutcome["status"], message: string) => {
    phase = SELF_UPDATE_PHASE.finished;
    return step(status, message, true);
  };
  const rollBack = async (status: SelfUpdateOutcome["status"], message: string) => {
    phase = SELF_UPDATE_PHASE.rollingBack;
    step(SELF_UPDATE_STATUS.updating, message, false);
    try {
      // What holds its name may be the new one, or the old one if an earlier helper got that far.
      const holder = await docker.inspect(name);
      const isOriginal = holder?.Id === old?.Id;
      if (holder !== null && (!isOriginal || holder.State.Running === true)) await stopped(name);
      if (holder !== null && !isOriginal) await docker.remove(name, false);
      if (snapshot === null) throw new Error("no copy of the database was kept");
      const restored = database.restoreIfNeeded(snapshot);
      if (!isOriginal) await docker.rename(previous, name);
      await docker.start(name);
      return finish(status, restored ? `${message} ${SELF_UPDATE_TEXT.dataRestored}` : message);
    } catch (error) {
      return blocked(error);
    }
  };
  // Held for the whole watch: what the old version needed goes.
  const watch = async () => {
    phase = SELF_UPDATE_PHASE.watching;
    step(SELF_UPDATE_STATUS.watching, SELF_UPDATE_TEXT.watching, false);
    if (!(await staysHealthy(now() + timing.watchMilliseconds))) {
      return rollBack(SELF_UPDATE_STATUS.rolledBack, SELF_UPDATE_TEXT.didNotHold);
    }
    await docker.remove(previous, false);
    if (snapshot !== null) database.discard(snapshot);
    return finish(SELF_UPDATE_STATUS.succeeded, SELF_UPDATE_TEXT.succeeded);
  };

  if (resumed !== null) {
    // What Docker shows decides, as the record may be a step behind it.
    if (old === null) {
      if (!isHealthy(await docker.inspect(name))) return blocked(new Error(`${original} is gone`));
      if (snapshot !== null) database.discard(snapshot);
      return finish(SELF_UPDATE_STATUS.succeeded, SELF_UPDATE_TEXT.succeeded);
    }
    if (resumed.phase === SELF_UPDATE_PHASE.rollingBack) {
      return rollBack(SELF_UPDATE_STATUS.rolledBack, SELF_UPDATE_TEXT.interrupted);
    }
    if (containerNameOf(old) === previous) {
      if (isHealthy(await docker.inspect(name))) return watch();
      return rollBack(SELF_UPDATE_STATUS.rolledBack, SELF_UPDATE_TEXT.interrupted);
    }
  }
  const current = old!;
  step(SELF_UPDATE_STATUS.updating, SELF_UPDATE_TEXT.started, false);
  const specification = recreateSpecification(
    current,
    (await docker.inspectImage(current.Image ?? ""))?.Config ?? {},
    request.image,
  );
  try {
    await stopped(name);
    snapshot = await database.snapshot();
  } catch (error) {
    // Nothing has been replaced, and its database is its own.
    const message = SELF_UPDATE_TEXT.helperFailed(describeError(error));
    return docker.start(name).then(() => finish(SELF_UPDATE_STATUS.failed, message), blocked);
  }
  phase = SELF_UPDATE_PHASE.replacing;
  step(SELF_UPDATE_STATUS.updating, SELF_UPDATE_TEXT.started, false);
  await docker.rename(name, previous);
  try {
    await docker.create(name, specification.create);
    for (const [network, endpoint] of specification.extraNetworks) {
      await docker.connect(network, name, endpoint);
    }
    await docker.start(name);
  } catch (error) {
    return rollBack(SELF_UPDATE_STATUS.failed, SELF_UPDATE_TEXT.helperFailed(describeError(error)));
  }
  if (!(await healthyBefore(now() + timing.healthyWithinMilliseconds))) {
    return rollBack(SELF_UPDATE_STATUS.rolledBack, SELF_UPDATE_TEXT.notHealthy);
  }
  return watch();
}
