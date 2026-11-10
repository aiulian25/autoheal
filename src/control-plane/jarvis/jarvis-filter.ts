import { DETECTOR_KEYS, DETECTOR_KEY_SEPARATOR, TASK_PRIORITIES, type TaskPriority } from "../../shared/constants.js";
import { sha256Hex } from "../../shared/hash.js";
import {
  JARVIS_KIND,
  JARVIS_LIMITS,
  JARVIS_STATUS,
  JARVIS_TIER,
  type JarvisMessage,
  type JarvisStatus,
  type JarvisTier,
} from "../../shared/jarvis.js";

export interface JarvisCandidate {
  taskId: string;
  detectorKey: string;
  priority: TaskPriority;
  hostId: string;
  hostLabel: string;
  // The container or the disk it is about.
  resource: string | null;
  createdAt: number;
  // What a yes would bring, for what is asked rather than told: an update's newer image, or a newer version's tag.
  // Asked when a yes would be taken (askable), and only while it could be carried out at once (ready).
  ask?: { brings: string; askable: boolean; ready: boolean };
}

export interface JarvisSaid {
  groupKey: string;
  fingerprint: string;
  tier: JarvisTier;
  at: number;
  // Whether it uses up the day's allowance: what never reached anyone does not.
  counted: boolean;
}

/** A question on its row, as far as choosing the next one needs. */
export interface JarvisQuestion {
  id: string;
  groupKey: string;
  // Each update it asks about, as `taskId@digest`: a yes covers exactly these.
  members: readonly string[];
  status: JarvisStatus;
  sentAt: number | null;
  // Heard, not answered, and its wait to be asked again is over.
  due: boolean;
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
  // A question only: the updates it asks about, and the row it is asked on again when it is not new.
  members?: string[];
  again?: string;
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
  [DETECTOR_KEYS.newerVersion]: JARVIS_KIND.newerVersion,
  [DETECTOR_KEYS.osUpdates]: JARVIS_KIND.hostUpdates,
  [DETECTOR_KEYS.reboot]: JARVIS_KIND.reboot,
};

const GROUPED_BY_HOST = new Set<JarvisMessage["kind"]>([JARVIS_KIND.containerUpdates]);
// Never told: a newer version a yes could not move to is on the dashboard already.
const ONLY_ASKED = new Set<JarvisMessage["kind"]>([JARVIS_KIND.newerVersion]);

// Out now, or out before: none of its updates is asked about again, nor told, until a newer image changes it.
const ASKED_BEFORE: readonly JarvisStatus[] = [
  JARVIS_STATUS.waiting,
  JARVIS_STATUS.sent,
  JARVIS_STATUS.asked,
  JARVIS_STATUS.accepted,
  JARVIS_STATUS.declined,
  JARVIS_STATUS.done,
  JARVIS_STATUS.retired,
];
const STILL_OPEN: readonly JarvisStatus[] = [JARVIS_STATUS.waiting, JARVIS_STATUS.sent, JARVIS_STATUS.asked];
// What uses up the day's allowance: the urgent always go, and a reply answers a person, so neither counts.
const COUNTED: readonly JarvisTier[] = [JARVIS_TIER.say, JARVIS_TIER.ask];

// The owner's rule: a container only there to build things is noise, by its name or its image. Buildx starts them for
// a build and leaves them stopped. Home Assistant's automation drops the same names.
const ABOUT_BUILDING = /build/i;
export const isBuildContainer = (name: string, image: string | null) =>
  ABOUT_BUILDING.test(name) || (image !== null && ABOUT_BUILDING.test(image));

export const kindOf = (detectorKey: string) => TOLD[detectorKey.split(DETECTOR_KEY_SEPARATOR, 1)[0]!];
const MEMBER_SEPARATOR = "@";
export const memberKey = (taskId: string, digest: string) => `${taskId}${MEMBER_SEPARATOR}${digest}`;
export function memberOf(key: string) {
  const [taskId, brings] = key.split(MEMBER_SEPARATOR);
  return { taskId: taskId!, brings: brings! };
}
const keyOf = ({ taskId, ask }: JarvisCandidate) => (ask === undefined ? null : memberKey(taskId, ask.brings));

// A host's updates are asked about together; each newer version on its own.
function questionGroup(candidate: Pick<JarvisCandidate, "detectorKey" | "hostId" | "resource">) {
  const kind = kindOf(candidate.detectorKey);
  const about = kind === JARVIS_KIND.newerVersion ? `${candidate.hostId}:${candidate.resource}` : candidate.hostId;
  return `${JARVIS_TIER.ask}:${kind}:${about}`;
}

const tierOf = (kind: JarvisMessage["kind"], priority: TaskPriority): JarvisTier =>
  kind === JARVIS_KIND.hostSilent || priority === "urgent" ? JARVIS_TIER.urgent : JARVIS_TIER.say;
const settleOf = (tier: JarvisTier) =>
  tier === JARVIS_TIER.urgent ? JARVIS_LIMITS.urgentSettleMilliseconds : JARVIS_LIMITS.settleMilliseconds;
const repeatOf = (tier: JarvisTier) =>
  tier === JARVIS_TIER.urgent ? JARVIS_LIMITS.urgentRepeatMilliseconds : JARVIS_LIMITS.repeatMilliseconds;
const rank = (planned: JarvisPlanned, priorityOf: ReadonlyMap<string, TaskPriority>) =>
  TASK_PRIORITIES.indexOf(priorityOf.get(planned.taskIds[0]!) ?? "low");
const byRank = (priorityOf: ReadonlyMap<string, TaskPriority>) => (left: JarvisPlanned, right: JarvisPlanned) =>
  rank(left, priorityOf) - rank(right, priorityOf);
const byResource = (left: JarvisCandidate, right: JarvisCandidate) =>
  (left.resource ?? "").localeCompare(right.resource ?? "");

function isSettled(candidate: JarvisCandidate, now: number) {
  const kind = kindOf(candidate.detectorKey);
  return kind !== undefined && now - candidate.createdAt >= settleOf(tierOf(kind, candidate.priority));
}

// Waiting to be heard: until it is, for a short while, no other question goes out.
const awaitsHearing = (question: JarvisQuestion, now: number) =>
  question.status === JARVIS_STATUS.waiting ||
  (question.status === JARVIS_STATUS.sent && now - (question.sentAt ?? now) < JARVIS_LIMITS.hearMilliseconds);

// A host has one question at a time; one nobody confirmed holds the next back as long as a statement would be.
const holdsItsHost = (question: JarvisQuestion, now: number) =>
  STILL_OPEN.includes(question.status) ||
  (question.status === JARVIS_STATUS.unconfirmed && now - (question.sentAt ?? now) < JARVIS_LIMITS.repeatMilliseconds);

// Grouped, fingerprinted, and left out when said already or lately; the most important first.
function freshStatements(
  candidates: readonly JarvisCandidate[],
  said: readonly JarvisSaid[],
  now: number,
  priorityOf: ReadonlyMap<string, TaskPriority>,
): JarvisPlanned[] {
  const groups = new Map<string, JarvisPlanned>();
  for (const candidate of candidates) {
    const kind = kindOf(candidate.detectorKey)!;
    const groupKey = GROUPED_BY_HOST.has(kind) ? `${kind}:${candidate.hostId}` : candidate.detectorKey;
    const group = groups.get(groupKey) ?? {
      groupKey,
      fingerprint: "",
      kind,
      tier: tierOf(kind, candidate.priority),
      hostId: candidate.hostId,
      hostLabel: candidate.hostLabel,
      names: [],
      taskIds: [],
    };
    if (candidate.resource !== null && !group.names.includes(candidate.resource)) group.names.push(candidate.resource);
    group.taskIds.push(candidate.taskId);
    groups.set(groupKey, group);
  }
  return [...groups.values()]
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
    .sort(byRank(priorityOf));
}

function questionOf(members: readonly JarvisCandidate[], again?: string): JarvisPlanned {
  const first = members[0]!;
  const groupKey = questionGroup(first);
  const keys = members.map((member) => keyOf(member)!);
  return {
    groupKey,
    fingerprint: sha256Hex(`${groupKey}|${[...keys].sort().join(",")}`),
    kind: kindOf(first.detectorKey)!,
    tier: JARVIS_TIER.ask,
    hostId: first.hostId,
    hostLabel: first.hostLabel,
    names: members.map(({ resource }) => resource ?? ""),
    taskIds: members.map(({ taskId }) => taskId),
    members: keys,
    ...(again === undefined ? {} : { again }),
  };
}

/**
 * The one question to put now, if any: none while another waits to be heard; one due again before a new one, once
 * each of its updates could be carried out; then the host whose update waited longest, three names at most.
 */
function nextQuestion(
  candidates: readonly JarvisCandidate[],
  askable: readonly JarvisCandidate[],
  questions: readonly JarvisQuestion[],
  now: number,
): JarvisPlanned | null {
  if (questions.some((question) => awaitsHearing(question, now))) return null;
  const ready = new Map(
    candidates
      .filter(({ ask }) => ask?.askable === true && ask.ready)
      .map((candidate) => [keyOf(candidate)!, candidate]),
  );
  const again = questions.find(({ due, members }) => due && members.every((member) => ready.has(member)));
  if (again !== undefined) {
    const askedAbout = again.members.map((member) => ready.get(member)!);
    return questionOf(askedAbout, again.id);
  }
  const held = new Set(questions.filter((question) => holdsItsHost(question, now)).map(({ groupKey }) => groupKey));
  const free = askable.filter((candidate) => !held.has(questionGroup(candidate)));
  const oldest = [...free].sort((left, right) => left.createdAt - right.createdAt)[0];
  if (oldest === undefined) return null;
  const members = free.filter((candidate) => questionGroup(candidate) === questionGroup(oldest)).sort(byResource);
  return questionOf(members.slice(0, JARVIS_LIMITS.namesAsked));
}

/**
 * What is worth saying now, from what is open and what was said. Waiting means whatever fixes itself is never told;
 * grouping makes three updates one sentence; the same thing is not told twice; and only so much is said in a day,
 * the most important first. The urgent always go, and do not count. An update a person could say yes to is asked
 * instead of told, one question at a time, and is neither asked nor told again for the same newer image.
 */
export function planJarvis(
  candidates: readonly JarvisCandidate[],
  said: readonly JarvisSaid[],
  now: number,
  questions: readonly JarvisQuestion[] = [],
): JarvisPlanned[] {
  const priorityOf = new Map(candidates.map(({ taskId, priority }) => [taskId, priority]));
  const askedBefore = new Set(
    questions.filter(({ status }) => ASKED_BEFORE.includes(status)).flatMap(({ members }) => members),
  );
  const isAskedBefore = (candidate: JarvisCandidate) => {
    const key = keyOf(candidate);
    return key !== null && askedBefore.has(key);
  };
  const open = candidates.filter((candidate) => isSettled(candidate, now) && !isAskedBefore(candidate));
  const statements = freshStatements(
    open.filter(({ ask, detectorKey }) => ask?.askable !== true && !ONLY_ASKED.has(kindOf(detectorKey)!)),
    said,
    now,
    priorityOf,
  );
  const question = nextQuestion(
    candidates,
    open.filter(({ ask }) => ask?.askable === true && ask.ready),
    questions,
    now,
  );
  const usedToday = said.filter(
    ({ tier, at, counted }) => counted && COUNTED.includes(tier) && now - at < JARVIS_LIMITS.dayMilliseconds,
  ).length;
  const room = Math.max(0, JARVIS_LIMITS.perDay - usedToday);
  const urgent = statements.filter(({ tier }) => tier === JARVIS_TIER.urgent);
  const spoken = [
    ...statements.filter(({ tier }) => tier === JARVIS_TIER.say),
    ...(question === null ? [] : [question]),
  ]
    .sort(byRank(priorityOf))
    .slice(0, room);
  return [...urgent, ...spoken];
}
