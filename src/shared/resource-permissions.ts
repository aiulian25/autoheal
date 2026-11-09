import { z } from "zod";
import { JOB_ACTION, REPORT_LIMITS } from "./constants.js";

export const RESOURCE_ACTIONS = ["read", "lifecycle", "update", "logs", "terminal", "files", "settings"] as const;
export type ResourceAction = (typeof RESOURCE_ACTIONS)[number];
export const resourceGrantSchema = z
  .object({
    hostId: z.uuid(),
    scope: z.enum(["host", "container", "stack"]),
    resource: z.string().min(1).max(REPORT_LIMITS.nameCharacters).nullable(),
    actions: z
      .array(z.enum(RESOURCE_ACTIONS))
      .min(1)
      .max(RESOURCE_ACTIONS.length)
      .refine((actions) => new Set(actions).size === actions.length),
  })
  .strict()
  .refine(({ scope, resource }) => (scope === "host" ? resource === null : resource !== null));
// How many grants one person may hold.
export const RESOURCE_GRANTS_LIMIT = 64;
export const resourceGrantsSchema = z
  .array(resourceGrantSchema)
  .max(RESOURCE_GRANTS_LIMIT)
  .refine(
    (grants) =>
      new Set(grants.map(({ hostId, scope, resource }) => JSON.stringify([hostId, scope, resource]))).size ===
      grants.length,
  );
export type ResourceGrant = z.infer<typeof resourceGrantSchema>;
export interface ResourcePermissionsView {
  revision: number;
  grants: ResourceGrant[];
}
export interface ResourceTarget {
  hostId: string;
  name: string;
  composeProject: string | null;
}
export const resourceMemberSchema = z
  .object({
    name: z.string().min(1).max(REPORT_LIMITS.nameCharacters),
    composeProject: z.string().min(1).max(REPORT_LIMITS.nameCharacters).nullable(),
  })
  .strict();
export const resourceAuthorizationSchema = z
  .object({ members: z.array(resourceMemberSchema).min(1).max(REPORT_LIMITS.containers) })
  .strict();

/** No role inference or wildcard matching: one explicit matching grant must carry the action. */
export function resourceAllowed(
  grants: readonly ResourceGrant[],
  action: ResourceAction,
  target: ResourceTarget,
): boolean {
  return grants.some(
    (grant) =>
      grant.hostId === target.hostId &&
      grant.actions.includes(action) &&
      (grant.scope === "host" ||
        (grant.scope === "container" && grant.resource === target.name) ||
        (grant.scope === "stack" && target.composeProject !== null && grant.resource === target.composeProject)),
  );
}
/** Host OS/package, image pruning and global policy operations stay administrative. */
export function actionPermission(action: string): ResourceAction | null {
  switch (action) {
    case JOB_ACTION.logs:
      return "logs";
    case JOB_ACTION.checkUpdates:
      return "read";
    case JOB_ACTION.update:
    case JOB_ACTION.rollBack:
      return "update";
    case JOB_ACTION.edit:
      return "settings";
    case JOB_ACTION.start:
    case JOB_ACTION.stop:
    case JOB_ACTION.restart:
    case JOB_ACTION.pause:
    case JOB_ACTION.unpause:
    case JOB_ACTION.remove:
    case JOB_ACTION.recreate:
      return "lifecycle";
    default:
      return null;
  }
}
