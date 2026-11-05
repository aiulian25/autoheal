import { z } from "zod";
import {
  outcomeIn,
  SelfUpdateOutcomeFile,
  unreadableReason,
} from "../control-plane/self-update/self-update-outcome.js";
import { SelfUpdateDatabaseFiles } from "../control-plane/self-update/self-update-database.js";
import { selfUpdate } from "../control-plane/self-update/self-update-helper.js";
import { DockerClient } from "../runner/docker-client.js";
import {
  DEFAULT_DATA_DIRECTORY,
  DEFAULT_DOCKER_SOCKET_PATH,
  EXIT_FAILURE,
  EXIT_SUCCESS,
  EXIT_USAGE,
  SELF_UPDATE_STATUS,
  SELF_UPDATE_TEXT,
  USAGE,
} from "../shared/constants.js";

// The control plane's container, the image id to run it on, and the name that image was asked for by.
const selfUpdateArguments = z.tuple([z.string().min(1), z.string().min(1), z.string().min(1)]);

/**
 * Run by the helper container the control plane starts from its new image, with the Docker socket and the data
 * volume mounted: replaces the control plane's container and watches the new one, writing how it goes as it goes.
 */
export async function runSelfUpdate(
  commandArguments: string[],
  output: Pick<Console, "log" | "error"> = console,
  dataDirectory: string = DEFAULT_DATA_DIRECTORY,
): Promise<number> {
  const parsed = selfUpdateArguments.safeParse(commandArguments);
  if (!parsed.success) {
    output.error(USAGE);
    return EXIT_USAGE;
  }
  const [container, image, reference] = parsed.data;
  const outcomes = new SelfUpdateOutcomeFile(dataDirectory);
  const record = outcomes.read();
  const blocked = unreadableReason(record);
  // The helper runs with the socket: it must stop where the control plane would, and before it touches Docker.
  if (blocked !== null) {
    output.error(SELF_UPDATE_TEXT.recoveryBlocked(blocked));
    return EXIT_FAILURE;
  }
  const outcome = await selfUpdate(
    new DockerClient(DEFAULT_DOCKER_SOCKET_PATH),
    { container, image, reference },
    (step) => {
      outcomes.write(step);
      output.log(step.message);
    },
    new SelfUpdateDatabaseFiles(dataDirectory),
    outcomeIn(record),
  );
  return outcome.status === SELF_UPDATE_STATUS.succeeded ? EXIT_SUCCESS : EXIT_FAILURE;
}
