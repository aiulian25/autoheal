import { DockerClient } from "../runner/docker-client.js";
import { ShutdownJournal } from "../runner/shutdown-journal.js";
import { DEFAULT_DOCKER_SOCKET_PATH, EXIT_FAILURE, EXIT_SUCCESS, RUNNER_MESSAGES } from "../shared/constants.js";
import { describeError } from "../shared/errors.js";

const CLEAR = "--clear";

/**
 * What a runner will not start over, and the way past it. A runner that finds an operation interrupted part-way
 * refuses to start, because one of them may have half-applied something destructive and it cannot tell. This says
 * what those operations were; with `--clear` it drops the records, which is a person saying "I have looked".
 *
 * Nothing is undone and nothing is retried: the records are notes that something was in flight, not the work.
 */
export async function runRecover(
  commandArguments: string[],
  output: Pick<Console, "log" | "error"> = console,
  journal: Pick<ShutdownJournal, "blocking" | "clearBlocking"> = new ShutdownJournal(
    new DockerClient(DEFAULT_DOCKER_SOCKET_PATH),
  ),
): Promise<number> {
  const clearing = commandArguments.includes(CLEAR);
  try {
    const blocking = await journal.blocking();
    if (blocking.length === 0) {
      output.log(RUNNER_MESSAGES.recoveryNothing);
      return EXIT_SUCCESS;
    }
    for (const record of blocking) {
      output.log(RUNNER_MESSAGES.recoverySaid(record));
    }
    if (!clearing) {
      output.log(RUNNER_MESSAGES.recoveryHowTo);
      return EXIT_SUCCESS;
    }
    const cleared = await journal.clearBlocking();
    output.log(RUNNER_MESSAGES.recoveryCleared(cleared.length));
    return EXIT_SUCCESS;
  } catch (error) {
    output.error(describeError(error));
    return EXIT_FAILURE;
  }
}
