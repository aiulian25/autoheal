import {
  AUTOHEAL_LABEL_PREFIX,
  AUTOHEAL_VOLUME_PREFIXES,
  COMPOSE_PROJECT_LABEL,
  OTHER_TOOL_LABEL_SUFFIX,
  REPORT_LIMITS,
  VOLUME_ANONYMOUS_LABEL,
  VOLUME_SIZES_REFRESH_MILLISECONDS,
} from "../shared/constants.js";
import { describeError } from "../shared/errors.js";
import type { VolumeReport } from "../shared/volumes.js";
import type { ContainerSummary, DockerClient, DockerVolume } from "./docker-client.js";

type VolumeLister = Pick<DockerClient, "containerSummaries" | "allVolumes">;
type VolumeSizer = Pick<DockerClient, "volumeSizes">;

const RUNNING = "running";
const MOUNT_VOLUME = "volume";
const nameOf = (container: ContainerSummary) => container.Names[0]?.replace(/^\//, "") ?? container.Id;

const membersOf = (volume: DockerVolume, containers: readonly ContainerSummary[]) =>
  containers.flatMap((container) =>
    (container.Mounts ?? [])
      .filter((mount) => mount.Type === MOUNT_VOLUME && mount.Name === volume.Name)
      .map((mount) => ({
        name: nameOf(container),
        running: container.State === RUNNING,
        destination: mount.Destination ?? "",
      })),
  );

const isAutohealOwn = (volume: DockerVolume) =>
  AUTOHEAL_VOLUME_PREFIXES.some((prefix) => volume.Name.startsWith(prefix)) ||
  Object.keys(volume.Labels ?? {}).some((label) => label.startsWith(AUTOHEAL_LABEL_PREFIX));

function otherToolOf(volume: DockerVolume): string | null {
  const label = Object.keys(volume.Labels ?? {}).find((each) => each.endsWith(OTHER_TOOL_LABEL_SUFFIX));
  if (label === undefined) return null;
  const domain = label.slice(0, -OTHER_TOOL_LABEL_SUFFIX.length);
  return domain;
}

/**
 * Docker's count of what volumes hold walks their files, too slow for every heartbeat: the last count is reported,
 * and a new one started when it has aged. A removal does not trust this; it counts again.
 */
export class VolumeSizes {
  private known: ReadonlyMap<string, number> = new Map();
  private countedAt: number | null = null;
  private counting = false;

  constructor(
    private readonly docker: VolumeSizer,
    private readonly clock: () => number = Date.now,
    private readonly onFailure: (problem: string) => void = () => undefined,
  ) {}

  current(): ReadonlyMap<string, number> {
    const aged = this.countedAt === null || this.clock() - this.countedAt >= VOLUME_SIZES_REFRESH_MILLISECONDS;
    if (aged && !this.counting) void this.count();
    return this.known;
  }

  private async count() {
    this.counting = true;
    try {
      this.known = await this.docker.volumeSizes();
    } catch (error) {
      this.onFailure(describeError(error));
    } finally {
      this.countedAt = this.clock();
      this.counting = false;
    }
  }
}

/** Every volume on the host, with who uses it, stopped containers too, and what made it. */
export async function volumesReport(docker: VolumeLister, sizes: ReadonlyMap<string, number>): Promise<VolumeReport[]> {
  const [volumes, containers] = await Promise.all([docker.allVolumes(), docker.containerSummaries()]);
  const projects = new Set(containers.map((container) => container.Labels?.[COMPOSE_PROJECT_LABEL]));
  return volumes.slice(0, REPORT_LIMITS.volumes).map((volume) => {
    const project = volume.Labels?.[COMPOSE_PROJECT_LABEL] ?? null;
    return {
      name: volume.Name,
      driver: volume.Driver ?? "",
      sizeBytes: sizes.get(volume.Name) ?? null,
      createdAt: volume.CreatedAt ?? "",
      nameless: volume.Labels?.[VOLUME_ANONYMOUS_LABEL] !== undefined,
      project,
      projectHere: project !== null && projects.has(project),
      own: isAutohealOwn(volume),
      ownedBy: otherToolOf(volume),
      members: membersOf(volume, containers),
    };
  });
}
