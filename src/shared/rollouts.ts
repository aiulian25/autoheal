import { z } from "zod";
import { imageRepository } from "./image-reference.js";
export const ROLLOUT_ROUTES = {
  rollouts: "/api/rollouts",
  rolloutPromote: "/api/rollouts/:rolloutId/promote",
  rolloutHold: "/api/rollouts/:rolloutId/hold",
} as const;
export const ROLLOUT_LIMITS = {
  targets: 12,
  hosts: 8,
  retained: 64,
  retention: 30 * 86400_000,
  // How long each cohort is watched before it can be promoted, in minutes.
  observeMinutes: { min: 1, max: 60 },
} as const;
// Why a rollout stands where it does, shown with it.
export const ROLLOUT_REASONS = {
  awaitingReport: "Waiting for a fresh inventory report after the update.",
  updateFailed: "The update failed.",
  firstUpdateNotQueued: "The first update could not be queued; review a new plan.",
  heldByAdministrator:
    "Held by an administrator. An admitted host operation may finish; later targets will not start. Create a new reviewed plan to continue.",
  completed: "All cohorts observed and explicitly accepted.",
  requesterUnauthorized: "The requesting administrator is no longer authorized.",
  earlierCohortStale: "An earlier cohort no longer has fresh host observations.",
  earlierCohortChanged: "An earlier cohort changed, restarted, or became unhealthy. Later promotion is blocked.",
  jobUnavailable: "The recorded update job is unavailable.",
  updateIncomplete: "The update did not complete.",
  observationUnavailable: "The host observation is unavailable or stale.",
  noFreshReport: "No fresh post-update report arrived.",
  memberMismatch: "A required member is absent, unhealthy, or differs from the reviewed replacement.",
  replacementChanged: "The replacement changed or restarted during observation.",
  clockMovedBackwards: "The observation clock moved backwards.",
  observationPassed: "Observation passed. Explicit service verification and promotion are required.",
  insufficientReports: "Insufficient distinct fresh reports during the observation window.",
  unreadable:
    "This rollout's saved state could not be read, so nothing more happens to it here. It is kept as it was; create a new reviewed plan to continue.",
} as const;
export const ROLLOUT_MESSAGES = {
  unreadable: (id: string, problem: string) =>
    `rollout ${id}: its saved state could not be read (${problem}); it is shown as inconclusive and left as it is`,
} as const;
export const digestReferenceSchema = z
  .string()
  .max(512)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/);
export function canonicalRepository(reference: string): string {
  let repository = imageRepository(reference).toLowerCase();
  repository = repository.replace(/^(?:index\.docker\.io|registry-1\.docker\.io)\//, "docker.io/");
  const first = repository.split("/")[0]!;
  if (!first.includes(".") && !first.includes(":") && first !== "localhost") repository = `docker.io/${repository}`;
  if (repository.startsWith("docker.io/") && repository.split("/").length === 2)
    repository = repository.replace("docker.io/", "docker.io/library/");
  return repository;
}
export const rolloutJobSchema = z
  .object({
    id: z.uuid(),
    targetReference: digestReferenceSchema,
    expectedSourceContainerId: z.string().min(1).max(128),
    expectedPlatform: z.string().regex(/^[a-z0-9]+\/[a-z0-9_]+$/),
    requireStateless: z.literal(true),
  })
  .strict();
export type RolloutJob = z.infer<typeof rolloutJobSchema>;
export const rolloutCreateSchema = z
  .object({
    targets: z
      .array(
        z
          .object({
            hostId: z.uuid(),
            containerName: z.string().min(1).max(255),
            previewId: z.uuid(),
            targetReference: digestReferenceSchema,
          })
          .strict(),
      )
      .min(2)
      .max(ROLLOUT_LIMITS.targets),
    observeMinutes: z.number().int().min(ROLLOUT_LIMITS.observeMinutes.min).max(ROLLOUT_LIMITS.observeMinutes.max),
    externalDataIsolated: z.literal(true),
    serviceVerificationRequired: z.boolean(),
  })
  .strict()
  .refine((value) => new Set(value.targets.map((t) => `${t.hostId}/${t.containerName}`)).size === value.targets.length);
export type RolloutCreate = z.infer<typeof rolloutCreateSchema>;
export const ROLLOUT_STATUS = {
  updating: "updating",
  observing: "observing",
  ready: "ready",
  held: "held",
  failed: "failed",
  inconclusive: "inconclusive",
  completed: "completed",
} as const;
export const ROLLOUT_STATUSES = [
  ROLLOUT_STATUS.updating,
  ROLLOUT_STATUS.observing,
  ROLLOUT_STATUS.ready,
  ROLLOUT_STATUS.held,
  ROLLOUT_STATUS.failed,
  ROLLOUT_STATUS.inconclusive,
  ROLLOUT_STATUS.completed,
] as const;
export type RolloutStatus = (typeof ROLLOUT_STATUSES)[number];
const timestamp = z.number().int().nonnegative();
const count = z.number().int().nonnegative();
export const rolloutTargetSchema = z
  .object({
    hostId: z.string(),
    containerName: z.string(),
    targetReference: z.string(),
    sourceContainerId: z.string(),
    platform: z.string(),
    fingerprint: z.string(),
    members: z.array(z.string()),
    jobId: z.string().nullable(),
    replacementId: z.string().nullable(),
    baselineRestarts: count.nullable(),
  })
  .strict();
export type RolloutTarget = z.infer<typeof rolloutTargetSchema>;
// A rollout as stored and shown. Its saved state is read through this: one with fields this version doesn't know,
// or a current cohort past its targets, is not one it may act on.
export const rolloutViewSchema = z
  .object({
    id: z.string(),
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: z.string(),
    status: z.enum(ROLLOUT_STATUSES),
    targets: z.array(rolloutTargetSchema),
    current: count,
    observeMilliseconds: count,
    observeStartedAt: timestamp.nullable(),
    lastSampleAt: timestamp.nullable(),
    samples: count,
    serviceVerificationRequired: z.boolean(),
    externalDataIsolated: z.literal(true),
    reason: z.string().nullable(),
    rollbackReadiness: z.literal("startup_only_then_manual"),
  })
  .strict()
  .refine((plan) => plan.current < plan.targets.length);
export type RolloutView = z.infer<typeof rolloutViewSchema>;
