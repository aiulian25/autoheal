import { loadRunnerConfig } from "../config/runner-config.js";
import { loadControlPlaneConfig } from "../config/control-plane-config.js";
import { ConfigError } from "../config/environment-schema.js";
import {
  CONFIG_MESSAGES,
  EXIT_FAILURE,
  EXIT_SUCCESS,
  EXIT_USAGE,
  MODE_RUNNER,
  MODE_CONTROL_PLANE,
  USAGE,
} from "../shared/constants.js";

const configLoaders: Record<string, (environment: NodeJS.ProcessEnv) => unknown> = {
  [MODE_CONTROL_PLANE]: loadControlPlaneConfig,
  [MODE_RUNNER]: loadRunnerConfig,
};

export async function runCheckConfig(
  [mode = ""]: string[],
  environment: NodeJS.ProcessEnv = process.env,
  output: Pick<Console, "log" | "error"> = console,
): Promise<number> {
  const loadConfig = configLoaders[mode];
  if (loadConfig === undefined) {
    output.error(USAGE);
    return EXIT_USAGE;
  }
  try {
    loadConfig(environment);
  } catch (error) {
    if (!(error instanceof ConfigError)) {
      throw error;
    }
    output.error(error.message);
    return EXIT_FAILURE;
  }
  output.log(CONFIG_MESSAGES.valid);
  return EXIT_SUCCESS;
}
