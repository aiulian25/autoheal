import {
  hasNewerVersion,
  type BoardView,
  type ContainerView,
  type HomeAssistantUpdateView,
  type HostPackagesView,
  type HostView,
  type IncidentSummaryView,
  type TaskSummaryView,
} from "../../src/shared/api.js";
import {
  HOST_STATE,
  PRESSING_TASK_PRIORITIES,
  TASK_ABOUT,
  TASK_LABEL,
  TASK_PRIORITIES,
  TASK_RESOURCE,
  UPDATE_CHECK_INTERVAL_MILLISECONDS,
  VERDICT_FIXED,
  type TaskResourceKind,
} from "../../src/shared/constants.js";
import { isHostPackageTask, isIncident, isTask, isUpdateTask, stillWaits, whatNeedsYou } from "./board.js";
import { ATTENTION_PLACE, type AttentionPlaceKind } from "./constants.js";
import { diskUsedPercent, fullestDisk } from "./pages/host-dial-values.js";

/** A host's updates as one group draws them: its containers' new images, its packages, newer tags, what they ask. */
export interface UpdateGroupFacts {
  host: HostView;
  tasks: TaskSummaryView[];
  // The host's containers, for what each update brings.
  containers: ContainerView[];
  packages: HostPackagesView | undefined;
  // Its containers with a newer version of their pinned tag out, which the agent can move them to.
  newer: ContainerView[];
  // What its packages ask of a person besides the list: a reboot, a release's end, its updates while none are listed.
  hostTasks: TaskSummaryView[];
}

/** One card under "Needs you": a host, or Home Assistant, the network, Ollama, with all it has for a person. */
export interface NeedsYouPlace {
  key: string;
  kind: AttentionPlaceKind;
  // The host, for a host's card; for one that left the fleet, only its name.
  host: HostView | null;
  hostLabel: string | null;
  decisions: IncidentSummaryView[];
  // Tasks a restart cannot solve, most pressing first: a runner gone silent before all.
  problems: TaskSummaryView[];
  updates: UpdateGroupFacts | null;
  homeAssistantUpdates: HomeAssistantUpdateView[];
}

/** One card under "To look at": a place's tasks that wait for a look, not for a decision. */
export interface LookAtPlace {
  key: string;
  kind: AttentionPlaceKind;
  hostId: string | null;
  hostLabel: string | null;
  tasks: TaskSummaryView[];
}

export interface PlacesInput {
  board: BoardView;
  hosts: readonly HostView[];
  containers: readonly ContainerView[];
  // Each host's package view, where it has been read.
  packages: ReadonlyMap<string, HostPackagesView>;
  homeAssistantUpdates: readonly HomeAssistantUpdateView[];
}

const HOME_ASSISTANT_RESOURCES: ReadonlySet<TaskResourceKind> = new Set([
  TASK_RESOURCE.homeAssistant,
  TASK_RESOURCE.zigbee,
  TASK_RESOURCE.safety,
  TASK_RESOURCE.watched,
]);
const NETWORK_RESOURCES: ReadonlySet<TaskResourceKind> = new Set([TASK_RESOURCE.network, TASK_RESOURCE.probe]);

// Where a task without a host belongs: what its resource is part of.
function hostlessKind(task: TaskSummaryView): AttentionPlaceKind {
  const kind = task.resource?.kind;
  if (kind === undefined) return ATTENTION_PLACE.other;
  if (HOME_ASSISTANT_RESOURCES.has(kind)) return ATTENTION_PLACE.homeAssistant;
  if (NETWORK_RESOURCES.has(kind)) return ATTENTION_PLACE.network;
  return kind === TASK_RESOURCE.ollama ? ATTENTION_PLACE.ollama : ATTENTION_PLACE.other;
}

const placeKeyOf = (task: TaskSummaryView) => task.hostId ?? hostlessKind(task);

const isSilentRunner = (task: TaskSummaryView) => task.about === TASK_ABOUT.runnerSilent;
const priorityRank = (task: TaskSummaryView) => TASK_PRIORITIES.indexOf(task.priority);
const mostPressingFirst = (first: TaskSummaryView, second: TaskSummaryView) =>
  Number(isSilentRunner(second)) - Number(isSilentRunner(first)) ||
  priorityRank(first) - priorityRank(second) ||
  first.createdAt - second.createdAt;

// A host's updates, as its group draws them; null when it has none.
function updateGroupOf(
  host: HostView,
  input: PlacesInput,
  updateTasks: readonly TaskSummaryView[],
  hostTasks: readonly TaskSummaryView[],
): UpdateGroupFacts | null {
  const view = input.packages.get(host.id);
  const listed = view !== undefined && view.packages.length > 0 ? view : undefined;
  const group: UpdateGroupFacts = {
    host,
    tasks: updateTasks.filter(
      (task) =>
        task.hostId === host.id && task.labels.includes(TASK_LABEL.update) && stillWaits(task, input.containers),
    ),
    containers: input.containers.filter((container) => container.hostId === host.id),
    packages: listed,
    newer: input.containers.filter((container) => container.hostId === host.id && hasNewerVersion(container)),
    // The list stands for its updates task; while nothing is listed, the task itself says so.
    hostTasks: hostTasks.filter(
      (task) => task.hostId === host.id && (task.about !== TASK_ABOUT.osUpdates || listed === undefined),
    ),
  };
  const anything =
    group.tasks.length > 0 || listed !== undefined || group.newer.length > 0 || group.hostTasks.length > 0;
  return anything ? group : null;
}

// Most pressing first: a host gone quiet, then what waits for a decision or presses, then other problems, then updates.
function rankOf(place: NeedsYouPlace): number {
  const quiet = place.host !== null && place.host.state !== HOST_STATE.online;
  if (quiet) return 0;
  const pressing = place.problems.some((task) => PRESSING_TASK_PRIORITIES.includes(task.priority));
  if (place.decisions.length > 0 || pressing) return 1;
  return place.problems.length > 0 || (place.updates?.hostTasks.length ?? 0) > 0 ? 2 : 3;
}

const placeName = (place: { hostLabel: string | null; kind: string }) => place.hostLabel ?? place.kind;

/** Everything for a person, one card for each place it happens on, the most pressing place first. */
export function needsYouPlaces(input: PlacesInput): NeedsYouPlace[] {
  const { decisions, problems } = whatNeedsYou(input.board.needsYou);
  const needed = input.board.needsYou.filter(isTask).map((card) => card.task);
  const hostTasks = needed.filter(isHostPackageTask);
  // Updates show whoever has them now: Autoheal or Ollama on them, or noticed and not yet handed to anyone.
  const updateTasks = [...input.board.needsYou, ...input.board.noticed, ...input.board.autoheal]
    .filter(isTask)
    .map((card) => card.task)
    .filter(isUpdateTask);
  const places = new Map<string, NeedsYouPlace>();
  const placeFor = (key: string, kind: AttentionPlaceKind, hostLabel: string | null) => {
    const known = places.get(key);
    if (known !== undefined) return known;
    const host = input.hosts.find((candidate) => candidate.id === key) ?? null;
    const place: NeedsYouPlace = {
      key,
      kind,
      host,
      hostLabel: host?.label ?? hostLabel,
      decisions: [],
      problems: [],
      updates: null,
      homeAssistantUpdates: [],
    };
    places.set(key, place);
    return place;
  };
  for (const card of decisions) {
    placeFor(card.incident.hostId, ATTENTION_PLACE.host, card.incident.hostLabel).decisions.push(card.incident);
  }
  for (const card of problems) {
    const { task } = card;
    const kind = task.hostId === null ? hostlessKind(task) : ATTENTION_PLACE.host;
    placeFor(placeKeyOf(task), kind, task.hostLabel).problems.push(task);
  }
  for (const host of input.hosts) {
    const group = updateGroupOf(host, input, updateTasks, hostTasks);
    if (group !== null) placeFor(host.id, ATTENTION_PLACE.host, host.label).updates = group;
  }
  if (input.homeAssistantUpdates.length > 0) {
    const home = placeFor(ATTENTION_PLACE.homeAssistant, ATTENTION_PLACE.homeAssistant, null);
    home.homeAssistantUpdates = [...input.homeAssistantUpdates];
  }
  for (const place of places.values()) place.problems.sort(mostPressingFirst);
  return [...places.values()].sort(
    (first, second) => rankOf(first) - rankOf(second) || placeName(first).localeCompare(placeName(second)),
  );
}

// Put off by a person: the dashboard clears the time once it has passed.
const isSnoozed = (task: TaskSummaryView) => task.snoozedUntil !== null;

// What was noticed and waits for a look: not the updates, which their host's card shows, nor what was put off.
const noticedTasks = (board: BoardView) =>
  board.noticed
    .filter(isTask)
    .map((card) => card.task)
    .filter((task) => !task.labels.includes(TASK_LABEL.update));

/** What waits for a look when a person has time, by place: the place with most of them first. */
export function lookAtPlaces(board: BoardView): LookAtPlace[] {
  const places = new Map<string, LookAtPlace>();
  for (const task of noticedTasks(board).filter((candidate) => !isSnoozed(candidate))) {
    const key = placeKeyOf(task);
    const place = places.get(key) ?? {
      key,
      kind: task.hostId === null ? hostlessKind(task) : ATTENTION_PLACE.host,
      hostId: task.hostId,
      hostLabel: task.hostLabel,
      tasks: [],
    };
    place.tasks.push(task);
    places.set(key, place);
  }
  return [...places.values()].sort(
    (first, second) => second.tasks.length - first.tasks.length || placeName(first).localeCompare(placeName(second)),
  );
}

/** What a person put off, the soonest back first. */
export function snoozedTasks(board: BoardView): TaskSummaryView[] {
  return noticedTasks(board)
    .filter(isSnoozed)
    .sort((first, second) => (first.snoozedUntil ?? 0) - (second.snoozedUntil ?? 0));
}

export interface FleetCounts {
  online: number;
  total: number;
  running: number;
  containers: number;
  // The fullest disk anywhere, and its host; null before any host reports its disks.
  fullest: { host: HostView; percent: number } | null;
}

/** How the fleet stands, in the few numbers the line under Attention's title says. */
export function fleetCounts(hosts: readonly HostView[]): FleetCounts {
  let fullest: FleetCounts["fullest"] = null;
  for (const host of hosts) {
    const disk = fullestDisk(host.health);
    const percent = disk === undefined ? null : diskUsedPercent(disk);
    if (percent !== null && (fullest === null || percent > fullest.percent)) fullest = { host, percent };
  }
  return {
    online: hosts.filter((host) => host.state === HOST_STATE.online).length,
    total: hosts.length,
    running: hosts.reduce((sum, host) => sum + host.runningCount, 0),
    containers: hosts.reduce((sum, host) => sum + host.containerCount, 0),
    fullest,
  };
}

/**
 * How long until the next hourly image check: an hour after each host's newest check, the soonest of them. Null
 * before any check, and once one is overdue, as a host's runner that stopped reporting no longer says.
 */
export function nextImageCheckIn(containers: readonly ContainerView[], now: number): number | null {
  const newest = new Map<string, number>();
  for (const container of containers) {
    const checkedAt = container.update.checkedAt;
    if (checkedAt !== null) newest.set(container.hostId, Math.max(newest.get(container.hostId) ?? 0, checkedAt));
  }
  if (newest.size === 0) return null;
  const soonest = Math.min(...[...newest.values()].map((checkedAt) => checkedAt + UPDATE_CHECK_INTERVAL_MILLISECONDS));
  return soonest < now ? null : soonest - now;
}

/** What Autoheal did by itself in the last day: containers it healed, updates that went in without a person. */
export function doneByItself(board: BoardView) {
  const healed = board.done.filter(isIncident).filter((card) => card.incident.verdict === VERDICT_FIXED).length;
  const updated = board.done
    .filter(isTask)
    .filter((card) => card.task.labels.includes(TASK_LABEL.update) && card.task.assignee?.kind === "agent").length;
  return { healed, updated };
}
