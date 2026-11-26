import type { ContainerDetails } from "./incident-report.js";

const nonempty = (value: unknown) =>
  value !== undefined && value !== null && value !== "" && (!Array.isArray(value) || value.length > 0);
const hostNamespace = (value: unknown) =>
  typeof value === "string" && (value === "host" || value.startsWith("container:"));

/**
 * Whether a container keeps to itself: no extra Docker capabilities, none of the host's namespaces, and only named
 * volumes or tmpfs for data. A rollout changes nothing else.
 */
export function isolatedContainer(details: ContainerDetails): boolean {
  const config = details.HostConfig;
  if (!details.Id || !config || !Array.isArray(details.Mounts)) return false;
  if (
    config.Privileged === true ||
    ["CapAdd", "Devices", "DeviceRequests", "DeviceCgroupRules", "VolumesFrom"].some((key) => nonempty(config[key]))
  )
    return false;
  if (
    ["NetworkMode", "PidMode", "IpcMode", "UTSMode", "UsernsMode", "CgroupnsMode"].some((key) =>
      hostNamespace(config[key]),
    )
  )
    return false;
  if (
    Array.isArray(config.SecurityOpt) &&
    config.SecurityOpt.some((option) => option !== "no-new-privileges" && option !== "no-new-privileges:true")
  )
    return false;
  if (
    (config.Binds ?? []).some((bind) => {
      const [source, destination, mode, extra] = bind.split(":");
      return (
        extra !== undefined ||
        source === undefined ||
        destination === undefined ||
        (mode !== undefined && mode !== "ro" && mode !== "rw") ||
        !details.Mounts!.some(
          (mount) => mount.Type === "volume" && mount.Name === source && mount.Destination === destination,
        )
      );
    })
  )
    return false;
  if ((config.Mounts ?? []).some((mount) => mount.Type !== "volume" && mount.Type !== "tmpfs")) return false;
  return details.Mounts.every(
    (mount) =>
      mount.Type === "tmpfs" || (mount.Type === "volume" && typeof mount.Name === "string" && mount.Name.length > 0),
  );
}
