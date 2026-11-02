import { ConfigError } from "./config/environment-schema.js";
import {
  COMMAND_BACKUP_PASSPHRASE,
  COMMAND_CHECK_CONFIG,
  COMMAND_HEALTHCHECK,
  COMMAND_BACKUP_COPY,
  COMMAND_HOST_HELPER,
  COMMAND_MIGRATE,
  COMMAND_RESET_ADMIN,
  COMMAND_RESTORE,
  COMMAND_SELF_TEST,
  COMMAND_SELF_UPDATE,
  COMMAND_VOLUME_COPY,
  COMMAND_APPLICATION_COPY,
  EXIT_FAILURE,
  EXIT_USAGE,
  MODE_RUNNER,
  MODE_CONTROL_PLANE,
  USAGE,
} from "./shared/constants.js";

type Command = (commandArguments: string[]) => Promise<number>;

// Loaded on demand: Docker runs the healthcheck every 30 seconds and it should stay light.
const commands: Record<string, () => Promise<Command>> = {
  [MODE_CONTROL_PLANE]: async () => (await import("./control-plane/application.js")).runControlPlane,
  [MODE_RUNNER]: async () => (await import("./runner/application.js")).runRunner,
  [COMMAND_CHECK_CONFIG]: async () => (await import("./commands/check-config.js")).runCheckConfig,
  [COMMAND_HEALTHCHECK]: async () => (await import("./commands/healthcheck.js")).runHealthcheck,
  [COMMAND_SELF_TEST]: async () => (await import("./commands/self-test.js")).runSelfTest,
  [COMMAND_MIGRATE]: async () => (await import("./commands/migrate.js")).runMigrate,
  [COMMAND_RESET_ADMIN]: async () => (await import("./commands/reset-admin.js")).runResetAdmin,
  [COMMAND_RESTORE]: async () => (await import("./commands/restore.js")).runRestore,
  [COMMAND_BACKUP_PASSPHRASE]: async () => (await import("./commands/backup-passphrase.js")).runBackupPassphrase,
  [COMMAND_HOST_HELPER]: async () => (await import("./commands/host-helper.js")).runHostHelper,
  [COMMAND_BACKUP_COPY]: async () => (await import("./commands/backup-copy.js")).runBackupCopy,
  [COMMAND_APPLICATION_COPY]: async () => (await import("./commands/application-copy.js")).runApplicationCopy,
  [COMMAND_VOLUME_COPY]: async () => (await import("./commands/volume-copy.js")).runVolumeCopy,
  [COMMAND_SELF_UPDATE]: async () => (await import("./commands/self-update.js")).runSelfUpdate,
};

async function run(commandName: string, commandArguments: string[]): Promise<number> {
  const loadCommand = commands[commandName];
  if (loadCommand === undefined) {
    console.error(USAGE);
    return EXIT_USAGE;
  }
  try {
    const command = await loadCommand();
    return await command(commandArguments);
  } catch (error) {
    if (!(error instanceof ConfigError)) {
      throw error;
    }
    console.error(error.message);
    return EXIT_FAILURE;
  }
}

const [commandName = "", ...commandArguments] = process.argv.slice(2);
const exitCode = await run(commandName, commandArguments);
// Daemons have drained or retained recovery records. Do not let abandoned sockets or host-unit followers prolong exit.
if (commandName === MODE_RUNNER || commandName === MODE_CONTROL_PLANE) process.exit(exitCode);
process.exitCode = exitCode;
