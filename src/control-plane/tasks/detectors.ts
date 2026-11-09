import {
  hasNewerVersion,
  hasUpdate,
  updateVersions,
  updatesWithoutAsking,
  type AssigneeChoice,
  type ContainerView,
  type DiskUsageView,
  type HomeAssistantView,
  type HostHealthView,
  type HostMetricsView,
  type HostView,
  type OllamaStatusView,
  type WatchedDeviceView,
} from "../../shared/api.js";
import {
  AGENT_AUTOHEAL,
  CONTAINER_PROBLEMS,
  DETECTOR_GRACE_MILLISECONDS,
  DETECTOR_KEY_SEPARATOR,
  DETECTOR_KEYS,
  NOTIFICATIONS_LOST_WINDOW_MILLISECONDS,
  DETECTOR_THRESHOLDS,
  HOME_ASSISTANT_UPDATES_RESOURCE,
  HOST_STATE,
  IMAGE_REFERENCE,
  POWER_PHASE,
  IMAGE_CLEANUP,
  LIFECYCLE_STATUS,
  METRICS_WINDOW_TOLERANCE_MILLISECONDS,
  MILLISECONDS_PER_MINUTE,
  PERCENT,
  RECOVERY_HOLD,
  SAFETY_PROBLEMS,
  TASK_LABEL,
  TASK_PRIORITY,
  TASK_RESOURCE,
  TASK_SOURCE,
  TASK_TEXT,
  TRIGGER_OOM,
  WATCHED_PROBLEMS,
  ZIGBEE_PROBLEMS,
  sizeText,
  type ImageCleanup,
  type TaskPriority,
  wordsOf,
} from "../../shared/constants.js";
import { driveProblems } from "../../shared/drive-health.js";
import { imageRepository } from "../../shared/image-reference.js";
import type { UnusedImage } from "../../shared/protocol.js";
import { utcMinute } from "../../shared/time-zones.js";
import { lifecycleOf } from "../host-packages/lifecycle.js";
import type { PackagePlan } from "../host-packages/package-rules.js";
import type { NetworkFinding } from "../network/network-watch.js";
import type { ProbeFinding } from "../probes/probe-service.js";
import type { RebootPlanFinding } from "../power/reboot-plans-service.js";
import type { TaskFinding } from "./tasks-service.js";

/** Everything the detectors look at, as it is now. */
export interface DetectorInputs {
  now: number;
  hosts: HostView[];
  containers: ContainerView[];
  history: (hostId: string) => HostMetricsView[];
  // Null when Home Assistant is not configured.
  homeAssistant: HomeAssistantView | null;
  ollama: OllamaStatusView;
  ollamaExtras: { id: string; name: string; status: OllamaStatusView; hostIds: string[] }[];
  // Optional, as a test of something else has no router.
  network?: { findings: () => NetworkFinding[]; judging: boolean };
  // When the notification outbox last could not take an alert; null when it never could not. Absent in a test of
  // something else.
  notificationOverflowAt?: number | null;
  probes?: { findings: () => ProbeFinding[]; judges: (key: string) => boolean };
  rebootPlans?: { findings: () => RebootPlanFinding[] };
  // Who gets a task Autoheal can't do itself.
  owner: AssigneeChoice | null;
  // Who takes care of each pending package on a host; null before its first check.
  packagePlan: (host: HostView) => PackagePlan | null;
  // The images no container on the host uses, and how often its page lets Autoheal clean them.
  unusedImages: (hostId: string) => UnusedImage[] | null;
  imageCleanup: (hostId: string) => ImageCleanup;
}

export interface DetectedProblem extends TaskFinding {
  // How long the problem must last before it becomes a task.
  graceMilliseconds: number;
}

export interface Detection {
  problems: DetectedProblem[];
  // Whether this run could tell if the problem behind a task's key is still there. A host that
  // is silent or a Home Assistant that is away tells nothing, so their tasks are left as they are.
  judges: (key: string) => boolean;
}

const keyOf = (...parts: string[]) => parts.join(DETECTOR_KEY_SEPARATOR);
const AUTOHEAL_ASSIGNEE: AssigneeChoice = { kind: "agent", id: AGENT_AUTOHEAL };
/** The key of the task a container's new image opens: the one an update closes. */
export const updateTaskKey = (hostId: string, containerName: string) =>
  keyOf(DETECTOR_KEYS.update, hostId, containerName);
/** The key of the task a newer version opens; its last part is that version's tag. */
export const newerVersionTaskKey = (hostId: string, containerName: string, tag: string) =>
  keyOf(DETECTOR_KEYS.newerVersion, hostId, containerName, tag);
export const isNewerVersionTaskKey = (key: string | null) =>
  key?.startsWith(`${DETECTOR_KEYS.newerVersion}${DETECTOR_KEY_SEPARATOR}`) === true;
/** The tag a newer version's task is about: containers and tags hold no separator, so it is the key's last part. */
export const tagOfNewerVersionKey = (key: string) => key.split(DETECTOR_KEY_SEPARATOR).at(-1) ?? "";

/** The task a newer version opens: for its detector, and for a person handing it to the agent before that ran. */
export function newerVersionFinding(container: ContainerView, owner: AssigneeChoice | null): DetectedProblem {
  const tag = container.update.newerTag!;
  return {
    labels: [],
    graceMilliseconds: 0,
    assignee: owner,
    source: TASK_SOURCE.detector,
    key: newerVersionTaskKey(container.hostId, container.name, tag),
    title: TASK_TEXT.newerVersion(container.name, container.hostLabel, tag),
    description: TASK_TEXT.newerVersionDetails(
      container.image,
      `${imageRepository(container.image)}${IMAGE_REFERENCE.tagSeparator}${tag}`,
    ),
    priority: TASK_PRIORITY.low,
    hostId: container.hostId,
    resource: { kind: TASK_RESOURCE.container, id: container.name, label: container.name },
  };
}
const startsWithAny = (key: string, prefixes: readonly string[]) =>
  prefixes.some((prefix) => key.startsWith(`${prefix}${DETECTOR_KEY_SEPARATOR}`));
const SEVERE_CONTAINER_PROBLEMS: ReadonlySet<string> = new Set([
  CONTAINER_PROBLEMS.restarting,
  CONTAINER_PROBLEMS.dead,
  CONTAINER_PROBLEMS.outOfMemory,
]);

function finding(
  inputs: DetectorInputs,
  fields: Pick<DetectedProblem, "key" | "title" | "description" | "priority" | "hostId" | "resource"> &
    Partial<Pick<DetectedProblem, "labels" | "graceMilliseconds" | "assignee">>,
): DetectedProblem {
  return { labels: [], graceMilliseconds: 0, assignee: inputs.owner, source: TASK_SOURCE.detector, ...fields };
}

const onlineHosts = (inputs: DetectorInputs) => inputs.hosts.filter((host) => host.state === HOST_STATE.online);

function containers(inputs: DetectorInputs): Detection {
  // A host whose Docker could not list its containers says nothing new of them: their tasks stay as they are.
  const online = new Set(
    onlineHosts(inputs)
      .filter((host) => (host.containersStaleSince ?? null) === null)
      .map((host) => host.id),
  );
  const problems = inputs.containers
    .filter((container) => online.has(container.hostId) && container.problem !== null)
    .map((container) =>
      finding(inputs, {
        key: keyOf(DETECTOR_KEYS.container, container.hostId, container.name),
        title: TASK_TEXT.containerProblem(container.name, container.problem!, container.hostLabel),
        description: TASK_TEXT.containerDetails(
          container.image,
          container.state,
          container.exitCode,
          container.restartCount,
        ),
        priority: SEVERE_CONTAINER_PROBLEMS.has(container.problem!) ? TASK_PRIORITY.high : TASK_PRIORITY.medium,
        hostId: container.hostId,
        resource: { kind: TASK_RESOURCE.container, id: container.name, label: container.name },
        graceMilliseconds: DETECTOR_GRACE_MILLISECONDS.container,
      }),
    );
  const prefixes = [...online].map((hostId) => keyOf(DETECTOR_KEYS.container, hostId));
  return { problems, judges: (key) => startsWithAny(key, prefixes) };
}

function updateTitle(container: ContainerView): string {
  const versions = updateVersions(container);
  return versions === null
    ? TASK_TEXT.update(container.name, container.hostLabel)
    : TASK_TEXT.updateTo(container.name, container.hostLabel, versions.from, versions.to);
}

// Its update is Autoheal's to apply: if Ollama calls it safe, or each time.
const autohealUpdates = (container: ContainerView) => updatesWithoutAsking(container) && container.handsOff === null;

function updates(inputs: DetectorInputs): Detection {
  const online = new Set(onlineHosts(inputs).map((host) => host.id));
  const reported = inputs.containers.filter((container) => online.has(container.hostId));
  const problems = reported.filter(hasUpdate).map((container) =>
    finding(inputs, {
      key: updateTaskKey(container.hostId, container.name),
      title: updateTitle(container),
      description:
        container.handsOff === null
          ? TASK_TEXT.updateDetails(container.image)
          : TASK_TEXT.updateByHand(container.image, container.name, container.hostLabel, container.handsOff),
      priority: TASK_PRIORITY.low,
      labels: [TASK_LABEL.update],
      hostId: container.hostId,
      resource: { kind: TASK_RESOURCE.container, id: container.name, label: container.name },
      // The label decides: auto means Autoheal does it, ask means a person does. A container its
      // host keeps Autoheal's hands off is always a person's.
      assignee: autohealUpdates(container) ? AUTOHEAL_ASSIGNEE : inputs.owner,
    }),
  );
  // A runner that restarted knows nothing until its next check. Once a host's check has run, a container it gave
  // no answer for cannot be checked (run by an image id, or built there): no update waits for it. A container that
  // is gone is judged too.
  const checked = new Set(
    reported.filter((container) => container.update.status !== null).map((container) => container.hostId),
  );
  const unknown = new Set(
    reported
      .filter((container) => container.update.status === null && !checked.has(container.hostId))
      .map((container) => updateTaskKey(container.hostId, container.name)),
  );
  const prefixes = [...online].map((hostId) => keyOf(DETECTOR_KEYS.update, hostId));
  return { problems, judges: (key) => startsWithAny(key, prefixes) && !unknown.has(key) };
}

/** A newer version than the tag a container runs: a person's to take, as the tag is theirs to write. */
function newerVersions(inputs: DetectorInputs): Detection {
  const online = new Set(onlineHosts(inputs).map((host) => host.id));
  const reported = inputs.containers.filter((container) => online.has(container.hostId));
  const problems = reported.filter(hasNewerVersion).map((container) => newerVersionFinding(container, inputs.owner));
  // Only a host whose check has run says a version is no longer newer.
  const checked = reported.filter((container) => container.update.status !== null).map(({ hostId }) => hostId);
  const prefixes = [...new Set(checked)].map((hostId) => keyOf(DETECTOR_KEYS.newerVersion, hostId));
  return { problems, judges: (key) => startsWithAny(key, prefixes) };
}

/** True when every reading in the last `window` holds, null when the readings don't go back that far. */
function sustained(
  points: readonly HostMetricsView[],
  now: number,
  window: number,
  holds: (point: HostMetricsView) => boolean,
) {
  const start = now - window;
  const covered = points.some((point) => point.at <= start + METRICS_WINDOW_TOLERANCE_MILLISECONDS);
  const recent = points.filter((point) => point.at >= start);
  return covered && recent.length > 0 ? recent.every(holds) : null;
}

function hosts(inputs: DetectorInputs): Detection {
  const problems: DetectedProblem[] = [];
  const judged = new Set<string>();
  const host = (hostId: string) => ({ hostId, resource: null });
  for (const candidate of inputs.hosts.filter((entry) => entry.state !== HOST_STATE.neverSeen)) {
    const key = keyOf(DETECTOR_KEYS.hostSilent, candidate.id);
    judged.add(key);
    // Rebooting or shut down as a person asked: it is quiet on purpose, and its page says so.
    const poweredOff = candidate.power !== undefined && candidate.power.phase !== POWER_PHASE.failed;
    if (candidate.state === HOST_STATE.silent && !poweredOff) {
      const minutes = Math.round((inputs.now - (candidate.lastHeartbeatAt ?? inputs.now)) / MILLISECONDS_PER_MINUTE);
      problems.push(
        finding(inputs, {
          key,
          title: TASK_TEXT.hostSilent(candidate.label),
          description: TASK_TEXT.hostSilentDetails(minutes),
          priority: TASK_PRIORITY.high,
          ...host(candidate.id),
          resource: { kind: TASK_RESOURCE.host, id: candidate.id, label: candidate.label },
        }),
      );
    }
  }
  for (const online of onlineHosts(inputs)) {
    const pausedKey = keyOf(DETECTOR_KEYS.healingPaused, online.id);
    judged.add(pausedKey);
    // A host without Docker has no events to follow, and nothing to heal.
    if (online.docker !== false && !online.eventStreamConnected) {
      problems.push(
        finding(inputs, {
          key: pausedKey,
          title: TASK_TEXT.healingPaused(online.label),
          description: TASK_TEXT.healingPausedDetails,
          priority: TASK_PRIORITY.high,
          graceMilliseconds: DETECTOR_GRACE_MILLISECONDS.healingPaused,
          hostId: online.id,
          resource: { kind: TASK_RESOURCE.host, id: online.id, label: online.label },
        }),
      );
    }
    const clockKey = keyOf(DETECTOR_KEYS.clockOff, online.id);
    judged.add(clockKey);
    // Its runner takes no maintenance policy across clocks this far apart, and so heals nothing on its own.
    const clockOffSeconds = online.clockSkewSeconds ?? null;
    if (clockOffSeconds !== null) {
      problems.push(
        finding(inputs, {
          key: clockKey,
          title: TASK_TEXT.clockOff(online.label, clockOffSeconds),
          description: TASK_TEXT.clockOffDetails,
          priority: TASK_PRIORITY.high,
          graceMilliseconds: DETECTOR_GRACE_MILLISECONDS.clockOff,
          hostId: online.id,
          resource: { kind: TASK_RESOURCE.host, id: online.id, label: online.label },
        }),
      );
    }
    const heldKey = keyOf(DETECTOR_KEYS.recoveryHeld, online.id);
    judged.add(heldKey);
    const hold = online.recoveryHold ?? null;
    // The hour after a new install ends by itself; a hold that waits for the runner to be fixed is a task.
    if (hold !== null && hold.reason !== RECOVERY_HOLD.noSavedState) {
      problems.push(
        finding(inputs, {
          key: heldKey,
          title: TASK_TEXT.recoveryHeld(online.label),
          description: TASK_TEXT.recoveryHeldDetails[hold.reason],
          priority: TASK_PRIORITY.high,
          hostId: online.id,
          resource: { kind: TASK_RESOURCE.host, id: online.id, label: online.label },
        }),
      );
    }
    const health = online.health;
    for (const disk of health?.disks ?? []) {
      const key = keyOf(DETECTOR_KEYS.disk, online.id, disk.path);
      judged.add(key);
      problems.push(...fullDisk(inputs, online, disk, key));
    }
    const plan = inputs.packagePlan(online);
    if (health?.rebootRequired !== null && health?.rebootRequired !== undefined) {
      const key = keyOf(DETECTOR_KEYS.reboot, online.id);
      judged.add(key);
      // A newer kernel installed waits for a reboot even where no package said so, and dnf says so itself.
      const kernelWaiting = health.packages?.kernelWaiting ?? null;
      if (health.rebootRequired || kernelWaiting !== null || plan?.rebootRequired === true) {
        const packages = health.packages?.rebootPackages ?? [];
        problems.push(
          finding(inputs, {
            key,
            title: TASK_TEXT.reboot(online.label),
            description:
              packages.length === 0 && kernelWaiting === null
                ? TASK_TEXT.rebootDetails
                : TASK_TEXT.rebootFor(packages, kernelWaiting),
            priority: TASK_PRIORITY.low,
            labels: [TASK_LABEL.packages],
            ...host(online.id),
          }),
        );
      }
    }
    problems.push(...osUpdates(inputs, online, plan, judged));
    problems.push(...lifecycle(inputs, online, judged));
    problems.push(...sustainedProblems(inputs, online, judged));
    problems.push(...drives(inputs, online, judged));
    problems.push(...driveHeat(inputs, online, judged));
    problems.push(...gpuHeat(inputs, online, judged));
  }
  return { problems, judges: (key) => judged.has(key) };
}

/**
 * One task per host for what its packages wait for. Autoheal holds it when everything pending is its
 * own to install in the window; a security fix that waits for a person makes it medium.
 */
function osUpdates(
  inputs: DetectorInputs,
  online: HostView,
  plan: PackagePlan | null,
  judged: Set<string>,
): DetectedProblem[] {
  if (plan === null) {
    return [];
  }
  const key = keyOf(DETECTOR_KEYS.osUpdates, online.id);
  judged.add(key);
  const pending = [...plan.forPerson, ...plan.automatic];
  if (pending.length === 0) {
    return [];
  }
  const assessed = new Map(plan.packages.map((assessment) => [assessment.name, assessment]));
  const securityFix = (name: string) => assessed.get(name)?.security === true;
  const held = plan.forPerson.filter((name) => assessed.get(name)?.held === true);
  const waiting = plan.forPerson.filter((name) => assessed.get(name)?.held !== true);
  return [
    finding(inputs, {
      key,
      title: TASK_TEXT.osUpdates(online.label, pending.length, pending.filter(securityFix).length),
      description: TASK_TEXT.osUpdatesFor(held, plan.automatic, waiting),
      priority: plan.forPerson.some(securityFix) ? TASK_PRIORITY.medium : TASK_PRIORITY.low,
      assignee: plan.forPerson.length === 0 ? AUTOHEAL_ASSIGNEE : inputs.owner,
      labels: [TASK_LABEL.packages],
      hostId: online.id,
      resource: null,
    }),
  ];
}

const LIFECYCLE_PRIORITIES = {
  [LIFECYCLE_STATUS.ending]: TASK_PRIORITY.low,
  [LIFECYCLE_STATUS.extended]: TASK_PRIORITY.medium,
  [LIFECYCLE_STATUS.unsupported]: TASK_PRIORITY.high,
} as const;

/** A release whose free security fixes end within months, or ended: low, medium on paid support, high after. */
function lifecycle(inputs: DetectorInputs, online: HostView, judged: Set<string>): DetectedProblem[] {
  const release = lifecycleOf(online.health?.packages ?? null, inputs.now);
  if (release === null) {
    return [];
  }
  const key = keyOf(DETECTOR_KEYS.lifecycle, online.id);
  judged.add(key);
  if (release.status === LIFECYCLE_STATUS.supported) {
    return [];
  }
  const titles = {
    [LIFECYCLE_STATUS.ending]: () => TASK_TEXT.lifecycleEnding(release.release, online.label, release.securityUntil!),
    [LIFECYCLE_STATUS.extended]: () => TASK_TEXT.lifecycleExtended(release.release, online.label),
    [LIFECYCLE_STATUS.unsupported]: () => TASK_TEXT.lifecycleUnsupported(release.release, online.label),
  };
  return [
    finding(inputs, {
      key,
      title: titles[release.status](),
      description: TASK_TEXT.lifecycleDetails(
        release.status === LIFECYCLE_STATUS.unsupported ? null : release.extendedUntil,
      ),
      priority: LIFECYCLE_PRIORITIES[release.status],
      labels: [TASK_LABEL.packages],
      hostId: online.id,
      resource: null,
    }),
  ];
}

export const percentFullOf = (usedBytes: number, availableBytes: number) =>
  Math.round((usedBytes / Math.max(1, usedBytes + availableBytes)) * PERCENT);

// The reported disk Docker keeps its images on: the longest of their paths its image store lies under.
export function imageDiskOf(health: HostHealthView | null): string | null {
  const store = health?.imageStore ?? null;
  if (store === null) {
    return null;
  }
  const holds = (path: string) => store === path || store.startsWith(path.endsWith("/") ? path : `${path}/`);
  const holding = (health?.disks ?? []).map((disk) => disk.path).filter(holds);
  return holding.sort((first, second) => second.length - first.length)[0] ?? null;
}

/**
 * A disk at 90% or more. On the disk that holds Docker's images it says what unused ones take there, and when
 * the host's page lets Autoheal clean them (and the host is not dry-run) the task is Autoheal's to free at once.
 */
function fullDisk(inputs: DetectorInputs, online: HostView, disk: DiskUsageView, key: string): DetectedProblem[] {
  const percent = percentFullOf(disk.usedBytes, disk.availableBytes);
  if (percent < DETECTOR_THRESHOLDS.diskPercent) {
    return [];
  }
  const onImageDisk = imageDiskOf(online.health) === disk.path;
  const unused = onImageDisk ? (inputs.unusedImages(online.id) ?? []) : [];
  const reclaimable = unused.filter((image) => !image.keptByUpdate).reduce((sum, image) => sum + image.sizeBytes, 0);
  const projected = percentFullOf(Math.max(0, disk.usedBytes - reclaimable), disk.availableBytes + reclaimable);
  const autohealFrees =
    reclaimable > 0 && online.dryRun === false && inputs.imageCleanup(online.id) !== IMAGE_CLEANUP.off;
  return [
    finding(inputs, {
      key,
      title: TASK_TEXT.disk(online.label, disk.path, percent),
      description:
        reclaimable > 0
          ? TASK_TEXT.diskImages(disk.availableBytes, sizeText(reclaimable), projected)
          : TASK_TEXT.diskDetails(disk.availableBytes),
      priority: percent >= DETECTOR_THRESHOLDS.diskCriticalPercent ? TASK_PRIORITY.high : TASK_PRIORITY.medium,
      labels: [TASK_LABEL.disk],
      assignee: autohealFrees ? AUTOHEAL_ASSIGNEE : inputs.owner,
      hostId: online.id,
      resource: { kind: TASK_RESOURCE.disk, id: disk.path, label: disk.path },
    }),
  ];
}

const onHost = (host: HostView) => ({
  hostId: host.id,
  resource: { kind: TASK_RESOURCE.host, id: host.id, label: host.label },
});

/** A drive whose smartd records show wear or failure: high when it is failing, medium when only worn. */
function drives(inputs: DetectorInputs, online: HostView, judged: Set<string>): DetectedProblem[] {
  return (online.health?.drives ?? []).flatMap((drive) => {
    const key = keyOf(DETECTOR_KEYS.drive, online.id, drive.device);
    judged.add(key);
    const { problems, failing } = driveProblems(drive, inputs.now);
    if (problems.length === 0) {
      return [];
    }
    return [
      finding(inputs, {
        key,
        title: TASK_TEXT.driveHealth(drive.device, online.label),
        description: TASK_TEXT.driveHealthDetails(problems, utcMinute(drive.readAt)),
        priority: failing ? TASK_PRIORITY.high : TASK_PRIORITY.medium,
        ...onHost(online),
      }),
    ];
  });
}

/** A drive above its own temperature limit, or the usual one where it declares none, for ten minutes. */
function driveHeat(inputs: DetectorInputs, online: HostView, judged: Set<string>): DetectedProblem[] {
  return (online.health?.driveTemperatures ?? []).flatMap((reading) => {
    const key = keyOf(DETECTOR_KEYS.driveHeat, online.id, reading.device);
    judged.add(key);
    const limit = reading.maximumCelsius ?? DETECTOR_THRESHOLDS.driveCelsius;
    if (reading.celsius < limit) {
      return [];
    }
    return [
      finding(inputs, {
        key,
        title: TASK_TEXT.driveHeat(reading.device, online.label, Math.round(reading.celsius), Math.round(limit)),
        description: TASK_TEXT.heatDetails,
        priority: TASK_PRIORITY.high,
        graceMilliseconds: DETECTOR_GRACE_MILLISECONDS.driveHeat,
        ...onHost(online),
      }),
    ];
  });
}

/** A GPU hot for as long as a CPU must be, each by its name in the host's latest stats. */
function gpuHeat(inputs: DetectorInputs, online: HostView, judged: Set<string>): DetectedProblem[] {
  const points = inputs.history(online.id);
  const names = (points.at(-1)?.gpus ?? []).map((gpu) => gpu.name);
  return names.flatMap((name) => {
    const hot = (point: HostMetricsView) =>
      point.gpus.some((gpu) => gpu.name === name && (gpu.temperatureCelsius ?? 0) >= DETECTOR_THRESHOLDS.gpuCelsius);
    const verdict = sustained(points, inputs.now, DETECTOR_GRACE_MILLISECONDS.temperature, hot);
    const key = keyOf(DETECTOR_KEYS.gpuTemperature, online.id, name);
    if (verdict !== null) {
      judged.add(key);
    }
    if (verdict !== true) {
      return [];
    }
    return [
      finding(inputs, {
        key,
        title: TASK_TEXT.gpuHeat(name, online.label),
        description: TASK_TEXT.heatDetails,
        priority: TASK_PRIORITY.high,
        ...onHost(online),
      }),
    ];
  });
}

function sustainedProblems(inputs: DetectorInputs, host: HostView, judged: Set<string>): DetectedProblem[] {
  const points = inputs.history(host.id);
  const memoryPercent = (point: HostMetricsView) =>
    (point.memory.usedBytes / Math.max(1, point.memory.totalBytes)) * PERCENT;
  const checks: {
    kind: string;
    window: number;
    holds: (point: HostMetricsView) => boolean;
    title: string;
    priority: TaskPriority;
  }[] = [
    {
      kind: DETECTOR_KEYS.memory,
      window: DETECTOR_GRACE_MILLISECONDS.memory,
      holds: (point) => memoryPercent(point) >= DETECTOR_THRESHOLDS.memoryPercent,
      title: TASK_TEXT.memory(host.label),
      priority: TASK_PRIORITY.medium,
    },
    {
      kind: DETECTOR_KEYS.cpu,
      window: DETECTOR_GRACE_MILLISECONDS.cpu,
      holds: (point) => point.cpu.busyPercent >= DETECTOR_THRESHOLDS.cpuPercent,
      title: TASK_TEXT.cpu(host.label),
      priority: TASK_PRIORITY.medium,
    },
    {
      kind: DETECTOR_KEYS.temperature,
      window: DETECTOR_GRACE_MILLISECONDS.temperature,
      holds: (point) => (point.cpu.temperatureCelsius ?? 0) >= DETECTOR_THRESHOLDS.temperatureCelsius,
      title: TASK_TEXT.temperature(host.label, Math.round(points.at(-1)?.cpu.temperatureCelsius ?? 0)),
      priority: TASK_PRIORITY.high,
    },
  ];
  const problems: DetectedProblem[] = [];
  for (const check of checks) {
    const verdict = sustained(points, inputs.now, check.window, check.holds);
    const key = keyOf(check.kind, host.id);
    if (verdict !== null) {
      judged.add(key);
    }
    if (verdict === true) {
      problems.push(
        finding(inputs, {
          key,
          title: check.title,
          description: TASK_TEXT.sustainedDetails,
          priority: check.priority,
          hostId: host.id,
          resource: { kind: TASK_RESOURCE.host, id: host.id, label: host.label },
        }),
      );
    }
  }
  return problems;
}

function zigbee(inputs: DetectorInputs, view: HomeAssistantView): Detection {
  const device = (id: string, label: string) => ({ hostId: null, resource: { kind: TASK_RESOURCE.zigbee, id, label } });
  const unavailable = view.zigbee.filter((entry) => entry.available === false);
  const outage = unavailable.length >= DETECTOR_THRESHOLDS.zigbeeOutageDevices;
  const problems: DetectedProblem[] = [];
  if (outage) {
    problems.push(
      finding(inputs, {
        key: DETECTOR_KEYS.zigbeeNetwork,
        title: TASK_TEXT.zigbeeNetwork(unavailable.length),
        description: TASK_TEXT.zigbeeNetworkDetails(unavailable.map((entry) => entry.name)),
        priority: TASK_PRIORITY.high,
        hostId: null,
        resource: null,
        graceMilliseconds: DETECTOR_GRACE_MILLISECONDS.zigbeeNetwork,
      }),
    );
  }
  // During an outage the network task speaks for every device in it.
  const single = outage ? [] : unavailable;
  for (const entry of single) {
    problems.push(
      finding(inputs, {
        key: keyOf(DETECTOR_KEYS.zigbeeUnavailable, entry.id),
        title: TASK_TEXT.zigbeeUnavailable(entry.name),
        description: TASK_TEXT.zigbeeUnavailableDetails(entry.area),
        priority: TASK_PRIORITY.medium,
        ...device(entry.id, entry.name),
        graceMilliseconds: DETECTOR_GRACE_MILLISECONDS.zigbeeUnavailable,
      }),
    );
  }
  // The device list's own verdict, so its page and its task never disagree on what is low.
  for (const entry of view.zigbee.filter((candidate) => candidate.problems.includes(ZIGBEE_PROBLEMS.lowBattery))) {
    const critical = (entry.batteryPercent ?? PERCENT) < DETECTOR_THRESHOLDS.batteryCriticalPercent;
    problems.push(
      finding(inputs, {
        key: keyOf(DETECTOR_KEYS.zigbeeBattery, entry.id),
        title: TASK_TEXT.battery(entry.name, entry.batteryPercent ?? 0),
        description: TASK_TEXT.batteryDetails(entry.area),
        priority: critical ? TASK_PRIORITY.medium : TASK_PRIORITY.low,
        labels: [TASK_LABEL.battery],
        ...device(entry.id, entry.name),
      }),
    );
  }
  for (const entry of view.zigbee.filter((candidate) => candidate.problems.includes(ZIGBEE_PROBLEMS.weakLink))) {
    problems.push(
      finding(inputs, {
        key: keyOf(DETECTOR_KEYS.zigbeeLink, entry.id),
        title: TASK_TEXT.weakLink(entry.name),
        description: TASK_TEXT.weakLinkDetails(entry.linkQuality),
        priority: TASK_PRIORITY.low,
        ...device(entry.id, entry.name),
        graceMilliseconds: DETECTOR_GRACE_MILLISECONDS.weakLink,
      }),
    );
  }
  const judgedPrefixes: string[] = [DETECTOR_KEYS.zigbeeBattery, DETECTOR_KEYS.zigbeeLink];
  if (!outage) {
    judgedPrefixes.push(DETECTOR_KEYS.zigbeeUnavailable);
  }
  return { problems, judges: (key) => key === DETECTOR_KEYS.zigbeeNetwork || startsWithAny(key, judgedPrefixes) };
}

function safety(inputs: DetectorInputs, view: HomeAssistantView): Detection {
  const problems = view.safety
    .filter((entry) => entry.problems.length > 0)
    .map((entry) =>
      finding(inputs, {
        key: keyOf(DETECTOR_KEYS.safety, entry.id),
        title: TASK_TEXT.safety(entry.name, entry.problems.map(wordsOf)),
        description: TASK_TEXT.safetyDetails,
        priority: TASK_PRIORITY.urgent,
        labels: [TASK_LABEL.safety],
        hostId: null,
        resource: { kind: TASK_RESOURCE.safety, id: entry.id, label: entry.name },
        // An alarm is news at once; a device dropping off may be Home Assistant restarting.
        graceMilliseconds: entry.problems.includes(SAFETY_PROBLEMS.alarm) ? 0 : DETECTOR_GRACE_MILLISECONDS.safety,
      }),
    );
  return { problems, judges: (key) => startsWithAny(key, [DETECTOR_KEYS.safety]) };
}

// A device that is unavailable as a whole says so; otherwise each of its entities' problems.
function watchedProblemsOf(entry: WatchedDeviceView): string[] {
  if (entry.available === false) {
    return [wordsOf(WATCHED_PROBLEMS.unavailable)];
  }
  return entry.problems.map(({ entity, problem }) => `${entity} ${wordsOf(problem)}`);
}

function watched(inputs: DetectorInputs, view: HomeAssistantView): Detection {
  const problems = view.watched
    .filter((entry) => watchedProblemsOf(entry).length > 0)
    .map((entry) =>
      finding(inputs, {
        key: keyOf(DETECTOR_KEYS.watched, entry.id),
        title: TASK_TEXT.watched(entry.name, entry.integration),
        description: TASK_TEXT.watchedDetails(watchedProblemsOf(entry)),
        priority: TASK_PRIORITY.medium,
        hostId: null,
        resource: { kind: TASK_RESOURCE.watched, id: entry.id, label: entry.name },
        graceMilliseconds: DETECTOR_GRACE_MILLISECONDS.watched,
      }),
    );
  return { problems, judges: (key) => startsWithAny(key, [DETECTOR_KEYS.watched]) };
}

/**
 * The updates waiting on Home Assistant's own box (its Core, its system, its Apps, and what HACS added), in one task
 * a person works in Home Assistant: the connector only reads. It follows the list, and closes once none is left.
 */
function homeAssistantUpdates(inputs: DetectorInputs, view: HomeAssistantView): Detection {
  const key = DETECTOR_KEYS.homeAssistantUpdates;
  const waiting = view.system.updates;
  const lines = waiting.map((update) =>
    TASK_TEXT.homeAssistantUpdateLine(
      update.title,
      update.installed ?? TASK_TEXT.unknownVersion,
      update.latest ?? TASK_TEXT.unknownVersion,
    ),
  );
  const problems =
    waiting.length === 0
      ? []
      : [
          finding(inputs, {
            key,
            title: TASK_TEXT.homeAssistantUpdates(waiting.length),
            description: TASK_TEXT.homeAssistantUpdateList(lines),
            priority: TASK_PRIORITY.low,
            labels: [TASK_LABEL.update],
            hostId: null,
            resource: { kind: TASK_RESOURCE.homeAssistant, ...HOME_ASSISTANT_UPDATES_RESOURCE },
            graceMilliseconds: DETECTOR_GRACE_MILLISECONDS.watched,
          }),
        ];
  return { problems, judges: (candidate) => candidate === key };
}

// A revoked host's problems are nobody's any more: every task keyed by it is judged, whatever its kind, so they close.
// A kind not keyed by host makes keys no task has.
function revokedHosts(inputs: DetectorInputs): Detection {
  const revoked = inputs.hosts.filter((host) => host.state === HOST_STATE.revoked).map((host) => host.id);
  const keys = revoked.flatMap((hostId) => Object.values(DETECTOR_KEYS).map((kind) => keyOf(kind, hostId)));
  const exact = new Set(keys);
  return { problems: [], judges: (key) => exact.has(key) || startsWithAny(key, keys) };
}

function ollama(inputs: DetectorInputs): Detection {
  const status = inputs.ollama;
  const resource = { kind: TASK_RESOURCE.ollama, id: status.model, label: status.model };
  const problems: DetectedProblem[] = [];
  if (status.checkedAt !== null && !status.reachable) {
    problems.push(
      finding(inputs, {
        key: DETECTOR_KEYS.ollama,
        title: TASK_TEXT.ollama,
        description: TASK_TEXT.ollamaDetails(status.error),
        priority: TASK_PRIORITY.high,
        hostId: null,
        resource,
        graceMilliseconds: DETECTOR_GRACE_MILLISECONDS.ollama,
      }),
    );
  }
  if (status.reachable && status.modelPresent === false) {
    problems.push(
      finding(inputs, {
        key: DETECTOR_KEYS.ollamaModel,
        title: TASK_TEXT.ollamaModel(status.model),
        description: TASK_TEXT.ollamaModelDetails(status.model),
        priority: TASK_PRIORITY.high,
        hostId: null,
        resource,
      }),
    );
  }
  // Whether the model is there can only be told while Ollama answers.
  const judges = (key: string) =>
    (key === DETECTOR_KEYS.ollama && status.checkedAt !== null) ||
    (key === DETECTOR_KEYS.ollamaModel && status.reachable);
  return { problems, judges };
}

// A server beside the default being down is a warning: its hosts' work goes to the default meanwhile. One since
// removed has nothing left to find, so its task closes.
function ollamaExtras(inputs: DetectorInputs): Detection {
  const labelOf = new Map(inputs.hosts.map(({ id, label }) => [id, label]));
  const down = inputs.ollamaExtras.filter(({ status }) => status.checkedAt !== null && !status.reachable);
  const unchecked = new Set(inputs.ollamaExtras.filter(({ status }) => status.checkedAt === null).map(({ id }) => id));
  const problems = down.map(({ id, name, status, hostIds }) =>
    finding(inputs, {
      key: `${DETECTOR_KEYS.ollamaServerDown}${id}`,
      title: TASK_TEXT.ollamaServerDown(name),
      description: TASK_TEXT.ollamaServerDownDetails(
        name,
        hostIds.map((hostId) => labelOf.get(hostId) ?? hostId),
        status.error,
      ),
      priority: TASK_PRIORITY.medium,
      hostId: null,
      resource: { kind: TASK_RESOURCE.ollama, id, label: name },
      graceMilliseconds: DETECTOR_GRACE_MILLISECONDS.ollama,
    }),
  );
  const judges = (key: string) =>
    key.startsWith(DETECTOR_KEYS.ollamaServerDown) && !unchecked.has(key.slice(DETECTOR_KEYS.ollamaServerDown.length));
  return { problems, judges };
}

// Tasks from the router's watch. Unable to read it, only the task that says so can be judged: the rest stay as they are.
function network(inputs: DetectorInputs): Detection {
  const { findings, judging } = inputs.network ?? { findings: () => [], judging: false };
  const problems = findings().map(({ key, title, description, id, label, urgent }) =>
    finding(inputs, {
      key: `${DETECTOR_KEYS.network}${key}`,
      title,
      description,
      priority: urgent ? TASK_PRIORITY.high : TASK_PRIORITY.medium,
      hostId: null,
      resource: { kind: TASK_RESOURCE.network, id, label },
    }),
  );
  const judges = (key: string) =>
    key.startsWith(DETECTOR_KEYS.network) && (judging || key === `${DETECTOR_KEYS.network}router-problem`);
  return { problems, judges };
}

// A service that has not answered for as long as its check asks. It goes to a person and nothing acts on it.
function probes(inputs: DetectorInputs): Detection {
  const { findings, judges } = inputs.probes ?? { findings: () => [], judges: () => false };
  const problems = findings().map(({ key, title, description, hostId, probeId, name, urgent }) =>
    finding(inputs, {
      key,
      title,
      description,
      priority: urgent ? TASK_PRIORITY.high : TASK_PRIORITY.medium,
      hostId,
      resource: { kind: TASK_RESOURCE.probe, id: probeId, label: name },
    }),
  );
  return { problems, judges };
}

// A paused reboot plan waits for a person, who should hear of it.
function rebootPlans(inputs: DetectorInputs): Detection {
  const problems = (inputs.rebootPlans?.findings() ?? []).map(({ key, title, description, hostId, hostLabel }) =>
    finding(inputs, {
      key,
      title,
      description,
      priority: TASK_PRIORITY.high,
      hostId,
      resource: { kind: TASK_RESOURCE.host, id: hostId, label: hostLabel },
    }),
  );
  return { problems, judges: (key) => key.startsWith(DETECTOR_KEYS.rebootPlan) };
}

/** Every problem the rules see now, and which open tasks they can judge. */
// Alerts dropped as the outbox was full reached no channel: Attention is where the person still hears of it.
function notificationsLost(inputs: DetectorInputs): Detection {
  const lastAt = inputs.notificationOverflowAt ?? null;
  const lately = lastAt !== null && inputs.now - lastAt < NOTIFICATIONS_LOST_WINDOW_MILLISECONDS;
  const problems = lately
    ? [
        finding(inputs, {
          key: DETECTOR_KEYS.notificationsLost,
          title: TASK_TEXT.notificationsLost,
          description: TASK_TEXT.notificationsLostDetails,
          priority: TASK_PRIORITY.high,
          hostId: null,
          resource: null,
        }),
      ]
    : [];
  return { problems, judges: (key) => key === DETECTOR_KEYS.notificationsLost };
}

export function detect(inputs: DetectorInputs): Detection {
  const view = inputs.homeAssistant;
  const connected = view !== null && view.status.connected;
  const detections = [
    containers(inputs),
    updates(inputs),
    newerVersions(inputs),
    hosts(inputs),
    revokedHosts(inputs),
    ollama(inputs),
    ollamaExtras(inputs),
    network(inputs),
    probes(inputs),
    rebootPlans(inputs),
    notificationsLost(inputs),
  ];
  if (connected) {
    detections.push(
      zigbee(inputs, view),
      safety(inputs, view),
      watched(inputs, view),
      homeAssistantUpdates(inputs, view),
    );
  }
  return {
    problems: detections.flatMap((detection) => detection.problems),
    judges: (key) => detections.some((detection) => detection.judges(key)),
  };
}

/** An incident's container gets the same task its detector would open; the incident is linked to it. */
export function incidentFinding(
  incident: { id: string; containerName: string; triggerEvent: string },
  host: { id: string; label: string },
  owner: AssigneeChoice | null,
): TaskFinding {
  return {
    key: keyOf(DETECTOR_KEYS.container, host.id, incident.containerName),
    title: TASK_TEXT.incident(incident.containerName, incident.triggerEvent, host.label),
    description: TASK_TEXT.incidentDetails,
    priority: incident.triggerEvent === TRIGGER_OOM ? TASK_PRIORITY.high : TASK_PRIORITY.medium,
    labels: [],
    hostId: host.id,
    resource: { kind: TASK_RESOURCE.container, id: incident.containerName, label: incident.containerName },
    assignee: owner,
    source: TASK_SOURCE.incident,
    incidentId: incident.id,
  };
}
