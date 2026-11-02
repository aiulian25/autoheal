import { lstat, open, readdir, readFile, readlink, stat, statfs } from "node:fs/promises";
import { cpus, machine, release } from "node:os";
import { HOST_FILE_MESSAGES } from "../shared/constants.js";

// Reading the host's own files through its read-only mount: any of them may be missing on a given host.

// A symlink counts as there, wherever it points: an absolute target would resolve in the runner's own container.
export const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** One KEY=value of /etc/os-release, its quotes taken off; null when the file or the key isn't there. */
export function osReleaseValue(osRelease: string | null, key: string): string | null {
  const prefix = `${key}=`;
  const line = osRelease?.split("\n").find((entry) => entry.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length).replace(/^["']|["']$/g, "");
}

export const readOptional = (path: string) => readFile(path, "utf8").catch(() => null);

export const listOptional = (directory: string) => readdir(directory).catch((): string[] => []);

export function numberIn(text: string | null): number | null {
  const value = Number(text);
  return text === null || text.trim() === "" || !Number.isFinite(value) ? null : value;
}

/** The end of a file, where its newest entries are; null when it isn't there. */
export async function readEnd(path: string, bytes: number): Promise<string | null> {
  const file = await open(path).catch(() => null);
  if (file === null) {
    return null;
  }
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - bytes);
    const { buffer, bytesRead } = await file.read(Buffer.alloc(size - start), 0, size - start, start);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await file.close();
  }
}

/** A path's filesystem, as `df` counts it: the device it is on, and its space (blocks reserved for root in neither). */
export interface FilesystemSpace {
  device: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
}

/** What the host is: its CPUs, the kernel it runs and its architecture. */
export interface HostSystem {
  cpuCount: number;
  kernel: string;
  architecture: string | null;
}

/**
 * How the host's files are read: through its root mounted into the runner's container, or over its SSH session.
 * Each read answers null, or nothing, for what is missing or cannot be read: a host may lack any of them.
 */
export interface HostFiles {
  readText(path: string): Promise<string | null>;
  readEnd(path: string, bytes: number): Promise<string | null>;
  list(directory: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  readlink(path: string): Promise<string | null>;
  // Milliseconds since the epoch.
  modifiedAt(path: string): Promise<number | null>;
  filesystem(path: string): Promise<FilesystemSpace | null>;
  system(): Promise<HostSystem>;
}

async function localFilesystem(path: string): Promise<FilesystemSpace | null> {
  try {
    const [status, space] = await Promise.all([stat(path), statfs(path)]);
    return {
      device: String(status.dev),
      totalBytes: space.blocks * space.bsize,
      usedBytes: (space.blocks - space.bfree) * space.bsize,
      availableBytes: space.bavail * space.bsize,
    };
  } catch {
    return null;
  }
}

/** A runner container's: the host's files under its mount, and the kernel's own /proc and /sys. */
export const LOCAL_HOST_FILES: HostFiles = {
  readText: readOptional,
  readEnd,
  list: listOptional,
  exists,
  readlink: (path) => readlink(path).catch(() => null),
  modifiedAt: (path) =>
    stat(path).then(
      (status) => status.mtimeMs,
      () => null,
    ),
  filesystem: localFilesystem,
  // The kernel is the host's own even inside a container: these are the host's CPUs, kernel and architecture.
  system: async () => ({ cpuCount: Math.max(1, cpus().length), kernel: release(), architecture: machine() }),
};

/** A file the caller cannot do without: its absence is an error, not a gap. */
export async function requiredText(files: HostFiles, path: string): Promise<string> {
  const text = await files.readText(path);
  if (text === null) {
    throw new Error(HOST_FILE_MESSAGES.unreadable(path));
  }
  return text;
}
