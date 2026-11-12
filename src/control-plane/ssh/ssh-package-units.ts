import { packageCommand } from "../../host-helper/package-units.js";
import type { PackageUnitStarter } from "../../runner/host-package-jobs.js";
import {
  ERROR_TEXT_LIMIT,
  HOST_HELPER_OUTCOME,
  HOST_PACKAGE_ENVIRONMENT,
  HOST_PACKAGE_LOG_FILE,
  HOST_PACKAGE_STATUS_FILE,
  HOST_PACKAGE_STATUS_SCRIPT,
  HOST_PACKAGE_TIMEOUT_MICROSECONDS,
  HOST_PACKAGE_UNIT,
  HOST_PACKAGE_UNIT_DESCRIPTION,
  HOST_PACKAGE_WRAPPER,
  HOST_SCRIPT_NAME,
  SHELL_COMMAND_OPTION,
  SHELL_PATH,
  SSH_PACKAGE_RUNS,
  SYSTEMD,
  type HostPackageManager,
  type HostPackageVerb,
} from "../../shared/constants.js";
import { describeError } from "../../shared/errors.js";
import { shellQuoted } from "./ssh-host-files.js";
import type { SshExecResult } from "./ssh-session.js";

const line = (words: readonly string[]) => words.map(shellQuoted).join(" ");

/**
 * The root command that starts one package job on the host: its run and status scripts written where only root reads,
 * then started by systemd-run as the one transient unit, with the environment, timeout and clean-up the runner's
 * helper gives it. The unit outlives the SSH session, as it outlives a runner, and leaves its log and status files.
 */
export function packageUnitCommand(
  manager: HostPackageManager,
  verb: HostPackageVerb,
  jobId: string,
  packages: readonly string[],
): string {
  const runPath = SSH_PACKAGE_RUNS.runScript(jobId);
  const statusPath = SSH_PACKAGE_RUNS.statusScript(jobId);
  const run = [
    SHELL_PATH,
    SHELL_COMMAND_OPTION,
    HOST_PACKAGE_WRAPPER,
    HOST_SCRIPT_NAME,
    HOST_PACKAGE_LOG_FILE(jobId, verb),
    ...packageCommand(manager, verb, packages),
  ];
  const status = [
    SHELL_PATH,
    SHELL_COMMAND_OPTION,
    HOST_PACKAGE_STATUS_SCRIPT,
    HOST_SCRIPT_NAME,
    HOST_PACKAGE_STATUS_FILE(jobId, verb),
  ];
  const runScript = `exec ${line(run)}\n`;
  const statusScript = `${line(status)}\n${line(["rm", "-f", runPath, statusPath])}\n`;
  const systemdRun = [
    SSH_PACKAGE_RUNS.systemdRun,
    SSH_PACKAGE_RUNS.noBlock,
    `--unit=${HOST_PACKAGE_UNIT}`,
    `--description=${HOST_PACKAGE_UNIT_DESCRIPTION(verb, jobId)}`,
    `--property=Type=${SYSTEMD.oneshot}`,
    `--property=CollectMode=${SYSTEMD.collectMode}`,
    `--property=TimeoutStartSec=${HOST_PACKAGE_TIMEOUT_MICROSECONDS[verb]}us`,
    ...HOST_PACKAGE_ENVIRONMENT.map((setting) => `--setenv=${setting}`),
    `--property=ExecStopPost=${SHELL_PATH} ${statusPath}`,
    "--",
    SHELL_PATH,
    runPath,
  ];
  const start = [
    `printf '%s' ${shellQuoted(runScript)} > ${shellQuoted(runPath)}`,
    `printf '%s' ${shellQuoted(statusScript)} > ${shellQuoted(statusPath)}`,
    line(systemdRun),
  ].join(" && ");
  // A start refused for certain, or scripts not all written, leaves nothing of this job. A session lost part-way runs
  // nothing more, so a unit that may have started keeps the scripts it needs.
  const refused = `{ refused=$?; ${line(["rm", "-f", "--", runPath, statusPath])}; exit "$refused"; }`;
  return ["set -e", "umask 077", line(["mkdir", "-p", SSH_PACKAGE_RUNS.directory]), `{ ${start}; } || ${refused}`].join(
    "\n",
  );
}

/** Package jobs started as root over the host's session, with its saved password. */
export const sshPackageUnits =
  (asRoot: (command: string) => Promise<SshExecResult>): PackageUnitStarter =>
  async (manager, verb, jobId, packages) => {
    const result = await asRoot(packageUnitCommand(manager, verb, jobId, packages)).catch(
      (error: unknown): SshExecResult => ({ stdout: "", stderr: describeError(error), exitCode: null }),
    );
    if (result.exitCode === 0) {
      return { outcome: HOST_HELPER_OUTCOME.started };
    }
    const said = `${result.stderr}${result.stdout}`.trim();
    return SSH_PACKAGE_RUNS.busy.test(said)
      ? { outcome: HOST_HELPER_OUTCOME.busy }
      : { outcome: HOST_HELPER_OUTCOME.failed, reason: said.slice(0, ERROR_TEXT_LIMIT) };
  };
