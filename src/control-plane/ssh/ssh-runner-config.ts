import type { ControlPlaneSettings, RunnerConfig } from "../../config/runner-config.js";
import {
  BYTES_PER_GIGABYTE,
  DEFAULT_HOST_DBUS_DIRECTORY,
  DEFAULT_SELF_CONTAINER_NAME,
  SSH_HOST_FILES,
  SSH_SESSION,
  SELF_UPDATE,
} from "../../shared/constants.js";
import type { SshRunnerDetails } from "./ssh-hosts-service.js";

/**
 * The same configuration a runner's .env gives, from an SSH host's row: its label, and the settings its page sets.
 * Ollama, Gotify and the dashboard's address come from the control plane's heartbeat answers, as for a runner that
 * sets none of them. Its files are its own root, read over its session; every local disk is reported, as a runner's
 * .env without HOST_FILESYSTEMS reports them.
 */
export function sshRunnerConfig(
  runner: SshRunnerDetails,
  controlPlane: Omit<ControlPlaneSettings, "token">,
): RunnerConfig {
  const { settings } = runner;
  return {
    hostLabel: runner.label,
    // No Autoheal container of its own runs there; a container of that name is protected as a runner protects itself.
    selfContainerName: DEFAULT_SELF_CONTAINER_NAME,
    controlPlane: { ...controlPlane, token: runner.token },
    joinFile: null,
    publicBaseUrl: null,
    ollama: null,
    gotify: null,
    dryRun: settings.dryRun,
    // As a runner's own .env gives: Autoheal's container, and what its update runs beside it.
    protectedContainers: new Set([
      ...settings.protectedContainers,
      DEFAULT_SELF_CONTAINER_NAME,
      `${DEFAULT_SELF_CONTAINER_NAME}${SELF_UPDATE.previousSuffix}`,
      SELF_UPDATE.helperName,
    ]),
    dockerSocketPath: SSH_SESSION.dockerSocketPath,
    hostRoot: SSH_HOST_FILES.hostRoot,
    hostFilesystems: [],
    hostPackages: settings.hostPackages,
    hostDbusDirectory: DEFAULT_HOST_DBUS_DIRECTORY,
    containerAccess: settings.containerAccess,
    // ponytail: always on over SSH, the shell being the SSH user's own; a setting on its page if one is ever wanted.
    hostTerminal: true,
    // Over SSH the shell is the SSH user's own login shell.
    hostTerminalUser: null,
    // ponytail: always on over SSH, the install being the SSH user's own doing; a setting when someone needs it off.
    hostDeploy: true,
    checkpointLimitBytes: settings.checkpointLimitGigabytes * BYTES_PER_GIGABYTE,
  };
}
