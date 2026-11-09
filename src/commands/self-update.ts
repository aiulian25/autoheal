import { z } from "zod";
import {
  outcomeIn,
  SelfUpdateOutcomeFile,
  unreadableReason,
} from "../control-plane/self-update/self-update-outcome.js";
import { NO_DATABASE, SelfUpdateDatabaseFiles } from "../control-plane/self-update/self-update-database.js";
import { selfUpdate } from "../control-plane/self-update/self-update-helper.js";
import { DockerClient } from "../runner/docker-client.js";
import { describeError } from "../shared/errors.js";
import {
  DEFAULT_DATA_DIRECTORY,
  DEFAULT_DOCKER_SOCKET_PATH,
  EXIT_FAILURE,
  EXIT_SUCCESS,
  EXIT_USAGE,
  SELF_UPDATE,
  SELF_UPDATE_STATUS,
  SELF_UPDATE_TEXT,
  USAGE,
} from "../shared/constants.js";

// The container to replace, the image id to run it on, the name that image was asked for by, and — for a sidecar
// runner, which keeps no database — the word saying so.
const selfUpdateArguments = z.union([
  z.tuple([z.string().min(1), z.string().min(1), z.string().min(1)]),
  z.tuple([z.string().min(1), z.string().min(1), z.string().min(1), z.literal(SELF_UPDATE.runnerMode)]),
]);

/**
 * Run by the helper container the control plane starts from its new image, with the Docker socket and the data
 * volume mounted: replaces the control plane's container and watches the new one, writing how it goes as it goes.
 */
export async function runSelfUpdate(
  commandArguments: string[],
  output: Pick<Console, "log" | "error"> = console,
  dataDirectory: string = DEFAULT_DATA_DIRECTORY,
  docker: DockerClient = new DockerClient(DEFAULT_DOCKER_SOCKET_PATH),
): Promise<number> {
  const parsed = selfUpdateArguments.safeParse(commandArguments);
  if (!parsed.success) {
    output.error(USAGE);
    return EXIT_USAGE;
  }
  const [container, image, reference, runnerMode] = parsed.data;
  const outcomes = new SelfUpdateOutcomeFile(dataDirectory);
  const record = outcomes.read();
  const blocked = unreadableReason(record);
  // The helper runs with the socket: it must stop where the control plane would, and before it touches Docker.
  if (blocked !== null) {
    output.error(SELF_UPDATE_TEXT.recoveryBlocked(blocked));
    return EXIT_FAILURE;
  }
  // Said in a line of its own, last: a runner reads its helper's last line as how its update went.
  const outcome = await selfUpdate(
    docker,
    { container, image, reference },
    (step) => {
      outcomes.write(step);
      output.log(step.message);
    },
    runnerMode === undefined ? new SelfUpdateDatabaseFiles(dataDirectory) : NO_DATABASE,
    outcomeIn(record),
  ).catch((error: unknown) => {
    output.error(SELF_UPDATE_TEXT.helperFailed(describeError(error)));
    return null;
  });
  return outcome?.status === SELF_UPDATE_STATUS.succeeded ? EXIT_SUCCESS : EXIT_FAILURE;
}
