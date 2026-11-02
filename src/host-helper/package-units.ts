import {
  DBUS_TYPE,
  HOST_PACKAGE_CHECK_SCRIPTS,
  HOST_PACKAGE_COMMANDS,
  HOST_PACKAGE_ENVIRONMENT,
  HOST_PACKAGE_LOG_FILE,
  HOST_PACKAGE_REBOOT_SCRIPT,
  HOST_PACKAGE_SHUTDOWN_SCRIPT,
  HOST_PACKAGE_STATUS_FILE,
  HOST_PACKAGE_STATUS_SCRIPT,
  HOST_PACKAGE_TIMEOUT_MICROSECONDS,
  HOST_PACKAGE_UNIT_DESCRIPTION,
  HOST_PACKAGE_WRAPPER,
  HOST_SCRIPT_NAME,
  SHELL_COMMAND_OPTION,
  SHELL_NAME,
  SHELL_PATH,
  SYSTEMD,
  type HostPackageManager,
  type HostPackageVerb,
} from "../shared/constants.js";
import { DbusVariant } from "./dbus-connection.js";

export interface UnitProperty {
  name: string;
  value: DbusVariant;
}

type Command = (packages: readonly string[]) => readonly string[];

const shellScript = (body: string) => () => [SHELL_PATH, SHELL_COMMAND_OPTION, body];
const { apt, dnf } = HOST_PACKAGE_COMMANDS;

// What each verb runs, by package manager; repairing is a dpkg thing, so dnf has no such verb.
const COMMANDS: Record<HostPackageManager, Partial<Record<HostPackageVerb, Command>>> = {
  apt: {
    check: shellScript(HOST_PACKAGE_CHECK_SCRIPTS.apt),
    upgrade: apt.upgrade,
    repair: () => apt.repair,
    autoremove: () => apt.autoremove,
    reboot: shellScript(HOST_PACKAGE_REBOOT_SCRIPT),
    shutdown: shellScript(HOST_PACKAGE_SHUTDOWN_SCRIPT),
  },
  dnf: {
    check: shellScript(HOST_PACKAGE_CHECK_SCRIPTS.dnf),
    upgrade: dnf.upgrade,
    autoremove: () => dnf.autoremove,
    reboot: shellScript(HOST_PACKAGE_REBOOT_SCRIPT),
    shutdown: shellScript(HOST_PACKAGE_SHUTDOWN_SCRIPT),
  },
};

export const verbFits = (manager: HostPackageManager, verb: HostPackageVerb) => COMMANDS[manager][verb] !== undefined;

/** The fixed command one job runs, whoever starts its unit: the helper over D-Bus, or root over SSH. */
export function packageCommand(
  manager: HostPackageManager,
  verb: HostPackageVerb,
  packages: readonly string[],
): readonly string[] {
  const command = COMMANDS[manager][verb];
  if (command === undefined) {
    throw new Error(`${manager} has no ${verb}`);
  }
  return command(packages);
}

// One shell running one of the fixed scripts; what follows the script is "$1", "$2" and so on.
const script = (body: string, ...scriptArguments: readonly string[]) =>
  new DbusVariant(DBUS_TYPE.commands, [
    [SHELL_PATH, [SHELL_NAME, SHELL_COMMAND_OPTION, body, HOST_SCRIPT_NAME, ...scriptArguments], false],
  ]);

/**
 * The transient unit for one job: its fixed command with the output going to the job's log, and its
 * result to the job's status file once it ends. The runner reads both from the host's files.
 */
export function packageUnit(
  manager: HostPackageManager,
  verb: HostPackageVerb,
  jobId: string,
  packages: readonly string[],
): UnitProperty[] {
  const { properties } = SYSTEMD;
  return [
    {
      name: properties.description,
      value: new DbusVariant(DBUS_TYPE.string, HOST_PACKAGE_UNIT_DESCRIPTION(verb, jobId)),
    },
    { name: properties.type, value: new DbusVariant(DBUS_TYPE.string, SYSTEMD.oneshot) },
    { name: properties.collectMode, value: new DbusVariant(DBUS_TYPE.string, SYSTEMD.collectMode) },
    { name: properties.environment, value: new DbusVariant(DBUS_TYPE.stringArray, [...HOST_PACKAGE_ENVIRONMENT]) },
    { name: properties.timeout, value: new DbusVariant(DBUS_TYPE.uint64, HOST_PACKAGE_TIMEOUT_MICROSECONDS[verb]) },
    {
      name: properties.execStart,
      value: script(
        HOST_PACKAGE_WRAPPER,
        HOST_PACKAGE_LOG_FILE(jobId, verb),
        ...packageCommand(manager, verb, packages),
      ),
    },
    { name: properties.execStopPost, value: script(HOST_PACKAGE_STATUS_SCRIPT, HOST_PACKAGE_STATUS_FILE(jobId, verb)) },
  ];
}
