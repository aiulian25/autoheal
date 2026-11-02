import { z } from "zod";
import {
  DEFAULT_DRY_RUN,
  DEFAULT_UPDATE_CHECKPOINT_LIMIT_GB,
  HOST_PACKAGES,
  HOST_PACKAGES_SETTINGS,
  REPORT_LIMITS,
} from "./constants.js";

/** What a runner reads from its .env, set on an SSH host's page instead; the defaults are a runner's. */
export const sshHostSettingsSchema = z
  .object({
    dryRun: z.boolean(),
    protectedContainers: z.array(z.string().min(1).max(REPORT_LIMITS.nameCharacters)).max(REPORT_LIMITS.containers),
    containerAccess: z.boolean(),
    hostPackages: z.enum(HOST_PACKAGES_SETTINGS),
    checkpointLimitGigabytes: z.number().int().min(0),
  })
  .strict();
export type SshHostSettings = z.infer<typeof sshHostSettingsSchema>;

export const DEFAULT_SSH_HOST_SETTINGS: SshHostSettings = {
  dryRun: DEFAULT_DRY_RUN,
  protectedContainers: [],
  // As a runner's CONTAINER_ACCESS, which is on unless its .env says off.
  containerAccess: true,
  hostPackages: HOST_PACKAGES.off,
  checkpointLimitGigabytes: DEFAULT_UPDATE_CHECKPOINT_LIMIT_GB,
};
