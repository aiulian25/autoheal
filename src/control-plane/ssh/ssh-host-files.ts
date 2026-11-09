import type { FileEntryWithStats, SFTPWrapper, Stats } from "ssh2";
import type { HostCommand } from "../../runner/gpu-metrics.js";
import type { FilesystemSpace, HostFiles, HostSystem } from "../../runner/host-files.js";
import { COMMAND_NOT_FOUND, MILLISECONDS_PER_SECOND, SSH_HOST_FILES } from "../../shared/constants.js";
import type { SshSession } from "./ssh-session.js";

// One argument for the host's shell, whatever it holds: in single quotes, each of its own quotes closed and escaped.
export const shellQuoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

const commandFailed = (command: string, exitCode: number | null) =>
  Object.assign(new Error(`${command} exited with ${exitCode}`), {
    code: exitCode === SSH_HOST_FILES.commandNotFoundExit ? COMMAND_NOT_FOUND : undefined,
  });

/** Runs a command on the host over its session, as `runLocally` runs one here. */
export const sshHostCommand =
  (session: SshSession): HostCommand =>
  async (command, commandArguments, timeout) => {
    const line = [command, ...commandArguments.map(shellQuoted)].join(" ");
    const result = await session.exec(line, timeout, command);
    if (result.exitCode !== 0) throw commandFailed(command, result.exitCode);
    return result.stdout;
  };

/** `df -P -B1`'s line for one path: the device it is on and its space, in bytes. */
export function parseDiskFree(output: string): FilesystemSpace | null {
  const columns = output.trim().split("\n")[1]?.trim().split(/\s+/) ?? [];
  const { device, total, used, available } = SSH_HOST_FILES.diskFreeColumns;
  const numbers = [total, used, available].map((column) => Number(columns[column]));
  if (columns[device] === undefined || numbers.some((value) => !Number.isFinite(value))) {
    return null;
  }
  const [totalBytes = 0, usedBytes = 0, availableBytes = 0] = numbers;
  return { device: columns[device], totalBytes, usedBytes, availableBytes };
}

/**
 * The host's clock as its `date` gives it, in milliseconds since the epoch. A date without %N gives whole seconds,
 * which is read as the middle of its second.
 */
export function clockReadingOf(output: string): number | null {
  const reading = SSH_HOST_FILES.clockReading.exec(output.trim());
  if (reading === null) {
    return null;
  }
  const withinSecond =
    reading[2] === undefined ? MILLISECONDS_PER_SECOND / 2 : Number(`0.${reading[2]}`) * MILLISECONDS_PER_SECOND;
  return Number(reading[1]) * MILLISECONDS_PER_SECOND + withinSecond;
}

/**
 * An SSH host's files, read over its session as the host's user: by SFTP, one channel kept open for every read,
 * and a filesystem's space by `df`. What the user cannot read reads as missing, as a missing file would.
 */
export class SshHostFiles implements HostFiles {
  private channel: Promise<SFTPWrapper> | null = null;
  // Kept once known: a machine does not change architecture.
  private architecture: string | null = null;

  constructor(
    private readonly session: SshSession,
    private readonly timeoutMilliseconds: number = SSH_HOST_FILES.commandTimeoutMilliseconds,
  ) {}

  // Past its ceiling it reads as unreadable, never as a file cut short. /proc files report no size, so it is counted.
  readText(path: string): Promise<string | null> {
    return this.read<string>((sftp, done) => {
      const limit = SSH_HOST_FILES.textFileBytes;
      const chunks: Buffer[] = [];
      let bytes = 0;
      const stream = sftp.createReadStream(path, { start: 0, end: limit });
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        chunks.push(chunk);
      });
      stream.once("error", (error: Error) => done(error, ""));
      stream.once("end", () => {
        if (bytes > limit) done(new Error(path), "");
        else done(null, Buffer.concat(chunks).toString("utf8"));
      });
    });
  }

  async readEnd(path: string, bytes: number): Promise<string | null> {
    const opening = this.sftp();
    const sftp = await opening.catch(() => null);
    if (sftp === null) return null;
    return this.withinDeadline(opening, sftp, this.readEndOf(sftp, path, bytes));
  }

  private async readEndOf(sftp: SFTPWrapper, path: string, bytes: number): Promise<string | null> {
    const handle = await new Promise<Buffer | null>((resolve) =>
      sftp.open(path, "r", (error, opened) => resolve(error ? null : opened)),
    );
    if (handle === null) return null;
    try {
      const size = await new Promise<number>((resolve, reject) =>
        sftp.fstat(handle, (error, stats) => (error ? reject(error) : resolve(stats.size))),
      );
      const start = Math.max(0, size - bytes);
      const buffer = Buffer.alloc(size - start);
      const read = await new Promise<number>((resolve, reject) =>
        sftp.read(handle, buffer, 0, buffer.length, start, (error, bytesRead) =>
          error ? reject(error) : resolve(bytesRead),
        ),
      );
      return buffer.toString("utf8", 0, read);
    } catch {
      return null;
    } finally {
      sftp.close(handle, () => undefined);
    }
  }

  async list(directory: string): Promise<string[]> {
    const entries = await this.read<FileEntryWithStats[]>((sftp, done) => sftp.readdir(directory, done));
    return entries?.map(({ filename }) => filename) ?? [];
  }

  async exists(path: string): Promise<boolean> {
    return (await this.read<Stats>((sftp, done) => sftp.lstat(path, done))) !== null;
  }

  readlink(path: string): Promise<string | null> {
    return this.read((sftp, done) => sftp.readlink(path, done));
  }

  async modifiedAt(path: string): Promise<number | null> {
    const status = await this.read<Stats>((sftp, done) => sftp.stat(path, done));
    return status === null ? null : status.mtime * MILLISECONDS_PER_SECOND;
  }

  async filesystem(path: string): Promise<FilesystemSpace | null> {
    const result = await this.session
      .exec(SSH_HOST_FILES.diskFree(shellQuoted(path)), SSH_HOST_FILES.commandTimeoutMilliseconds)
      .catch(() => null);
    return result === null || result.exitCode !== 0 ? null : parseDiskFree(result.stdout);
  }

  async system(): Promise<HostSystem> {
    const [cpuTimes, kernel, architecture] = await Promise.all([
      this.readText(SSH_HOST_FILES.cpuTimesFile),
      this.readText(SSH_HOST_FILES.kernelFile),
      this.architectureOf(),
    ]);
    return {
      cpuCount: Math.max(1, cpuTimes?.match(SSH_HOST_FILES.cpuLine)?.length ?? 0),
      kernel: kernel?.trim() ?? "",
      architecture,
    };
  }

  // Its `date` set against this machine's clock halfway through the asking: it answered somewhere in that round trip.
  async clockOffset(): Promise<number | null> {
    const askedAt = Date.now();
    const result = await this.session
      .exec(SSH_HOST_FILES.clockCommand, SSH_HOST_FILES.commandTimeoutMilliseconds)
      .catch(() => null);
    const answeredAt = Date.now();
    const reading = result === null || result.exitCode !== 0 ? null : clockReadingOf(result.stdout);
    return reading === null ? null : Math.round(reading - (askedAt + answeredAt) / 2);
  }

  private async architectureOf(): Promise<string | null> {
    this.architecture ??=
      ((await this.readText(SSH_HOST_FILES.architectureFile)) ?? (await this.askArchitecture())).trim() || null;
    return this.architecture;
  }

  private askArchitecture(): Promise<string> {
    return this.session.exec(SSH_HOST_FILES.architectureCommand, SSH_HOST_FILES.commandTimeoutMilliseconds).then(
      (result) => (result.exitCode === 0 ? result.stdout : ""),
      () => "",
    );
  }

  // One SFTP channel for every read; a new one once the session drops it.
  private sftp(): Promise<SFTPWrapper> {
    if (this.channel === null) {
      const opening = this.session.sftp();
      this.channel = opening;
      const forget = () => {
        if (this.channel === opening) this.channel = null;
      };
      opening.then((sftp) => sftp.once("close", forget), forget);
    }
    return this.channel;
  }

  // Null for what is missing or unreadable, and while the session is down.
  private async read<Value>(
    request: (sftp: SFTPWrapper, done: (error: Error | undefined | null, value: Value) => void) => void,
  ): Promise<Value | null> {
    const opening = this.sftp();
    const sftp = await opening.catch(() => null);
    if (sftp === null) return null;
    return this.withinDeadline(
      opening,
      sftp,
      new Promise((resolve) => request(sftp, (error, value) => resolve(error ? null : value))),
    );
  }

  // A request the host never answers ends its channel, for every read waiting on it: the next one opens a new one.
  private withinDeadline<Value>(
    opening: Promise<SFTPWrapper>,
    sftp: SFTPWrapper,
    work: Promise<Value | null>,
  ): Promise<Value | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.channel === opening) this.channel = null;
        sftp.end();
        resolve(null);
      }, this.timeoutMilliseconds);
      void work.then((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }
}
