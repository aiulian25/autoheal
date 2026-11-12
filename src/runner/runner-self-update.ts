import {
  APP_VERSION,
  COMMAND_SELF_UPDATE,
  CONTAINER_STATE_EXITED,
  DEFAULT_DATA_DIRECTORY,
  DEFAULT_DOCKER_SOCKET_PATH,
  DIGEST_SEPARATOR,
  EXIT_SUCCESS,
  HOST_HELPER,
  IMAGE_ID_PREFIX,
  IMAGE_REFERENCE,
  RUNNER_UPDATE_REPORT,
  SELF_UPDATE,
  SELF_UPDATE_CLEARABLE_HELPER,
  RUNNER_UPDATE_TEXT,
} from "../shared/constants.js";
import { imageRepository, imageTag } from "../shared/image-reference.js";
import { isNewerTag } from "../shared/image-versions.js";
import type { RunnerUpdateReport } from "../shared/protocol.js";
import type { DockerClient } from "./docker-client.js";
import { provenanceRefusal } from "./image-provenance.js";
import type { ProvenanceSource } from "./image-updates.js";
import type { ContainerDetails } from "./incident-report.js";

export type RunnerUpdateDocker = Pick<
  DockerClient,
  "pull" | "inspect" | "inspectImage" | "createVolume" | "create" | "start" | "remove"
>;

/** Where this runner's container is, as Docker knows it, where its Docker socket is, and who may use that. */
export interface OwnContainer {
  /** Its name or id, as Docker knows it. */
  reference: string;
  /** Where the socket is inside its container: DOCKER_SOCKET_PATH, or the default. */
  socketPath: string;
  socketGroup: number;
}

/** What a hand-over came to: handed over to the helper, or refused before anything changed, and why. */
export interface HandOver {
  handedOver: boolean;
  outcome: string;
  // Already on the image it would move to: nothing went wrong, there was only nothing to do.
  upToDate?: true;
}

// Where a mount of this container comes from, as Docker needs it for the helper's: a volume's name or a path.
function sourceOf(container: ContainerDetails, destination: string): string | null {
  const mount = container.Mounts?.find((candidate) => candidate.Destination === destination);
  return mount?.Name ?? mount?.Source ?? null;
}

/**
 * The image this runner moves to, keeping the tag the person chose for it. A channel tag (latest, 1, 1.2) stays and is
 * pulled again, bringing whatever it points to now. An exact release, or a digest, moves to the control plane's
 * release when that is newer, and never back to an older one. A digest names no version: the release this runner runs,
 * as built into it, stands in for it.
 */
export function updateTarget(own: string, release: string, running: string = APP_VERSION): string {
  const releaseTag = imageTag(release);
  const current = own.includes(DIGEST_SEPARATOR) ? running : imageTag(own);
  return isNewerTag(current, releaseTag) ? `${imageRepository(own)}${IMAGE_REFERENCE.tagSeparator}${releaseTag}` : own;
}

// The tag this runner was started from, as its compose file named it, or the one the last update noted on it.
function referenceOf(container: ContainerDetails, release: string): string {
  const configured = container.Config.Image;
  if (!configured.startsWith(IMAGE_ID_PREFIX)) return configured;
  return container.Config.Labels?.[SELF_UPDATE.referenceLabel] ?? release;
}

const isClearable = (helper: ContainerDetails | null) =>
  helper === null || SELF_UPDATE_CLEARABLE_HELPER.includes(helper.State.Status ?? "");

/**
 * A sidecar runner updating itself, because a person asked from the dashboard, to the image `updateTarget` picks. A
 * container cannot replace itself from inside, so it pulls the new image and hands the swap to the same one-shot
 * helper the control plane uses for its own: the helper replaces this container keeping every mount and setting,
 * watches the new one, and puts this one back if the new one does not come back healthy.
 *
 * Nothing changes until the helper starts: an image that cannot be pulled, one that is already running, or a helper
 * already at work all refuse with nothing touched. The helper stays once done, so the runner that runs then can tell
 * how it went; the next update clears it.
 */
export async function handOverToRelease(
  docker: RunnerUpdateDocker,
  own: OwnContainer,
  release: string,
  // Where the admin asks for a signed image, this one holds the Docker socket: it is held to that like any update.
  provenance: ProvenanceSource | null = null,
  running: string = APP_VERSION,
): Promise<HandOver> {
  const refused = (outcome: string): HandOver => ({ handedOver: false, outcome });
  const details = await docker.inspect(own.reference);
  if (details === null) return refused(RUNNER_UPDATE_TEXT.ownContainerUnknown);
  const reference = updateTarget(referenceOf(details, release), release, running);
  const socket = sourceOf(details, own.socketPath);
  if (socket === null) return refused(RUNNER_UPDATE_TEXT.noSocket);
  try {
    await docker.pull(reference);
  } catch (error) {
    return refused(RUNNER_UPDATE_TEXT.pullFailed(reference, error instanceof Error ? error.message : String(error)));
  }
  const image = await docker.inspectImage(reference);
  if (image === null) return refused(RUNNER_UPDATE_TEXT.pullFailed(reference, RUNNER_UPDATE_TEXT.notThereAfterPull));
  if (image.Id === details.Image) {
    return { handedOver: false, outcome: RUNNER_UPDATE_TEXT.alreadyThere(reference), upToDate: true };
  }
  const heldBack = await provenanceRefusal(provenance, reference, image);
  if (heldBack !== null) return refused(heldBack);
  // One swap at a time: a helper still at work is never interrupted by another.
  if (!isClearable(await docker.inspect(SELF_UPDATE.helperName))) return refused(RUNNER_UPDATE_TEXT.helperBusy);
  await docker.remove(SELF_UPDATE.helperName);
  // Where the helper keeps how the swap goes, so one interrupted part-way is finished or put back, never left.
  await docker.createVolume(SELF_UPDATE.runnerVolume, { [SELF_UPDATE.label]: "1" });
  await docker.create(SELF_UPDATE.helperName, {
    Image: image.Id,
    Cmd: [COMMAND_SELF_UPDATE, details.Id ?? own.reference, image.Id, reference, SELF_UPDATE.runnerMode],
    User: SELF_UPDATE.user,
    Labels: { [SELF_UPDATE.label]: "1" },
    // The image's own check is a runner's, which the helper is not: it would only ever read unhealthy.
    Healthcheck: { Test: [HOST_HELPER.noHealthcheck] },
    HostConfig: {
      AutoRemove: false,
      Binds: [`${socket}:${DEFAULT_DOCKER_SOCKET_PATH}`, `${SELF_UPDATE.runnerVolume}:${DEFAULT_DATA_DIRECTORY}`],
      GroupAdd: [String(own.socketGroup)],
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      NetworkMode: "none",
    },
  });
  await docker.start(SELF_UPDATE.helperName);
  return { handedOver: true, outcome: RUNNER_UPDATE_TEXT.handedOver(reference) };
}

const lastLineOf = (said: string) =>
  said.trim().split("\n").at(-1)?.trim().slice(0, RUNNER_UPDATE_REPORT.messageCharacters) || null;

/**
 * How this runner's last update from the dashboard went, as its helper left it: at work, or done with what it said
 * last. Null where no helper is here: none ever ran, or an older runner's removed itself.
 */
export async function lastUpdateOf(docker: Pick<DockerClient, "inspect" | "logs">): Promise<RunnerUpdateReport | null> {
  const helper = await docker.inspect(SELF_UPDATE.helperName);
  if (helper?.State.Running === true) {
    return { state: RUNNER_UPDATE_REPORT.state.running, finishedAt: null, message: null };
  }
  if (helper?.State.Status !== CONTAINER_STATE_EXITED) return null;
  const said = await docker.logs(SELF_UPDATE.helperName, false, RUNNER_UPDATE_REPORT.logLines).catch(() => "");
  const finishedAt = Date.parse(helper.State.FinishedAt ?? "");
  const succeeded = helper.State.ExitCode === EXIT_SUCCESS;
  return {
    state: succeeded ? RUNNER_UPDATE_REPORT.state.succeeded : RUNNER_UPDATE_REPORT.state.failed,
    // None, or Docker's zero time, where it gives no finish.
    finishedAt: finishedAt > 0 ? finishedAt : null,
    message: lastLineOf(said),
  };
}
