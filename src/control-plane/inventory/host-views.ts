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
import type { ContainerSnapshot, RecoveryHold, RestartWait } from "../../shared/protocol.js";
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

const containersOf = (host: HostRow) => JSON.parse(host.containersJson) as ContainerSnapshot[];

// Only a reporting runner's hold is true now: a quiet or revoked host's last one may be over, and one that ends by
// itself says nothing once its time is up.
function recoveryHoldOf(host: HostRow, now: number): RecoveryHold | null {
  const reporting = hostStateOf(host, now) === HOST_STATE.online;
  if (!reporting || host.recoveryHoldJson === null) {
    return null;
  }
  const hold = JSON.parse(host.recoveryHoldJson) as RecoveryHold;
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
    protectedContainers: JSON.parse(host.protectedContainersJson) as string[],
    restartBudget: JSON.parse(host.restartBudgetJson) as Record<string, number>,
    recoveryHold: recoveryHoldOf(host, now),
    restartWait:
      host.restartWaitJson === null ? null : (JSON.parse(host.restartWaitJson) as Record<string, RestartWait>),
    restartResets: JSON.parse(host.restartResetsJson) as Record<string, number>,
    containerAccess: host.containerAccess,
    hostTerminal: host.hostTerminal,
    hostDeploy: host.hostDeploy,
    health: host.healthJson === null ? null : (JSON.parse(host.healthJson) as HostHealthView),
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
): ContainerView[] {
  const protectedNames = new Set(JSON.parse(host.protectedContainersJson) as string[]);
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
