import { z } from "zod";
import { JOB_ACTION, REPORT_LIMITS } from "./constants.js";
export const TOPOLOGY_LIMITS = {
  bytes: 128 * 1024,
  edges: 4096,
  comparisons: 100_000,
  mountSources: 64,
  previews: 64,
  previewTtl: 60_000,
  declaredPerContainer: 16,
  relayPending: 32,
} as const;
export const DECLARED_DEPENDENCIES_LABEL = "autoheal.depends-on";
// What two containers share their data through: a volume by its name, a host folder by a fingerprint of its path,
// which never leaves the host itself.
export const SHARED_VIA = { volume: "volume:", folder: "folder:", fingerprintCharacters: 8 } as const;
export const TOPOLOGY_EDGE_KINDS = [
  "network_namespace",
  "compose_association",
  "shared_writable_data",
  "declared_dependency",
] as const;
const name = z.string().min(1).max(REPORT_LIMITS.nameCharacters);
export const topologySnapshotSchema = z
  .object({
    capturedAt: z.number().int().nonnegative(),
    nodes: z
      .array(z.object({ name, containerId: z.string().min(1).max(128), composeProject: name.nullable() }))
      .max(REPORT_LIMITS.containers),
    edges: z
      .array(
        z.object({
          from: name,
          to: name,
          kind: z.enum(TOPOLOGY_EDGE_KINDS),
          source: z.enum(["docker", "operator_label"]),
          // Shared writable data only: what it is shared through; absent from runners before it.
          via: z
            .string()
            .max(REPORT_LIMITS.nameCharacters + SHARED_VIA.volume.length)
            .optional(),
        }),
      )
      .max(TOPOLOGY_LIMITS.edges),
    truncated: z.boolean(),
    notes: z
      .array(
        z.enum([
          "container_limit",
          "edge_limit",
          "comparison_limit",
          "mount_limit",
          "unresolved_reference",
          "byte_limit",
        ]),
      )
      .max(6),
  })
  .strict()
  .refine((snapshot) => new TextEncoder().encode(JSON.stringify(snapshot)).byteLength <= TOPOLOGY_LIMITS.bytes);
export type TopologySnapshot = z.infer<typeof topologySnapshotSchema>;
export interface TopologyView {
  hostId: string;
  available: boolean;
  stale: boolean;
  revision: string;
  snapshot: TopologySnapshot | null;
}
export const OPERATION_PREVIEW_ACTIONS = [
  JOB_ACTION.update,
  JOB_ACTION.rollBack,
  JOB_ACTION.restart,
  JOB_ACTION.start,
  JOB_ACTION.stop,
  JOB_ACTION.pause,
  JOB_ACTION.unpause,
  JOB_ACTION.remove,
  JOB_ACTION.recreate,
] as const;
export type PreviewAction = (typeof OPERATION_PREVIEW_ACTIONS)[number];
export const previewActionSchema = z.enum(OPERATION_PREVIEW_ACTIONS);
export const operationPreviewRequestSchema = z
  .object({ id: z.uuid(), containerName: name, action: previewActionSchema })
  .strict();
export type OperationPreviewRequest = z.infer<typeof operationPreviewRequestSchema>;
export const operationPreviewAnswerSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(false), reason: z.string().max(2000) }).strict(),
  z
    .object({
      ok: z.literal(true),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      members: z.array(z.object({ name, protected: z.boolean() })).max(REPORT_LIMITS.containers),
      resources: z.array(z.string().regex(/^resource-[a-f0-9]{16}$/)).max(REPORT_LIMITS.containers * 4),
      refusals: z.array(z.string().max(2000)).max(20),
      rolloutSafety: z
        .object({
          writableData: z.enum(["none", "present", "unknown"]),
          sourceContainerId: z.string().min(1).max(128).optional(),
          platform: z
            .string()
            .regex(/^[a-z0-9]+\/[a-z0-9_]+$/)
            .nullable(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);
export type OperationPreviewAnswer = z.infer<typeof operationPreviewAnswerSchema>;
export interface OperationImpactView {
  id: string;
  expiresAt: number;
  hostId: string;
  containerName: string;
  action: PreviewAction;
  answer: OperationPreviewAnswer;
}
