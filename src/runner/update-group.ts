import { z } from "zod";
import type { ContainerDetails } from "./incident-report.js";

export const UPDATE_GROUP_LABEL = "autoheal.update.group";
const member = z.object({ name: z.string().min(1), id: z.string().min(1), running: z.boolean() });
const schema = z.object({ version: z.literal(1), provider: member, dependents: z.array(member).min(1) });
export type UpdateGroup = z.infer<typeof schema>;

/** Kept on the replacement, so a failed group is recoverable after the runner restarts. */
export function updateGroupOf(container: ContainerDetails | null): UpdateGroup | null {
  const text = container?.Config.Labels?.[UPDATE_GROUP_LABEL];
  if (text === undefined) return null;
  const group = schema.parse(JSON.parse(text));
  const members = [group.provider, ...group.dependents];
  if (
    new Set(members.map(({ id }) => id)).size !== members.length ||
    new Set(members.map(({ name }) => name)).size !== members.length
  ) {
    throw new Error("The retained update group has duplicate members; manual recovery is required.");
  }
  return group;
}
