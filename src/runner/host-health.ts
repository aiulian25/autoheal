import { join } from "node:path";
import {
  BOOT_ID_PATTERN,
  BYTES_PER_KIBIBYTE,
  CPU_MODEL_PATTERNS,
  HOST_DISK_LIMIT,
  HOST_FILES,
  HOST_TEXT_LIMIT,
  IMAGE_STORE,
  LOAD_AVERAGE_PERIODS,
  MEMINFO_KEYS,
  OS_RELEASE_NAME_KEY,
  PROCESS_DIRECTORY_PATTERN,
  PROC_FILES,
  PROC_ROOT,
  ROOT_FILESYSTEM,
  SYS_ROOT,
  UPDATES_AVAILABLE_PATTERN,
  type HostPackagesSetting,
} from "../shared/constants.js";
import type { HostHealth } from "../shared/protocol.js";
import type { DockerInfo } from "./docker-client.js";
import { hostAddress } from "./host-address.js";
import { localFilesystems, readDrives } from "./host-drives.js";
import { LOCAL_HOST_FILES, osReleaseValue, requiredText, type HostFiles } from "./host-files.js";
import { cpuTemperatures } from "./host-sensors.js";
import { readPackageFacts } from "./package-facts.js";

interface HostHealthSettings {
  // The host's own filesystem, mounted read-only into the runner's container.
  hostRoot: string;
  // Paths on the host whose filesystems to report, e.g. "/" and "/mnt/data"; none for every local disk.
  filesystems: readonly string[];
  // /proc is the host's for load, memory and uptime even inside a container, and /sys for its sensors;
  // tests point them elsewhere.
  procRoot?: string;
  sysRoot?: string;
  // HOST_PACKAGES from the host's .env, reported with what its files say about its packages.
  packages: HostPackagesSetting;
  // How the host's files are read; its mount here unless given.
  files?: HostFiles;
}

function bootIdOf(text: string | null): string | null {
  const bootId = text?.trim() ?? "";
  return BOOT_ID_PATTERN.test(bootId) ? bootId : null;
}

type DiskUsage = HostHealth["disks"][number];

export function meminfoBytes(meminfo: string, key: string): number {
  const kibibytes = new RegExp(`^${key}:\\s+(\\d+) kB$`, "m").exec(meminfo)?.[1];
  return kibibytes === undefined ? 0 : Number(kibibytes) * BYTES_PER_KIBIBYTE;
}

// Ubuntu's update-notifier writes "12 updates can be applied immediately."; other systems have no such file.
function pendingUpdatesOf(notice: string | null): number | null {
  const count = notice === null ? undefined : UPDATES_AVAILABLE_PATTERN.exec(notice)?.[1];
  return count === undefined ? null : Number(count);
}

// Used and available as `df` counts them: blocks reserved for root are in neither.
async function diskUsage(hostRoot: string, path: string, files: HostFiles): Promise<DiskUsage | null> {
  const space = await files.filesystem(join(hostRoot, path));
  return space === null
    ? null
    : {
        path: path.slice(0, HOST_TEXT_LIMIT),
        totalBytes: space.totalBytes,
        usedBytes: space.usedBytes,
        availableBytes: space.availableBytes,
      };
}

const cpuModelOf = (cpuinfo: string | null) =>
  CPU_MODEL_PATTERNS.map((pattern) => pattern.exec(cpuinfo ?? "")?.[1]?.trim())
    .find(Boolean)
    ?.slice(0, HOST_TEXT_LIMIT) ?? null;

const textOf = (file: string | null) => file?.trim().slice(0, HOST_TEXT_LIMIT) || null;

// Every process on the host: the numbered entries of its /proc. None means it is not the host's /proc.
async function processCount(procDirectory: string, files: HostFiles): Promise<number | null> {
  const entries = await files.list(procDirectory);
  return entries.filter((entry) => PROCESS_DIRECTORY_PATTERN.test(entry)).length || null;
}

const deviceOf = async (path: string, files: HostFiles) => (await files.filesystem(path))?.device ?? null;

// A disk the host mounted after the runner started is not in its view: its path still shows the disk under it.
async function inView(paths: readonly string[], host: (file: string) => string, files: HostFiles): Promise<string[]> {
  const rootDevice = await deviceOf(host(ROOT_FILESYSTEM), files);
  const devices = await Promise.all(paths.map((path) => deviceOf(host(path), files)));
  return paths.filter(
    (path, index) => path === ROOT_FILESYSTEM || (devices[index] !== null && devices[index] !== rootDevice),
  );
}

// The ones HOST_FILESYSTEMS lists; else every local disk in the host's mount table, or / without one.
async function filesystemsOf(
  settings: HostHealthSettings,
  host: (file: string) => string,
  files: HostFiles,
): Promise<readonly string[]> {
  if (settings.filesystems.length > 0) {
    return settings.filesystems.slice(0, HOST_DISK_LIMIT);
  }
  const mountTable = await files.readText(host(HOST_FILES.mountTable));
  const found = mountTable === null ? [] : await inView(localFilesystems(mountTable), host, files);
  return found.length > 0 ? found : [ROOT_FILESYSTEM];
}

/** Where Docker keeps its images, so a full disk can say what they take there; null when Docker does not say. */
export function imageStoreOf(info: DockerInfo): string | null {
  const throughContainerd = (info.DriverStatus ?? []).some(
    ([key, value]) => key === IMAGE_STORE.driverTypeKey && value === IMAGE_STORE.containerdSnapshotter,
  );
  const address = info.Containerd?.Address;
  const ownContainerd = address !== undefined && address !== IMAGE_STORE.systemContainerdAddress;
  if (throughContainerd && !ownContainerd) {
    return IMAGE_STORE.containerdRoot;
  }
  return info.DockerRootDir?.slice(0, HOST_TEXT_LIMIT) ?? null;
}

/** The host's load, memory, uptime and disks, plus the signals it leaves on disk for a reboot or updates. */
export async function readHostHealth(settings: HostHealthSettings): Promise<HostHealth> {
  const files = settings.files ?? LOCAL_HOST_FILES;
  const proc = (file: string) => join(settings.procRoot ?? PROC_ROOT, file);
  const [loadAverage, meminfo, uptime, bootId, cpuinfo, system] = await Promise.all([
    requiredText(files, proc(PROC_FILES.loadAverage)),
    requiredText(files, proc(PROC_FILES.memory)),
    requiredText(files, proc(PROC_FILES.uptime)),
    files.readText(proc(PROC_FILES.bootId)),
    files.readText(proc(PROC_FILES.cpuInfo)),
    files.system(),
  ]);
  const hostMounted = await files.exists(settings.hostRoot);
  const host = (file: string) => join(settings.hostRoot, file);
  const sysRoot = settings.sysRoot ?? SYS_ROOT;
  const filesystems = hostMounted ? await filesystemsOf(settings, host, files) : [];
  const disks = await Promise.all(filesystems.map((path) => diskUsage(settings.hostRoot, path, files)));
  const drives = await readDrives(sysRoot, hostMounted ? settings.hostRoot : null, files);
  return {
    cpuCount: system.cpuCount,
    loadAverage: loadAverage.trim().split(/\s+/).slice(0, LOAD_AVERAGE_PERIODS).map(Number),
    memoryTotalBytes: meminfoBytes(meminfo, MEMINFO_KEYS.total),
    memoryAvailableBytes: meminfoBytes(meminfo, MEMINFO_KEYS.available),
    uptimeSeconds: Number(uptime.trim().split(/\s+/)[0]),
    disks: disks.filter((disk) => disk !== null),
    rebootRequired: hostMounted ? await files.exists(host(HOST_FILES.rebootRequired)) : null,
    pendingUpdates: hostMounted ? pendingUpdatesOf(await files.readText(host(HOST_FILES.updatesAvailable))) : null,
    operatingSystem: hostMounted
      ? (osReleaseValue(await files.readText(host(HOST_FILES.osRelease)), OS_RELEASE_NAME_KEY)?.slice(
          0,
          HOST_TEXT_LIMIT,
        ) ?? null)
      : null,
    kernel: system.kernel.slice(0, HOST_TEXT_LIMIT),
    bootId: bootIdOf(bootId),
    packages: hostMounted
      ? await readPackageFacts({
          hostRoot: settings.hostRoot,
          setting: settings.packages,
          runningKernel: system.kernel,
          files,
        })
      : null,
    hostname: hostMounted ? textOf(await files.readText(host(HOST_FILES.hostname))) : null,
    ...(system.architecture === null ? {} : { architecture: system.architecture.slice(0, HOST_TEXT_LIMIT) }),
    cpuModel: cpuModelOf(cpuinfo),
    processes: hostMounted ? await processCount(host(HOST_FILES.processes), files) : null,
    driveTemperatures: drives.temperatures,
    drives: drives.health,
    address: hostMounted ? await hostAddress(host, files) : null,
    cpuTemperatures: await cpuTemperatures(sysRoot, files),
  };
}
