import {
  OPERATOR_REFUSAL,
  OPERATOR_ISOLATION_REFUSAL,
  operatorAccessTarget,
  type OperatorAccessAuthorizer,
} from "./operator-authorization.js";
import {
  NETWORK_CHANGE,
  BIND_SEPARATOR,
  ENVIRONMENT_ENTRY_SEPARATOR,
  MOUNT_KIND,
  MOUNT_TYPE_BIND,
  MOUNT_TYPE_VOLUME,
  PORT_KEY_SEPARATOR,
  PORT_PROTOCOLS,
  READ_ONLY_BIND_SUFFIX,
  RESTART_POLICIES,
  RESTART_POLICY_NONE,
  type PortProtocol,
} from "../shared/constants.js";
import { describeError } from "../shared/errors.js";
import { isDeniedSource } from "../shared/install.js";
import type { ContainerSettings, SettingsAnswer, SettingsRequest } from "../shared/protocol.js";
import { detailsOf, hasFixedNetworkMode, joinableNetworks } from "./container-details.js";
import { containerAccessRefusal, type ContainerAccessSettings } from "./container-access-guard.js";
import type { RecreateSpecification } from "./container-updater.js";
import type { DockerClient } from "./docker-client.js";
import type { ContainerConfig, ContainerDetails, PortBinding } from "./incident-report.js";

type RestartPolicy = ContainerSettings["restart"]["policy"];
type Mount = ContainerSettings["mounts"][number];

const isRestartPolicy = (name: string): name is RestartPolicy => (RESTART_POLICIES as readonly string[]).includes(name);
const isProtocol = (name: string): name is PortProtocol => (PORT_PROTOCOLS as readonly string[]).includes(name);

function entriesOf(environment: readonly string[]): { name: string; value: string }[] {
  return environment.map((entry) => {
    const separatorAt = entry.indexOf(ENVIRONMENT_ENTRY_SEPARATOR);
    return separatorAt < 0
      ? { name: entry, value: "" }
      : { name: entry.slice(0, separatorAt), value: entry.slice(separatorAt + 1) };
  });
}

function portsOf(bindings: Record<string, PortBinding[] | null> | null | undefined): ContainerSettings["ports"] {
  return Object.entries(bindings ?? {}).flatMap(([key, published]) => {
    const [target, protocol = ""] = key.split(PORT_KEY_SEPARATOR);
    if (!isProtocol(protocol)) {
      return [];
    }
    return (published ?? []).map((binding) => ({
      target: Number(target),
      protocol,
      published: Number(binding.HostPort),
      address: binding.HostIp ?? "",
    }));
  });
}

// Binds and volumes as the container has them now, its anonymous volumes by name: removing one is a choice.
function mountsOf(details: ContainerDetails): Mount[] {
  return (details.Mounts ?? []).flatMap((mount): Mount[] => {
    const readOnly = mount.RW === false;
    if (mount.Type === MOUNT_TYPE_BIND) {
      return [{ kind: MOUNT_KIND.bind, source: mount.Source ?? "", target: mount.Destination, readOnly }];
    }
    if (mount.Type === MOUNT_TYPE_VOLUME) {
      return [{ kind: MOUNT_KIND.volume, source: mount.Name ?? "", target: mount.Destination, readOnly }];
    }
    return [];
  });
}

/** A container's own settings: what the person set, not what its image sets (Docker adds those again). */
export function settingsOf(details: ContainerDetails, image: Partial<ContainerConfig>): ContainerSettings {
  const fromImage = new Set(image.Env ?? []);
  const imageLabels = image.Labels ?? {};
  const policy = details.HostConfig?.RestartPolicy?.Name || RESTART_POLICY_NONE;
  return {
    environment: entriesOf((details.Config.Env ?? []).filter((entry) => !fromImage.has(entry))),
    labels: Object.entries(details.Config.Labels ?? {})
      .filter(([name, value]) => imageLabels[name] !== value)
      .map(([name, value]) => ({ name, value })),
    ports: portsOf(details.HostConfig?.PortBindings),
    mounts: mountsOf(details),
    restart: {
      policy: isRestartPolicy(policy) ? policy : RESTART_POLICY_NONE,
      retries: details.HostConfig?.RestartPolicy?.MaximumRetryCount ?? 0,
    },
  };
}

/**
 * A host path the container did not have mounted before and must not get: the host's root or system, or Docker's
 * own (its socket, its data). Null when every new bind is of an ordinary path.
 */
export function deniedMountOf(details: ContainerDetails, settings: ContainerSettings): string | null {
  const before = new Set((details.Mounts ?? []).map((mount) => mount.Source));
  const added = settings.mounts.filter((mount) => mount.kind === MOUNT_KIND.bind && !before.has(mount.source));
  const denied = added.find((mount) => isDeniedSource(mount.source));
  return denied?.source ?? null;
}

const bindOf = (mount: Mount) =>
  `${mount.source}${BIND_SEPARATOR}${mount.target}${mount.readOnly ? READ_ONLY_BIND_SUFFIX : ""}`;

/**
 * The recreate request with the person's settings in place of the old ones. Mounts of other kinds (a tmpfs) stay
 * as they were; binds and volumes are given as binds, which keep each volume's data under its name.
 */
export function withSettings(specification: RecreateSpecification, settings: ContainerSettings): RecreateSpecification {
  const create = specification.create as { HostConfig: Record<string, unknown>; ExposedPorts?: unknown };
  const hostConfig = create.HostConfig as { Mounts?: { Type?: string }[] | null };
  const otherMounts = (hostConfig.Mounts ?? []).filter(
    (mount) => mount.Type !== MOUNT_TYPE_BIND && mount.Type !== MOUNT_TYPE_VOLUME,
  );
  const portKey = (port: ContainerSettings["ports"][number]) => `${port.target}${PORT_KEY_SEPARATOR}${port.protocol}`;
  const bindings: Record<string, PortBinding[]> = {};
  for (const port of settings.ports) {
    bindings[portKey(port)] = [
      ...(bindings[portKey(port)] ?? []),
      { HostIp: port.address, HostPort: String(port.published) },
    ];
  }
  const exposed = Object.fromEntries(settings.ports.map((port) => [portKey(port), {}]));
  return {
    ...specification,
    create: {
      ...specification.create,
      Env: settings.environment.map((entry) => `${entry.name}${ENVIRONMENT_ENTRY_SEPARATOR}${entry.value}`),
      Labels: Object.fromEntries(settings.labels.map((entry) => [entry.name, entry.value])),
      ExposedPorts: { ...((create.ExposedPorts as object | undefined) ?? {}), ...exposed },
      HostConfig: {
        ...create.HostConfig,
        PortBindings: bindings,
        Binds: settings.mounts.map(bindOf),
        Mounts: otherMounts,
        RestartPolicy: { Name: settings.restart.policy, MaximumRetryCount: settings.restart.retries },
      },
    },
  };
}

export interface SettingsReaderDependencies {
  authorizeOperator?: OperatorAccessAuthorizer;
  docker: Pick<
    DockerClient,
    "inspect" | "inspectImage" | "processes" | "imageHistory" | "networks" | "connect" | "disconnect"
  > &
    Partial<Pick<DockerClient, "containerSummaries" | "inspectVolume">>;
  settings: ContainerAccessSettings;
  // A network change shows on the host's page without waiting for a heartbeat.
  reportInventory?: () => void;
}

/** Reads a container's settings for a person who asked, once its host lets them reach inside it. */
export class SettingsReader {
  constructor(private readonly dependencies: SettingsReaderDependencies) {}

  // A person's click, live: Docker changes it without a restart. Never a network it could not have been offered.
  private async changeNetwork(
    container: ContainerDetails,
    name: string,
    change: { name: string; joined: boolean },
  ): Promise<string | null> {
    const { docker } = this.dependencies;
    if (hasFixedNetworkMode(container)) return NETWORK_CHANGE.fixedMode(container.HostConfig?.NetworkMode ?? "");
    const current = Object.keys(container.NetworkSettings?.Networks ?? {});
    const on = current.includes(change.name);
    if (on === change.joined) return null;
    if (!change.joined) {
      if (current.length === 1) return NETWORK_CHANGE.lastNetwork;
      await docker.disconnect(change.name, name);
      return null;
    }
    if (!joinableNetworks(container, await docker.networks()).includes(change.name)) {
      return NETWORK_CHANGE.notAvailable(change.name);
    }
    await docker.connect(change.name, name, {});
    return null;
  }

  async answer(request: SettingsRequest): Promise<SettingsAnswer> {
    const { docker, settings } = this.dependencies;
    try {
      const refusal = await containerAccessRefusal(request.containerName, settings, docker, { running: false });
      if (refusal !== null) {
        return { error: refusal, settings: null };
      }
      if (request.operatorUserId !== undefined) {
        const target = await operatorAccessTarget(request.containerName, docker);
        if (target === null) return { error: OPERATOR_ISOLATION_REFUSAL, settings: null };
        if (!(await this.dependencies.authorizeOperator?.(request.id, target).catch(() => false)))
          return { error: OPERATOR_REFUSAL, settings: null };
      }
      const details = (await docker.inspect(request.containerName))!;
      if (request.network !== undefined) {
        const problem = await this.changeNetwork(details, request.containerName, request.network);
        if (problem !== null) return { error: problem, settings: null, details: null };
        this.dependencies.reportInventory?.();
      }
      if (request.details === true || request.network !== undefined) {
        const current = (await docker.inspect(request.containerName))!;
        const [processes, history, networks] = await Promise.all([
          current.State.Running === true ? docker.processes(request.containerName).catch(() => null) : null,
          current.Image === undefined ? [] : docker.imageHistory(current.Image).catch(() => []),
          docker.networks().catch(() => []),
        ]);
        return { error: null, settings: null, details: detailsOf(current, processes, history, networks) };
      }
      const image = details.Image === undefined ? null : await docker.inspectImage(details.Image);
      return { error: null, settings: settingsOf(details, image?.Config ?? {}) };
    } catch (error) {
      return { error: describeError(error), settings: null };
    }
  }
}
