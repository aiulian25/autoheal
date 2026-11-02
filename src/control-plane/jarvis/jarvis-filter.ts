import { DETECTOR_KEYS, DETECTOR_KEY_SEPARATOR, TASK_PRIORITIES, type TaskPriority } from "../../shared/constants.js";
import { sha256Hex } from "../../shared/hash.js";
import { JARVIS_KIND, JARVIS_LIMITS, JARVIS_TIER, type JarvisMessage, type JarvisTier } from "../../shared/jarvis.js";

export interface JarvisCandidate {
  taskId: string;
  detectorKey: string;
  priority: TaskPriority;
  hostId: string;
  hostLabel: string;
  // The container or the disk it is about.
  resource: string | null;
  createdAt: number;
}

export interface JarvisSaid {
  groupKey: string;
  fingerprint: string;
  tier: JarvisTier;
  at: number;
  // Whether it uses up the day's allowance: what never reached anyone does not.
  counted: boolean;
}

export interface JarvisPlanned {
  groupKey: string;
  fingerprint: string;
  kind: JarvisMessage["kind"];
  tier: JarvisTier;
  hostId: string;
  hostLabel: string;
  names: string[];
  taskIds: string[];
}

// Only these are told. Everything else is left out on purpose: anomalies and temperatures come and go, and Jarvis
// knows its own house, so Home Assistant, Zigbee, safety and watched things would only be told back to it.
const TOLD: Partial<Record<string, JarvisMessage["kind"]>> = {
  [DETECTOR_KEYS.hostSilent]: JARVIS_KIND.hostSilent,
  [DETECTOR_KEYS.disk]: JARVIS_KIND.disk,
  [DETECTOR_KEYS.drive]: JARVIS_KIND.drive,
  [DETECTOR_KEYS.container]: JARVIS_KIND.container,
  [DETECTOR_KEYS.oomLoop]: JARVIS_KIND.container,
  [DETECTOR_KEYS.recoveryHeld]: JARVIS_KIND.recoveryHeld,
  [DETECTOR_KEYS.update]: JARVIS_KIND.containerUpdates,
  [DETECTOR_KEYS.osUpdates]: JARVIS_KIND.hostUpdates,
  [DETECTOR_KEYS.reboot]: JARVIS_KIND.reboot,
};

const GROUPED_BY_HOST = new Set<JarvisMessage["kind"]>([JARVIS_KIND.containerUpdates]);

// The owner's rule: a container only there to build things is noise, by its name or its image. Buildx starts them for
// a build and leaves them stopped. Home Assistant's automation drops the same names.
const ABOUT_BUILDING = /build/i;
export const isBuildContainer = (name: string, image: string | null) =>
  ABOUT_BUILDING.test(name) || (image !== null && ABOUT_BUILDING.test(image));

export const kindOf = (detectorKey: string) => TOLD[detectorKey.split(DETECTOR_KEY_SEPARATOR, 1)[0]!];
const tierOf = (kind: JarvisMessage["kind"], priority: TaskPriority): JarvisTier =>
  kind === JARVIS_KIND.hostSilent || priority === "urgent" ? JARVIS_TIER.urgent : JARVIS_TIER.say;
const settleOf = (tier: JarvisTier) =>
  tier === JARVIS_TIER.urgent ? JARVIS_LIMITS.urgentSettleMilliseconds : JARVIS_LIMITS.settleMilliseconds;
const repeatOf = (tier: JarvisTier) =>
  tier === JARVIS_TIER.urgent ? JARVIS_LIMITS.urgentRepeatMilliseconds : JARVIS_LIMITS.repeatMilliseconds;
const rank = (planned: JarvisPlanned, priorityOf: Map<string, TaskPriority>) =>
  TASK_PRIORITIES.indexOf(priorityOf.get(planned.taskIds[0]!) ?? "low");

/**
 * What is worth saying now, from what is open and what was said. Waiting means whatever fixes itself is never told;
 * grouping makes three updates one sentence; the same thing is not told twice; and only so much is said in a day,
 * the most important first. The urgent always go, and do not count.
 */
export function planJarvis(
  candidates: readonly JarvisCandidate[],
  said: readonly JarvisSaid[],
  now: number,
): JarvisPlanned[] {
  const groups = new Map<string, JarvisPlanned>();
  const priorityOf = new Map<string, TaskPriority>();
  for (const candidate of candidates) {
    const kind = kindOf(candidate.detectorKey);
    if (kind === undefined) continue;
    const tier = tierOf(kind, candidate.priority);
    if (now - candidate.createdAt < settleOf(tier)) continue;
    const groupKey = GROUPED_BY_HOST.has(kind) ? `${kind}:${candidate.hostId}` : candidate.detectorKey;
    const group = groups.get(groupKey) ?? {
      groupKey,
      fingerprint: "",
      kind,
      tier,
      hostId: candidate.hostId,
      hostLabel: candidate.hostLabel,
      names: [],
      taskIds: [],
    };
    if (candidate.resource !== null && !group.names.includes(candidate.resource)) group.names.push(candidate.resource);
    group.taskIds.push(candidate.taskId);
    priorityOf.set(candidate.taskId, candidate.priority);
    groups.set(groupKey, group);
  }
  const fresh = [...groups.values()]
    .map((group) => ({
      ...group,
      names: group.names.sort(),
      fingerprint: sha256Hex(`${group.groupKey}|${[...group.taskIds].sort().join(",")}`),
    }))
    .filter((group) => {
      const before = said.filter(({ groupKey }) => groupKey === group.groupKey);
      const repeated = before.some(({ fingerprint }) => fingerprint === group.fingerprint);
      const recent = before.some(({ at }) => now - at < repeatOf(group.tier));
      return !repeated && !recent;
    })
    .sort((left, right) => rank(left, priorityOf) - rank(right, priorityOf));
  const urgent = fresh.filter(({ tier }) => tier === JARVIS_TIER.urgent);
  const usedToday = said.filter(
    ({ tier, at, counted }) => counted && tier === JARVIS_TIER.say && now - at < JARVIS_LIMITS.dayMilliseconds,
  ).length;
  const room = Math.max(0, JARVIS_LIMITS.perDay - usedToday);
  return [...urgent, ...fresh.filter(({ tier }) => tier === JARVIS_TIER.say).slice(0, room)];
}
