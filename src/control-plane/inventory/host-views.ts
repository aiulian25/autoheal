import type {
  ContainerUsageView,
  ContainerView,
  HostHealthView,
  HostMetricsView,
  HostView,
  SshConnectionView,
} from "../../shared/api.js";
import {
  CONTAINER_STATE_RUNNING,
  HANDS_OFF,
  HOST_SILENT_AFTER_MILLISECONDS,
  HOST_STATE,
  HOST_STATUS_REVOKED,
  RESTART_CHOICE,
  isKeptAsideCopy,
  type HandsOff,
  DEFAULT_AUTOHEAL_IMAGE,
  DEFAULT_SELF_CONTAINER_NAME,
  HOST_KIND,
} from "../../shared/constants.js";
import { containerProblem } from "../../shared/container-problem.js";
import { imageRepository } from "../../shared/image-reference.js";
import type {
  ContainerSnapshot,
  RecoveryHold,
  RestartWait,
  RunnerUpdateReport,
  TrimmableHeartbeatPart,
} from "../../shared/protocol.js";
import { controlOf, policyOf, type SavedControl } from "../host-control/host-control.js";
import type { HostRow } from "../hosts/hosts-service.js";

function hostStateOf(host: HostRow, now: number): HostView["state"] {
  if (host.status === HOST_STATUS_REVOKED) {
    return HOST_STATE.revoked;
  }
  if (host.lastHeartbeatAt === null) {
    return HOST_STATE.neverSeen;
  }
  const silent = now - host.lastHeartbeatAt > HOST_SILENT_AFTER_MILLISECONDS;
  return silent ? HOST_STATE.silent : HOST_STATE.online;
}

// ponytail: each host's stored reports as last read, by the text they were read from, so an unchanged report is parsed
// once rather than on every look; one entry per host and field ever read, a few kilobytes each.
const readBefore = new Map<string, { json: string; value: unknown }>();

// Shared by every view built from it, so nothing may change it: a change would show in the next look.
function frozen<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach((inner) => frozen(inner));
    Object.freeze(value);
  }
  return value;
}

/** What this host's `field` holds, parsed once for as long as it holds that same text. */
function readOnce<Value>(host: HostRow, field: string, json: string): Value {
  const slot = `${host.id}/${field}`;
  const known = readBefore.get(slot);
  if (known !== undefined && known.json === json) return known.value as Value;
  const value = frozen(JSON.parse(json) as Value);
  readBefore.set(slot, { json, value });
  return value;
}

const containersOf = (host: HostRow) => readOnce<readonly ContainerSnapshot[]>(host, "containers", host.containersJson);
const protectedNamesOf = (host: HostRow) =>
  readOnce<readonly string[]>(host, "protectedContainers", host.protectedContainersJson);

// Only a reporting runner's hold is true now: a quiet or revoked host's last one may be over, and one that ends by
// itself says nothing once its time is up.
function recoveryHoldOf(host: HostRow, now: number): RecoveryHold | null {
  const reporting = hostStateOf(host, now) === HOST_STATE.online;
  if (!reporting || host.recoveryHoldJson === null) {
    return null;
  }
  const hold = readOnce<RecoveryHold>(host, "recoveryHold", host.recoveryHoldJson);
  const ended = hold.until !== null && hold.until <= now;
  return ended ? null : hold;
}

/** A stopped container its host's page leaves unwatched is stopped on purpose: it is not counted. */
export const isCounted = (container: ContainerView) =>
  container.state === CONTAINER_STATE_RUNNING || container.byItself.restart !== RESTART_CHOICE.ignore;

// The host's own rules, as its runner last reported them: Autoheal changes nothing it protects, nor the old
// container an update keeps aside, and nothing at all while it only watches.
function handsOffOf(host: HostRow, isProtected: boolean, name: string): HandsOff | null {
  if (isProtected) {
    return HANDS_OFF.protected;
  }
  if (isKeptAsideCopy(name)) {
    return HANDS_OFF.parked;
  }
  return host.dryRun === true ? HANDS_OFF.dryRun : null;
}

const runnerUpdateOf = (host: HostRow) =>
  host.runnerUpdateJson === null ? null : readOnce<RunnerUpdateReport>(host, "runnerUpdate", host.runnerUpdateJson);

/** `saved`: the answers someone gave on the host's page, by container name. */
export function toHostView(
  host: HostRow,
  now: number,
  metrics: HostMetricsView | null = null,
  saved: ReadonlyMap<string, SavedControl> = new Map(),
  ssh: SshConnectionView | null = null,
): HostView {
  const containers = containerViewsOf(host, now, new Map(), saved).filter(isCounted);
  return {
    id: host.id,
    label: host.label,
    kind: host.kind,
    ssh,
    docker: host.docker,
    serviceProbes: host.serviceProbes,
    state: hostStateOf(host, now),
    tokenHint: host.tokenHint,
    enrolledAt: host.enrolledAt,
    lastHeartbeatAt: host.lastHeartbeatAt,
    runnerVersion: host.runnerVersion,
    dryRun: host.dryRun,
    eventStreamConnected: host.eventStreamConnected,
    protectedContainers: [...protectedNamesOf(host)],
    restartBudget: readOnce<Record<string, number>>(host, "restartBudget", host.restartBudgetJson),
    recoveryHold: recoveryHoldOf(host, now),
    // Only a reporting runner's is true now.
    clockSkewSeconds: hostStateOf(host, now) === HOST_STATE.online ? host.clockSkewSeconds : null,
    clockOffsetSeconds: hostStateOf(host, now) === HOST_STATE.online ? host.clockOffsetSeconds : null,
    // Only a reporting runner's: one gone quiet may have gone with its update.
    runnerUpdate: hostStateOf(host, now) === HOST_STATE.online ? runnerUpdateOf(host) : null,
    containersStaleSince: hostStateOf(host, now) === HOST_STATE.online ? host.containersStaleSince : null,
    reportTrimmed:
      hostStateOf(host, now) === HOST_STATE.online && host.reportTrimmedJson !== null
        ? readOnce<TrimmableHeartbeatPart[]>(host, "reportTrimmed", host.reportTrimmedJson)
        : null,
    restartWait:
      host.restartWaitJson === null
        ? null
        : readOnce<Record<string, RestartWait>>(host, "restartWait", host.restartWaitJson),
    restartResets: readOnce<Record<string, number>>(host, "restartResets", host.restartResetsJson),
    containerAccess: host.containerAccess,
    hostTerminal: host.hostTerminal,
    hostDeploy: host.hostDeploy,
    tagChanges: host.tagChanges,
    health: host.healthJson === null ? null : readOnce<HostHealthView>(host, "health", host.healthJson),
    metrics,
    containerCount: containers.length,
    runningCount: containers.filter((container) => container.state === CONTAINER_STATE_RUNNING).length,
    problemCount: containers.filter((container) => container.problem !== null).length,
  };
}

const AUTOHEAL_REPOSITORY = imageRepository(DEFAULT_AUTOHEAL_IMAGE);

/**
 * Whether a container is a sidecar runner's own: it always protects itself, under the name its settings give
 * (autoheal unless changed) and from Autoheal's image. ponytail: matched by that default name or the published
 * image; a runner renamed and run from a mirror is not, and keeps the "runner behind" notice only.
 */
const isOwnRunner = (host: HostRow, container: { name: string; image: string }, isProtected: boolean) =>
  host.kind === HOST_KIND.runner &&
  isProtected &&
  (container.name === DEFAULT_SELF_CONTAINER_NAME || imageRepository(container.image) === AUTOHEAL_REPOSITORY);

/** `saved`: the ticks someone set on the host's page, by container name. */
export function containerViewsOf(
  host: HostRow,
  now: number,
  usage: ReadonlyMap<string, ContainerUsageView>,
  saved: ReadonlyMap<string, SavedControl>,
  // The newer version a person ignores for each container, by its name.
  ignored: ReadonlyMap<string, string> = new Map(),
): ContainerView[] {
  const protectedNames = new Set(protectedNamesOf(host));
  const hostState = hostStateOf(host, now);
  return containersOf(host).map(({ update, updatePolicy, ports, hostNetwork, ...container }) => {
    const isProtected = protectedNames.has(container.name);
    const byItself = controlOf(
      { name: container.name, image: container.image, updatePolicy },
      isProtected,
      saved.get(container.name),
      { restart: host.restartDefault, update: host.updateDefault },
    );
    return {
      ...container,
      ...(isOwnRunner(host, container, isProtected) ? { ownRunner: true } : {}),
      hostId: host.id,
      hostLabel: host.label,
      hostState,
      version: container.version ?? null,
      source: container.source ?? null,
      ports: ports ?? null,
      hostNetwork: hostNetwork ?? false,
      update: {
        status: update?.status ?? null,
        checkedAt: update?.checkedAt ?? null,
        policy: policyOf(byItself),
        remote: update?.remote ?? null,
        reason: update?.reason ?? null,
        provenance: update?.provenance ?? null,
        newerTag: update?.newerTag ?? null,
        ignored: ignored.get(container.name) ?? null,
      },
      // The inventory is newer than the stats when a container has just stopped.
      usage: container.state === CONTAINER_STATE_RUNNING ? (usage.get(container.name) ?? null) : null,
      byItself,
      protected: isProtected,
      handsOff: handsOffOf(host, isProtected, container.name),
      // Unwatched, it has no problems for Autoheal to work on, nor for anyone to be shown.
      problem: byItself.restart === RESTART_CHOICE.ignore ? null : containerProblem(container),
    };
  });
}
