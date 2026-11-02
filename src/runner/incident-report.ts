import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_PROJECT_PATTERN,
  CONTAINER_STATE_RUNNING,
  EXIT_CODE_SUCCESS,
  HEALTH_OUTPUT_ENTRIES,
  HEALTH_UNHEALTHY,
  LOG_CHARACTER_LIMIT,
  REPORT_LIMITS,
  RESTART_POLICY_ALWAYS,
  RESTART_POLICY_NONE,
  RESTART_POLICY_UNLESS_STOPPED,
  TRIGGER_DIE,
  TRIGGER_OOM,
  TRIGGER_UNHEALTHY,
  type Trigger,
} from "../shared/constants.js";
import type { ContainerSnapshot } from "../shared/protocol.js";
import { redactSecrets } from "../shared/redaction.js";
import type { IncidentReport } from "../shared/report.js";
import type { NeighbourFacts } from "./neighbours.js";

export interface ContainerState {
  Status?: string;
  Running?: boolean;
  Restarting?: boolean;
  ExitCode?: number;
  OOMKilled?: boolean;
  Error?: string;
  StartedAt?: string;
  FinishedAt?: string;
  Health?: { Status?: string; Log?: { Output?: string }[] };
}

/** How a container was configured, as `docker inspect` shows it; recreating it passes the rest on. */
export interface ContainerConfig {
  Image: string;
  Tty?: boolean;
  Env?: string[] | null;
  Labels?: Record<string, string> | null;
  Hostname?: string;
  Cmd?: string[] | null;
  Entrypoint?: string[] | null;
  ExposedPorts?: Record<string, object> | null;
  Volumes?: Record<string, object> | null;
  WorkingDir?: string;
  User?: string;
  StopTimeout?: number | null;
  [setting: string]: unknown;
}

export interface MountSpecification {
  Type?: string;
  Source?: string;
  Target?: string;
  [setting: string]: unknown;
}

/** Where a published port listens on the host: an address (all when empty) and a port, as Docker writes them. */
export interface PortBinding {
  HostIp?: string;
  HostPort?: string;
}

export interface HostConfiguration {
  RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
  PortBindings?: Record<string, PortBinding[] | null> | null;
  // Limits; 0 means none.
  NanoCpus?: number;
  CpuQuota?: number;
  CpuPeriod?: number;
  Memory?: number;
  NetworkMode?: string;
  Binds?: string[] | null;
  Mounts?: MountSpecification[] | null;
  [setting: string]: unknown;
}

export interface NetworkEndpoint {
  Aliases?: string[] | null;
  IPAMConfig?: unknown;
  Links?: string[] | null;
  MacAddress?: string;
  DriverOpts?: Record<string, string> | null;
  [setting: string]: unknown;
}

/** The parts of `docker inspect` Autoheal reads. */
export interface ContainerDetails {
  Id?: string;
  Name: string;
  // The image it runs, by id.
  Image?: string;
  RestartCount?: number;
  State: ContainerState;
  Config: ContainerConfig;
  HostConfig?: HostConfiguration;
  NetworkSettings?: { Networks?: Record<string, NetworkEndpoint> | null };
  Mounts?: { Type?: string; Name?: string; Source?: string; Destination: string; RW?: boolean }[] | null;
}

export const containerNameOf = (container: ContainerDetails) => container.Name.replace(/^\//, "");

export const restartPolicyOf = (container: ContainerDetails) =>
  container.HostConfig?.RestartPolicy?.Name || RESTART_POLICY_NONE;

/** Its compose project, when its label names one the way Compose does; else null. */
export function composeProjectOf(container: ContainerDetails): string | null {
  const label = container.Config.Labels?.[COMPOSE_PROJECT_LABEL] ?? "";
  return label.length <= REPORT_LIMITS.nameCharacters && COMPOSE_PROJECT_PATTERN.test(label) ? label : null;
}

const keptAliveByDocker = (policy: string) =>
  policy === RESTART_POLICY_ALWAYS || policy === RESTART_POLICY_UNLESS_STOPPED;

/**
 * Down, restarting or unhealthy counts as broken, with one exception: a container that exited
 * cleanly and that Docker was never asked to keep running is a job that finished (a backup, a
 * migration, `compose run`), and restarting it would run the job again.
 */
export function isBroken(state: ContainerState, restartPolicy: string = RESTART_POLICY_NONE): boolean {
  const isUnhealthy = state.Health?.Status === HEALTH_UNHEALTHY;
  const isDown = !state.Running;
  const exitedCleanly = isDown && !state.Restarting && state.ExitCode === EXIT_CODE_SUCCESS && !isUnhealthy;
  if (exitedCleanly && !keptAliveByDocker(restartPolicy)) {
    return false;
  }
  return Boolean(state.Restarting) || isDown || isUnhealthy;
}

/** The event Docker would have sent about a container found broken without one. */
export function triggerOf(snapshot: Pick<ContainerSnapshot, "oomKilled" | "health" | "state">): Trigger {
  if (snapshot.oomKilled) {
    return TRIGGER_OOM;
  }
  if (snapshot.state === CONTAINER_STATE_RUNNING && snapshot.health === HEALTH_UNHEALTHY) {
    return TRIGGER_UNHEALTHY;
  }
  return TRIGGER_DIE;
}

export function summariseState(container: ContainerDetails): string {
  const state = container.State;
  return [
    `status=${state.Status}`,
    `exit_code=${state.ExitCode}`,
    `oom_killed=${state.OOMKilled}`,
    `health=${state.Health?.Status ?? "none"}`,
    `restart_count=${container.RestartCount}`,
    `restart_policy=${restartPolicyOf(container)}`,
    `error=${state.Error || "-"}`,
  ].join(" ");
}

/**
 * `projectContainers`: the containers of its compose project, the only ones the model may name as its dependency;
 * `neighbours`: how Docker shows them, a few with their last lines, masked like the container's own.
 */
export function buildIncidentReport(
  container: ContainerDetails,
  trigger: Trigger,
  logs: string,
  knownContainers: ReadonlySet<string>,
  protectedContainers: ReadonlySet<string>,
  otherEnvironment: readonly string[] = [],
  projectContainers: ReadonlySet<string> = new Set(),
  neighbours: readonly NeighbourFacts[] = [],
): IncidentReport {
  const environment = [...(container.Config.Env ?? []), ...otherEnvironment];
  const redact = (text: string) => redactSecrets(text, environment);
  const healthLog = container.State.Health?.Log ?? [];
  const name = containerNameOf(container);
  return {
    containerName: name,
    image: container.Config.Image.slice(0, REPORT_LIMITS.imageCharacters),
    trigger,
    stateSummary: redact(summariseState(container)).slice(0, REPORT_LIMITS.summaryCharacters),
    healthOutputs: healthLog
      .slice(-HEALTH_OUTPUT_ENTRIES)
      .map((entry) => redact((entry.Output ?? "").trim()).slice(-REPORT_LIMITS.healthOutputCharacters)),
    knownContainers: [...knownContainers].sort(),
    protectedContainers: [...protectedContainers].sort(),
    logs: redact(logs).slice(-LOG_CHARACTER_LIMIT),
    composeProject: composeProjectOf(container),
    projectContainers: [...projectContainers].filter((member) => member !== name).sort(),
    neighbours: neighbours.map((neighbour) => ({
      name: neighbour.name,
      status: redact(neighbour.status).slice(0, REPORT_LIMITS.neighbourStatusCharacters),
      logs: neighbour.logs === null ? null : redact(neighbour.logs).slice(-REPORT_LIMITS.neighbourLogCharacters),
    })),
  };
}
