import { REPORT_LIMITS } from "../shared/constants.js";
import type { ContainerSettings } from "../shared/protocol.js";
import type { DockerClient } from "./docker-client.js";
import { composeProjectOf, type ContainerDetails } from "./incident-report.js";

export interface OperatorTarget {
  name: string;
  composeProject: string | null;
}
export type OperatorJobAuthorizer = (jobId: string, targets: OperatorTarget[]) => Promise<boolean>;
export type OperatorAccessAuthorizer = (requestId: string, target: OperatorTarget) => Promise<boolean>;
export const OPERATOR_REFUSAL =
  "Refused: this delegated action is no longer authorized; refresh permissions and try again.";
export const OPERATOR_ISOLATION_REFUSAL =
  "Refused: delegated container access requires an isolated workload without host access or shared mounted data. Ask an administrator.";
export const OPERATOR_MOUNTS_REFUSAL =
  "Refused: delegated settings cannot change mounted data or reserved control labels. Ask an administrator.";

export const operatorTarget = (details: ContainerDetails): OperatorTarget => ({
  name: details.Name.replace(/^\//, ""),
  composeProject: composeProjectOf(details),
});

type Inspection = Pick<DockerClient, "inspect"> & Partial<Pick<DockerClient, "containerSummaries" | "inspectVolume">>;
const nonempty = (value: unknown) =>
  value !== undefined && value !== null && value !== "" && (!Array.isArray(value) || value.length > 0);
const hostNamespace = (value: unknown) =>
  typeof value === "string" && (value === "host" || value.startsWith("container:"));

/** Docker capabilities and mounted data can exceed a named container's delegated boundary. */
export function isolatedOperatorContainer(details: ContainerDetails): boolean {
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

/** Inspect again for each request; an unknown or shared volume is never presumed private. */
export async function operatorAccessTarget(name: string, docker: Inspection): Promise<OperatorTarget | null> {
  const details = await docker.inspect(name);
  if (details === null || !isolatedOperatorContainer(details)) return null;
  const volumes = new Set((details.Mounts ?? []).filter((mount) => mount.Type === "volume").map((mount) => mount.Name));
  if (volumes.size > 0) {
    if (!docker.containerSummaries || !docker.inspectVolume) return null;
    const paths = (details.Mounts ?? []).filter((mount) => mount.Type === "volume").map((mount) => mount.Source);
    if (paths.some((source) => !source?.startsWith("/"))) return null;
    const overlaps = (left: string, right: string) =>
      left === right ||
      left.startsWith(`${right.replace(/\/+$/, "")}/`) ||
      right.startsWith(`${left.replace(/\/+$/, "")}/`);
    for (const name of volumes) {
      const volume = await docker.inspectVolume(name!);
      if (volume === null || volume.Driver !== "local" || Object.keys(volume.Options ?? {}).length !== 0) return null;
    }
    const summaries = await docker.containerSummaries();
    if (summaries.length > REPORT_LIMITS.containers) return null;
    for (const summary of summaries) {
      if (summary.Id === details.Id) continue;
      const other = await docker.inspect(summary.Id);
      if (other === null || !Array.isArray(other.Mounts)) return null;
      if (
        other.Mounts.some(
          (mount) =>
            (mount.Type === "volume" && volumes.has(mount.Name)) ||
            (mount.Source?.startsWith("/") && paths.some((path) => overlaps(path!, mount.Source!))),
        )
      )
        return null;
    }
  }
  return operatorTarget(details);
}

/** A settings capability cannot be used to attach another workload's volume or forge grant/group identity. */
export function unchangedOperatorBoundaries(details: ContainerDetails, settings: ContainerSettings): boolean {
  const before = (details.Mounts ?? [])
    .filter((mount) => mount.Type !== "tmpfs")
    .map((mount) => ({
      kind: mount.Type,
      source: mount.Type === "volume" ? mount.Name : mount.Source,
      target: mount.Destination,
      readOnly: mount.RW === false,
    }));
  const normalize = (mounts: unknown[]) => mounts.map((mount) => JSON.stringify(mount)).sort();
  const after = settings.mounts.map(({ kind, source, target, readOnly }) => ({ kind, source, target, readOnly }));
  if (JSON.stringify(normalize(before)) !== JSON.stringify(normalize(after))) return false;
  const reserved = (name: string) => name.startsWith("com.docker.compose.") || name.startsWith("autoheal.");
  const oldLabels = Object.entries(details.Config.Labels ?? {})
    .filter(([name]) => reserved(name))
    .sort(([a], [b]) => a.localeCompare(b));
  const newLabels = settings.labels
    .filter(({ name }) => reserved(name))
    .map(({ name, value }) => [name, value])
    .sort(([a], [b]) => a!.localeCompare(b!));
  return JSON.stringify(oldLabels) === JSON.stringify(newLabels);
}
