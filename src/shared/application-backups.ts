import { z } from "zod";

/** Conservative bound under the existing 128 MiB, privilege-restricted helper. */
export const APPLICATION_BACKUPS = {
  sourceBytes: 32 * 1024 * 1024,
  payloadBytes: 34 * 1024 * 1024,
  storedBytes: 512 * 1024 * 1024,
  mounts: 16,
  writers: 64,
  plans: 32,
  retained: 8,
  scheduleMinimumHours: 1,
  taskMilliseconds: 15 * 60 * 1000,
  transferMilliseconds: 120000,
  // A writer review stays good for this long: a restore must follow it at once.
  reviewMilliseconds: 60_000,
  format: "autoheal-application-rsync-v1",
} as const;
// An artifact in transit is one tar entry of this name holding an age file, checked once this much of it has arrived.
export const APPLICATION_ARTIFACT = {
  entryName: "payload.age",
  ageHeader: "age-encryption.org/v1\n",
  minimumPayloadBytes: 32,
} as const;
// Application backups run in a helper of Autoheal's own image: a runner's own, or on an SSH host the image the control
// plane runs, found there by its reference once it is loaded or pulled.
export const APPLICATION_HELPER_ERRORS = {
  imageMissing: (reference: string) =>
    `Autoheal's image, ${reference}, is not on this host, and application backups run in it. Load it there once (docker save ${reference} | ssh <user>@<host> docker load), then ask again. Nothing was stopped.`,
  selfMissing: "Runner helper image is unavailable.",
} as const;
export const APPLICATION_ARTIFACT_ERRORS = {
  overQuota: "Application artifact exceeds quota.",
  notSinglePayload: "Application artifact is not a single encrypted payload.",
  extraEntries: "Application artifact contains additional entries.",
  incomplete: "Application artifact is incomplete.",
  notAStream: "Application upload requires an archive stream.",
  uploadTimedOut: "Application backup upload timed out.",
  downloadTimedOut: "Application backup download timed out.",
} as const;
// Starting a backed-up application on its restored copy, only for a plan that asks: fresh volumes, its own image, no
// network, nothing of the live container's settings but its user.
export const APPLICATION_BOOT_DRILL = {
  capability: "application-boot-drills",
  label: "autoheal.application-backup.boot-drill",
  volumeLabel: "autoheal.application-backup.drill",
  containerPrefix: "autoheal-helper-boot-drill-",
  readyMinimumSeconds: 5,
  readyMaximumSeconds: 300,
  environment: 32,
  memoryBytes: 1024 * 1024 * 1024,
  nanoCpus: 1_000_000_000,
  pidsLimit: 256,
  // What a program commonly needs to set up its own files as it starts; never more.
  capabilities: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"],
  timeoutMilliseconds: 5 * 60 * 1000,
  pollMilliseconds: 2000,
  logLines: 40,
  logCharacters: 2000,
  problemCharacters: 500,
  leftListed: 64,
} as const;
export const APPLICATION_BOOT_READINESS = { healthy: "healthy", stayedRunning: "stayed-running" } as const;
export const APPLICATION_BOOT_TEXT = {
  passed: "The application started from its restored copy, isolated. Live data and containers were not touched.",
  notProven:
    "The application stayed up on its restored copy, but it has no health check, so that does not show it works, and Application boot verified was not set. Live data and containers were not touched.",
  failed: (problem: string) =>
    `The application did not start from its restored copy: ${problem}. The backup itself is unchanged. Live data and containers were not touched.`,
  imageGone: "the image it was backed up with is no longer on this host",
  noImage: "this backup did not record its image",
  gone: "the container disappeared",
  stopped: (exitCode: number | undefined) => `it stopped (exit ${exitCode ?? "unknown"})`,
  restarting: "it keeps restarting",
  unhealthy: "it reports unhealthy",
  slow: "it was not ready in time",
} as const;
const identifier = z.string().uuid();
const name = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\0\r\n/]+$/u);
const relativePath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  );
const bootDrillRecipeSchema = z
  .object({
    readySeconds: z
      .number()
      .int()
      .min(APPLICATION_BOOT_DRILL.readyMinimumSeconds)
      .max(APPLICATION_BOOT_DRILL.readyMaximumSeconds),
    // Test values only: the live container's own are never used, and these are kept unsealed.
    environment: z
      .array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), value: z.string().max(1024) }).strict())
      .max(APPLICATION_BOOT_DRILL.environment),
  })
  .strict();
export type BootDrillRecipe = z.infer<typeof bootDrillRecipeSchema>;
export const applicationPlanDefinitionSchema = z
  .object({
    version: z.literal(1),
    name: z.string().trim().min(1).max(100),
    containerName: name,
    consistency: z.literal("coordinated-clean-stop"),
    exclusiveDockerWriters: z.literal(true),
    // Only a fixed, read-only SQLite integrity_check is permitted. No commands or SQL are accepted.
    sqlite: z.object({ mountTarget: z.string().startsWith("/").max(512), path: relativePath }).nullable(),
    intervalHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 365)
      .nullable(),
    retain: z.number().int().min(1).max(APPLICATION_BACKUPS.retained),
    // Absent or null: this plan's application is never started.
    bootDrill: bootDrillRecipeSchema.nullable().optional(),
  })
  .strict();
export type ApplicationPlanDefinition = z.infer<typeof applicationPlanDefinitionSchema>;
export interface ApplicationBackupPlan {
  id: string;
  hostId: string;
  revision: number;
  definition: ApplicationPlanDefinition;
  enabled: boolean;
  nextDueAt: number | null;
}
export const applicationBackupTaskSchema = z
  .object({
    id: identifier,
    attempt: z.number().int().nonnegative().default(0),
    planId: identifier,
    hostId: identifier,
    operation: z.enum(["capture", "drill", "boot-drill", "restore", "preview"]),
    artifactId: identifier,
    definition: applicationPlanDefinitionSchema,
    // The image the backup was made with, for a boot drill.
    imageId: z.string().min(1).max(256).optional(),
    recipient: z.string().min(40).max(128),
    identity: z.string().min(40).max(128).optional(),
    expectedFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    safetyArtifactId: identifier.optional(),
    safetyRecipient: z.string().min(40).max(128).optional(),
    automatic: z.boolean().optional(),
    resume: z.boolean().optional(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type ApplicationBackupTask = z.input<typeof applicationBackupTaskSchema>;
export const applicationBootEvidenceSchema = z
  .object({
    imageId: z.string().max(256).nullable(),
    readySeconds: z.number().int().min(0),
    readiness: z.enum([APPLICATION_BOOT_READINESS.healthy, APPLICATION_BOOT_READINESS.stayedRunning]).nullable(),
    problem: z.string().max(APPLICATION_BOOT_DRILL.problemCharacters).nullable(),
    // Its last lines, masked; only when it failed.
    logs: z.string().max(APPLICATION_BOOT_DRILL.logCharacters).nullable(),
    // What could not be removed afterwards, for a person to remove: empty when all of it went.
    left: z.array(z.string().max(256)).max(APPLICATION_BOOT_DRILL.leftListed),
  })
  .strict();
export type ApplicationBootEvidence = z.infer<typeof applicationBootEvidenceSchema>;
export const applicationBackupResultSchema = z
  .object({
    id: identifier,
    attempt: z.number().int().nonnegative().default(0),
    artifactId: identifier,
    ok: z.boolean(),
    message: z.string().max(2000),
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    payloadBytes: z.number().int().min(0).max(APPLICATION_BACKUPS.payloadBytes).optional(),
    payloadSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    writers: z.array(name).max(APPLICATION_BACKUPS.writers),
    stopped: z.array(name).max(APPLICATION_BACKUPS.writers),
    recoveryRequired: z.boolean().optional(),
    restored: z.boolean().optional(),
    integrity: z.enum(["metadata-verified", "sqlite-integrity-ok"]).optional(),
    imageId: z.string().min(1).max(256).optional(),
    boot: applicationBootEvidenceSchema.optional(),
  })
  .strict();
export type ApplicationBackupResult = z.input<typeof applicationBackupResultSchema>;
// A run that ended either way; the others may still act on the host.
export const FINISHED_APPLICATION_BACKUP_RUN_STATUSES = [
  "succeeded",
  "failed",
] as const satisfies readonly ApplicationBackupRun["status"][];
// Clean-up marks an artifact this way once its files and key are gone.
export const SPENT_APPLICATION_BACKUP_ARTIFACT_STATUS = "failed" satisfies ApplicationBackupArtifact["status"];
// Why the dashboard ended a run itself, where no report from its runner says why.
export const APPLICATION_BACKUP_FAILURE = {
  requesterLostAccess: "requester_lost_access",
  planChanged: "plan_changed",
  expired: "expired",
  notPrepared: "not_prepared",
  databaseRestored: "database_restored",
} as const;
export type ApplicationBackupFailure = (typeof APPLICATION_BACKUP_FAILURE)[keyof typeof APPLICATION_BACKUP_FAILURE];
export interface ApplicationBackupRun {
  id: string;
  planId: string;
  hostId: string;
  operation: "capture" | "drill" | "boot-drill" | "restore" | "preview";
  status: "queued" | "running" | "succeeded" | "failed" | "recovery-required";
  artifactId: string;
  createdAt: number;
  finishedAt: number | null;
  result: ApplicationBackupResult | null;
  failure: ApplicationBackupFailure | null;
}
export interface ApplicationBackupArtifact {
  id: string;
  planId: string;
  hostId: string;
  status: "pending" | "ready" | "failed";
  createdAt: number;
  payloadBytes: number | null;
  verifiedAt: number | null;
  lastDrillAt: number | null;
  // Separate from the integrity drill's: this one started the application itself.
  bootVerifiedAt: number | null;
  imageId: string | null;
  retained: boolean;
}
export interface ApplicationBackupsView {
  plans: ApplicationBackupPlan[];
  runs: ApplicationBackupRun[];
  artifacts: ApplicationBackupArtifact[];
  available: boolean;
  sourceBytes: number;
  payloadBytes: number;
}
