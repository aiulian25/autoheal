import { z } from "zod";
import { AVAILABILITY_GROUPS, AVAILABILITY_TEXT } from "./constants.js";

/**
 * One replica of an application: the container, the host it runs on, the failure domain it shares with others that
 * would go down together, and the service check that shows it is actually serving.
 *
 * This is an operational guard, not a proof of consensus: it counts what Autoheal can see and refuses to take the
 * last of something down. It knows nothing of what a cluster inside those containers believes about itself.
 */
export interface GroupMember {
  hostId: string;
  containerName: string;
  /** What this replica shares its fate with: a rack, a site, a machine. Null makes it its own domain. */
  failureDomain: string | null;
  /** The check that shows it is serving; null leaves its container's own state as the evidence. */
  probeId: string | null;
}

export interface AvailabilityGroupBody {
  name: string;
  /** How many failure domains must stay available, whatever anyone asks to do. */
  minimumAvailable: number;
  /** How old the evidence about a replica may be and still count: older is not known, which is never available. */
  evidenceFreshSeconds: number;
  members: GroupMember[];
}

/** Whether a replica is serving, as far as the fleet can tell right now. */
export const MEMBER_EVIDENCE = { available: "available", unavailable: "unavailable", unknown: "unknown" } as const;
export type MemberEvidence = (typeof MEMBER_EVIDENCE)[keyof typeof MEMBER_EVIDENCE];

export interface MemberStanding extends GroupMember {
  evidence: MemberEvidence;
  /** Why it is not available or not known; null when it is available. */
  problem: string | null;
  /** Whether an operation already under way, or the one being asked about, takes this replica down. */
  goingDown: boolean;
}

export interface AvailabilityGroupView extends AvailabilityGroupBody {
  id: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** What the group's membership was when it was last read: a changed one is a changed review. */
  revision: string;
  standings: MemberStanding[];
  /** Domains available now, and those that would remain after what is already being done. */
  availableDomains: number;
  remainingDomains: number;
}

const name = z.string().trim().min(1).max(AVAILABILITY_GROUPS.nameLength);
const memberSchema = z
  .object({
    hostId: z.uuid(),
    containerName: z.string().trim().min(1).max(AVAILABILITY_GROUPS.containerNameLength),
    failureDomain: z.string().trim().max(AVAILABILITY_GROUPS.domainLength).nullable().default(null),
    probeId: z.uuid().nullable().default(null),
  })
  .strict();

export const availabilityGroupBodySchema = z
  .object({
    name,
    minimumAvailable: z.number().int().min(1).max(AVAILABILITY_GROUPS.minimumAvailableLimit),
    evidenceFreshSeconds: z
      .number()
      .int()
      .min(AVAILABILITY_GROUPS.freshSeconds.minimum)
      .max(AVAILABILITY_GROUPS.freshSeconds.maximum),
    // Nesting is not accepted at all: a group holds replicas, never other groups, so there are no cycles to find.
    members: z.array(memberSchema).min(1).max(AVAILABILITY_GROUPS.membersLimit),
  })
  .strict()
  .refine(
    ({ members }) =>
      new Set(members.map(({ hostId, containerName }) => `${hostId}/${containerName}`)).size === members.length,
  )
  // A minimum no membership could ever meet would refuse every operation for ever.
  .refine(({ members, minimumAvailable }) => minimumAvailable <= domainsOf(members).size);

/** The domains a membership holds: a replica with no domain of its own stands alone. */
export function domainsOf(members: readonly GroupMember[]): Set<string> {
  return new Set(members.map((member) => member.failureDomain ?? `${member.hostId}/${member.containerName}`));
}

const domainOf = (member: GroupMember) => member.failureDomain ?? `${member.hostId}/${member.containerName}`;

/** The domains with at least one replica available: a domain counts once, however many replicas it holds. */
function domainsAvailable(standings: readonly MemberStanding[], countingWhatGoesDown: boolean): Set<string> {
  const available = new Set<string>();
  for (const standing of standings) {
    const counts = standing.evidence === MEMBER_EVIDENCE.available && (countingWhatGoesDown || !standing.goingDown);
    if (counts) available.add(domainOf(standing));
  }
  return available;
}

/**
 * Why an operation may not go ahead: it would leave fewer domains serving than the group asks for. Null when enough
 * would remain. What is already being done counts as down, so two operations that are each safe on their own cannot
 * jointly take the last replica; evidence that is missing or stale is never counted as available.
 */
export function availabilityProblem(group: {
  name: string;
  minimumAvailable: number;
  standings: readonly MemberStanding[];
}): string | null {
  const remaining = domainsAvailable(group.standings, false).size;
  if (remaining >= group.minimumAvailable) return null;
  const unknown = group.standings.filter((standing) => standing.evidence === MEMBER_EVIDENCE.unknown);
  const said = AVAILABILITY_TEXT.wouldLeave(group.name, remaining, group.minimumAvailable);
  return unknown.length === 0 ? said : `${said} ${AVAILABILITY_TEXT.nothingShows(unknown.length)}`;
}
