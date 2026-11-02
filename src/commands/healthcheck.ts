import { existsSync } from "node:fs";
import { aliveFileAge } from "../runner/alive-file.js";
import {
  ALIVE_FILE_PATH,
  ALIVE_MAXIMUM_AGE_MILLISECONDS,
  COMMAND_MESSAGES,
  EXIT_FAILURE,
  EXIT_SUCCESS,
  HEALTHCHECK_TIMEOUT_MILLISECONDS,
  HEALTH_URL,
} from "../shared/constants.js";

type Output = Pick<Console, "log" | "error">;

function runnerHealth(output: Output): number {
  const age = aliveFileAge(ALIVE_FILE_PATH, Date.now());
  if (age === null || age > ALIVE_MAXIMUM_AGE_MILLISECONDS) {
    output.error(COMMAND_MESSAGES.unhealthy(COMMAND_MESSAGES.eventStreamStale));
    return EXIT_FAILURE;
  }
  output.log(COMMAND_MESSAGES.healthy);
  return EXIT_SUCCESS;
}

async function controlPlaneHealth(output: Output): Promise<number> {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(HEALTHCHECK_TIMEOUT_MILLISECONDS) });
    if (!response.ok) {
      output.error(COMMAND_MESSAGES.unhealthy(String(response.status)));
      return EXIT_FAILURE;
    }
  } catch (error) {
    output.error(COMMAND_MESSAGES.unhealthy(String(error)));
    return EXIT_FAILURE;
  }
  output.log(COMMAND_MESSAGES.healthy);
  return EXIT_SUCCESS;
}

/**
 * Docker's HEALTHCHECK; distroless has no shell or curl, so the app checks itself. The runner has
 * no port, so in runner mode (its alive file exists) health means "watching Docker recently".
 */
export async function runHealthcheck(_commandArguments: string[], output: Output = console): Promise<number> {
  return existsSync(ALIVE_FILE_PATH) ? runnerHealth(output) : controlPlaneHealth(output);
}
