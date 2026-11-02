import {
  APPLICATION_BOOT_DRILL,
  APPLICATION_BOOT_READINESS,
  APPLICATION_BOOT_TEXT,
  type ApplicationBootEvidence,
  type BootDrillRecipe,
} from "../shared/application-backups.js";
import { HOST_HELPER, RESTART_POLICY_NONE } from "../shared/constants.js";
import { describeError } from "../shared/errors.js";
import { redactSecrets } from "../shared/redaction.js";
import type { DockerClient } from "./docker-client.js";
import type { RemedyGuard } from "./remedy-guard.js";
import { untilSettled } from "./settle-check.js";

const MILLISECONDS_PER_SECOND = 1000;
const WITH_NO_TTY = false;

export interface BootDrillDependencies {
  docker: Pick<DockerClient, "create" | "start" | "inspect" | "inspectImage" | "logs" | "remove">;
  guard: Pick<RemedyGuard, "hold" | "release" | "persisted">;
  wait: (milliseconds: number) => Promise<unknown>;
  clock: () => number;
}

export interface BootDrillInput {
  taskId: string;
  imageId: string | null;
  // The live container's user, as its files are owned by it. Nothing else of its settings is carried over: not its
  // environment, command, ports, networks or other mounts.
  user: string;
  volumes: readonly { source: string; target: string }[];
  recipe: BootDrillRecipe;
}

const specificationOf = ({ taskId, imageId, user, volumes, recipe }: BootDrillInput) => ({
  Image: imageId,
  User: user,
  Env: recipe.environment.map(({ name, value }) => `${name}=${value}`),
  Labels: { [HOST_HELPER.label]: HOST_HELPER.labelValue, [APPLICATION_BOOT_DRILL.label]: taskId },
  HostConfig: {
    Mounts: volumes.map(({ source, target }) => ({ Type: "volume", Source: source, Target: target })),
    NetworkMode: HOST_HELPER.network,
    RestartPolicy: { Name: RESTART_POLICY_NONE },
    CapDrop: [HOST_HELPER.allCapabilities],
    CapAdd: [...APPLICATION_BOOT_DRILL.capabilities],
    SecurityOpt: [HOST_HELPER.noNewPrivileges],
    Memory: APPLICATION_BOOT_DRILL.memoryBytes,
    NanoCpus: APPLICATION_BOOT_DRILL.nanoCpus,
    PidsLimit: APPLICATION_BOOT_DRILL.pidsLimit,
  },
});

async function maskedLogs({ docker }: BootDrillDependencies, name: string, recipe: BootDrillRecipe) {
  const logs = await docker.logs(name, WITH_NO_TTY, APPLICATION_BOOT_DRILL.logLines).catch(() => null);
  if (logs === null) return null;
  const secrets = recipe.environment.map(({ name: key, value }) => `${key}=${value}`);
  return redactSecrets(logs, secrets).slice(-APPLICATION_BOOT_DRILL.logCharacters);
}

/**
 * The application itself, started from fresh volumes on the image it was backed up with, and watched until it is ready
 * or plainly is not. It reaches no network and no host path. Held while it runs, so its stopping is not taken for a
 * failure to heal; removed whatever happened, and what could not be removed is said.
 */
export async function bootOnClones(
  dependencies: BootDrillDependencies,
  input: BootDrillInput,
): Promise<ApplicationBootEvidence> {
  const { docker, guard, wait, clock } = dependencies;
  const { recipe, imageId, taskId } = input;
  const evidence: ApplicationBootEvidence = {
    imageId,
    readySeconds: recipe.readySeconds,
    readiness: null,
    problem: null,
    logs: null,
    left: [],
  };
  if (imageId === null) return { ...evidence, problem: APPLICATION_BOOT_TEXT.noImage };
  if ((await docker.inspectImage(imageId)) === null) return { ...evidence, problem: APPLICATION_BOOT_TEXT.imageGone };
  const name = `${APPLICATION_BOOT_DRILL.containerPrefix}${taskId}`;
  guard.hold(name);
  try {
    await docker.create(name, specificationOf(input));
    await docker.start(name);
    evidence.problem = await untilSettled(
      (each) => docker.inspect(each),
      name,
      {
        pollMilliseconds: APPLICATION_BOOT_DRILL.pollMilliseconds,
        settleMilliseconds: recipe.readySeconds * MILLISECONDS_PER_SECOND,
        healthySettleMilliseconds: 0,
        timeoutMilliseconds: APPLICATION_BOOT_DRILL.timeoutMilliseconds,
      },
      APPLICATION_BOOT_TEXT,
      wait,
      clock,
    );
    if (evidence.problem === null) {
      const state = (await docker.inspect(name))?.State;
      evidence.readiness =
        state?.Health === undefined ? APPLICATION_BOOT_READINESS.stayedRunning : APPLICATION_BOOT_READINESS.healthy;
    }
    // Staying up proves nothing by itself, so what it said is kept for a person to judge.
    if (evidence.readiness !== APPLICATION_BOOT_READINESS.healthy) {
      evidence.logs = await maskedLogs(dependencies, name, recipe);
    }
  } catch (error) {
    evidence.problem = describeError(error).slice(0, APPLICATION_BOOT_DRILL.problemCharacters);
  } finally {
    await docker.remove(name).catch(() => undefined);
    const stillThere = await docker.inspect(name).catch(() => undefined);
    if (stillThere !== null) evidence.left = [name];
    guard.release(name);
    await guard.persisted();
  }
  return evidence;
}
