import { z } from "zod";
import {
  ABSOLUTE_PATH_PREFIX,
  DEFAULT_DRY_RUN,
  DEFAULT_UPDATE_CHECKPOINT_LIMIT_GB,
  HOST_PACKAGES,
  HOST_PACKAGES_SETTINGS,
  REPORT_LIMITS,
  SSH_HOST_FILESYSTEM_LIMITS,
} from "./constants.js";

/** What a runner reads from its .env, set on an SSH host's page instead; the defaults are a runner's. */
export const sshHostSettingsSchema = z
  .object({
    dryRun: z.boolean(),
    protectedContainers: z.array(z.string().min(1).max(REPORT_LIMITS.nameCharacters)).max(REPORT_LIMITS.containers),
    containerAccess: z.boolean(),
    hostTerminal: z.boolean(),
    hostDeploy: z.boolean(),
    hostFilesystems: z
      .array(z.string().startsWith(ABSOLUTE_PATH_PREFIX).max(SSH_HOST_FILESYSTEM_LIMITS.pathCharacters))
      .max(SSH_HOST_FILESYSTEM_LIMITS.paths),
    hostPackages: z.enum(HOST_PACKAGES_SETTINGS),
    checkpointLimitGigabytes: z.number().int().min(0),
  })
  .strict();
export type SshHostSettings = z.infer<typeof sshHostSettingsSchema>;

export const DEFAULT_SSH_HOST_SETTINGS: SshHostSettings = {
  dryRun: DEFAULT_DRY_RUN,
  protectedContainers: [],
  // As a runner's CONTAINER_ACCESS, HOST_TERMINAL and HOST_DEPLOY, each on unless its .env says off.
  containerAccess: true,
  hostTerminal: true,
  hostDeploy: true,
  // As a runner's HOST_FILESYSTEMS unset: every local disk is reported.
  hostFilesystems: [],
  hostPackages: HOST_PACKAGES.off,
  checkpointLimitGigabytes: DEFAULT_UPDATE_CHECKPOINT_LIMIT_GB,
};
