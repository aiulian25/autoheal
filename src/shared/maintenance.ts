import { z } from "zod";

export const MAINTENANCE_MAX_MILLISECONDS = 24 * 60 * 60 * 1000;
export const MAINTENANCE_FRESH_MILLISECONDS = 120_000;
// How far a runner's clock may be from the control plane's, or move while it holds a policy, for that policy to count.
export const MAINTENANCE_CLOCK_TOLERANCE_MILLISECONDS = 60_000;
// Windows open at once per host and in all, and the longest container name and reason a window takes.
export const MAINTENANCE_LIMITS = {
  windowsPerHost: 128,
  windows: 4096,
  containerNameCharacters: 256,
  reasonCharacters: 240,
} as const;
const timestamp = z.number().int().nonnegative().safe();
export const maintenanceWindowSchema = z
  .object({
    containerName: z.string().min(1).max(MAINTENANCE_LIMITS.containerNameCharacters).nullable(),
    startsAt: timestamp,
    expiresAt: timestamp,
  })
  .refine(({ startsAt, expiresAt }) => expiresAt > startsAt && expiresAt - startsAt <= MAINTENANCE_MAX_MILLISECONDS);
export const maintenancePolicySchema = z.object({
  generation: z.number().int().nonnegative().safe(),
  observedAt: timestamp,
  windows: z.array(maintenanceWindowSchema).max(128),
});
export type MaintenancePolicy = z.infer<typeof maintenancePolicySchema>;
export interface MaintenanceWindow {
  id: string;
  hostId: string;
  containerName: string | null;
  owner: string;
  reason: string;
  startsAt: number;
  expiresAt: number;
}
export interface MaintenanceView {
  acknowledged: Record<string, { generation: number | null; at: number | null }>;
  generation: number;
  windows: MaintenanceWindow[];
}
