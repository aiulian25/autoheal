import { CONTAINER_DETAILS, HOST_PROFILE, NETWORK_CHANGE } from "../shared/constants.js";
import { INSTALL_LABEL } from "../shared/install.js";
import type { ContainerDetailsView } from "../shared/protocol.js";
import type { ContainerHistoryEntry, ContainerProcesses, DockerNetwork } from "./docker-client.js";
import type { ContainerDetails } from "./incident-report.js";

// What Docker's inspect says beyond what the rest of the runner reads of it.
type Inspected = ContainerDetails & {
  Created?: string;
  AppArmorProfile?: string;
  Config: ContainerDetails["Config"] & {
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
    WorkingDir?: string;
    User?: string;
    Hostname?: string;
    Healthcheck?: { Test?: string[]; Interval?: number; Timeout?: number };
  };
  State: ContainerDetails["State"] & {
    StartedAt?: string;
    OOMKilled?: boolean;
    Health?: { Status?: string; FailingStreak?: number };
  };
};

type HealthCheck = { End?: string; ExitCode?: number; Output?: string };

const { textCharacters, outputCharacters, entries, healthChecks, securityOption } = CONTAINER_DETAILS;
const text = (value: string | null | undefined, limit: number = textCharacters) => (value ?? "").slice(0, limit);
const texts = (values: readonly unknown[] | null | undefined) =>
  (values ?? []).slice(0, entries).map((value) => text(String(value)));
const limitOf = (value: unknown) => (typeof value === "number" && value > 0 ? value : null);
const secondsOf = (nanoseconds: number | undefined) =>
  nanoseconds === undefined || nanoseconds === 0 ? null : nanoseconds / CONTAINER_DETAILS.nanosecondsPerSecond;

function securityOf(container: Inspected): ContainerDetailsView["security"] {
  const host = container.HostConfig ?? {};
  const options = (host.SecurityOpt as string[] | null | undefined) ?? [];
  const optionOf = (prefix: string) => options.find((option) => option.startsWith(prefix))?.slice(prefix.length);
  return {
    privileged: host.Privileged === true,
    capabilitiesAdded: texts(host.CapAdd as string[] | null),
    capabilitiesDropped: texts(host.CapDrop as string[] | null),
    readOnlyRoot: host.ReadonlyRootfs === true,
    noNewPrivileges: options.some((option) => option.startsWith(securityOption.noNewPrivileges)),
    appArmor: text(optionOf(securityOption.apparmor) ?? container.AppArmorProfile),
    seccomp: text(optionOf(securityOption.seccomp)),
    dockerSocket: (container.Mounts ?? []).some((mount) => mount.Source === CONTAINER_DETAILS.dockerSocket),
  };
}

function healthOf(container: Inspected): ContainerDetailsView["health"] {
  const health = container.State.Health;
  const check = container.Config.Healthcheck;
  if (health === undefined) return null;
  return {
    status: text(health.Status),
    test: texts(check?.Test),
    everySeconds: secondsOf(check?.Interval),
    timeoutSeconds: secondsOf(check?.Timeout),
    failingStreak: health.FailingStreak ?? 0,
    checks: ((health.Log ?? []) as HealthCheck[])
      .slice(-healthChecks)
      .reverse()
      .map((entry) => ({
        at: text(entry.End),
        exitCode: entry.ExitCode ?? 0,
        output: text(entry.Output, outputCharacters),
      })),
  };
}

export const hasFixedNetworkMode = (container: ContainerDetails) => {
  const mode = container.HostConfig?.NetworkMode ?? "";
  const own: readonly string[] = NETWORK_CHANGE.ownModes;
  return own.includes(mode) || mode.startsWith(NETWORK_CHANGE.sharedModePrefix);
};

/**
 * What a click can join it to: every network on the host but Docker's own and another app's private one, which
 * Compose makes for an app's parts to talk among themselves. The ones it is on already stay, to be left.
 */
export function joinableNetworks(container: ContainerDetails, networks: readonly DockerNetwork[]): string[] {
  if (hasFixedNetworkMode(container)) return [];
  const own: readonly string[] = NETWORK_CHANGE.ownNetworks;
  const current = Object.keys(container.NetworkSettings?.Networks ?? {});
  const offered = networks
    .filter(
      (network) =>
        !own.includes(network.Name) &&
        network.Labels?.[NETWORK_CHANGE.composeNetworkLabel] !== NETWORK_CHANGE.privateComposeNetwork,
    )
    .map((network) => network.Name);
  return [...new Set([...current, ...offered])]
    .sort()
    .slice(0, entries)
    .map((name) => text(name));
}

/** Docker's view of a container, for its panel: its environment is left out, as only its settings carry that. */
export function detailsOf(
  inspected: ContainerDetails,
  processes: ContainerProcesses | null,
  history: readonly ContainerHistoryEntry[],
  networks: readonly DockerNetwork[] = [],
): ContainerDetailsView {
  const container = inspected as Inspected;
  const host = container.HostConfig ?? {};
  const cores = limitOf(host.NanoCpus);
  const labels = container.Config.Labels ?? {};
  const installedIn = labels[INSTALL_LABEL] === undefined ? undefined : labels[HOST_PROFILE.composeFolderLabel];
  return {
    imageId: container.Image ?? null,
    createdAt: container.Created ?? null,
    startedAt: container.State.StartedAt ?? null,
    command: texts([...(container.Config.Entrypoint ?? []), ...(container.Config.Cmd ?? [])]),
    workingFolder: text(container.Config.WorkingDir),
    user: text(container.Config.User),
    hostname: text(container.Config.Hostname),
    networks: Object.entries(container.NetworkSettings?.Networks ?? {})
      .slice(0, entries)
      .map(([name, endpoint]) => ({
        name: text(name),
        address: text(endpoint.IPAddress as string | undefined),
        gateway: text(endpoint.Gateway as string | undefined),
        aliases: texts(endpoint.Aliases as string[] | null | undefined),
      })),
    availableNetworks: joinableNetworks(container, networks),
    ...(installedIn === undefined ? {} : { installedIn: text(installedIn) }),
    networkMode: text(host.NetworkMode),
    mounts: (container.Mounts ?? []).slice(0, entries).map((mount) => ({
      kind: text(mount.Type),
      source: text(mount.Name ?? mount.Source),
      target: text(mount.Destination),
      readOnly: mount.RW === false,
    })),
    security: securityOf(container),
    resources: {
      cpuCores: cores === null ? null : cores / CONTAINER_DETAILS.nanoCpusPerCore,
      memoryBytes: limitOf(host.Memory),
      processes: limitOf(host.PidsLimit),
      oomKilled: container.State.OOMKilled === true,
    },
    health: healthOf(container),
    processes:
      processes === null
        ? null
        : {
            titles: texts(processes.Titles),
            rows: (processes.Processes ?? []).slice(0, CONTAINER_DETAILS.processes).map(texts),
          },
    layers: history.slice(0, CONTAINER_DETAILS.layers).map((layer) => ({
      sizeBytes: Math.max(0, layer.Size ?? 0),
      createdAt: Math.max(0, layer.Created ?? 0),
      step: text(layer.CreatedBy),
    })),
  };
}
