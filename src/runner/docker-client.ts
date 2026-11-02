import { request as httpRequest, type ClientRequestArgs, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { type Duplex, type Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInterface } from "node:readline";
import {
  RUNNER_MESSAGES,
  DOCKER_APPLICATION_TIMEOUT_MILLISECONDS,
  COMPOSE_PROJECT_LABEL,
  DOCKER_API_HOST,
  DOCKER_FLAG,
  CONTAINER_DETAILS,
  DOCKER_PATHS,
  DOCKER_PATH_PARAMETER,
  DOCKER_CLEANUP_TIMEOUT_MILLISECONDS,
  DOCKER_PULL_TIMEOUT_MILLISECONDS,
  DOCKER_REQUEST_TIMEOUT_MILLISECONDS,
  EVENT_TYPE_CONTAINER,
  HTTP_STATUS,
  JSON_CONTENT_TYPE,
  LOG_READ_LIMIT_BYTES,
  LOG_TAIL_LINES,
  REDACTION_CONTAINER_LIMIT,
  RESTART_GRACE_SECONDS,
  HTTP_HEADERS,
  DOCKER_UPGRADE,
  COMMAND_ENVIRONMENT,
  DOCKER_PATH_STAT_HEADER,
  TAR_CONTENT_TYPE,
  TERMINAL_ENVIRONMENT,
  TERMINAL_SHELL,
} from "../shared/constants.js";
import type { ContainerConfig, ContainerDetails, NetworkEndpoint } from "./incident-report.js";
import { CommandOutput, LogStreamTail } from "./log-stream.js";
import { readFirstEntry, type TarHeader } from "./tar.js";
import { splitTag } from "../shared/image-reference.js";
import type { PullLine } from "./update-progress.js";
import { LocalDockerConnection } from "./local-docker-connection.js";

export class DockerError extends Error {}

export interface StreamCommandOptions {
  input?: Readable;
  output: Writable;
  timeoutMilliseconds: number;
}

const EXEC_HEADER_BYTES = 8;
const EXEC_STDOUT = 1;
const EXEC_STDERR = 2;
const STDERR_KEPT_CHARACTERS = 2000;

/** Docker's framing of an exec's output without a terminal: an 8-byte header says whose each piece is and how long. */
class ExecFrames {
  private waiting = Buffer.alloc(0);
  private errors = "";

  constructor(private readonly output: Writable) {}

  stderr() {
    return this.errors.trim();
  }

  async readAll(socket: Readable) {
    for await (const chunk of socket) {
      this.waiting = Buffer.concat([this.waiting, chunk as Buffer]);
      await this.drain();
    }
    this.output.end();
  }

  private async drain() {
    while (this.waiting.length >= EXEC_HEADER_BYTES) {
      const size = this.waiting.readUInt32BE(4);
      if (this.waiting.length < EXEC_HEADER_BYTES + size) return;
      const kind = this.waiting[0];
      const piece = this.waiting.subarray(EXEC_HEADER_BYTES, EXEC_HEADER_BYTES + size);
      this.waiting = this.waiting.subarray(EXEC_HEADER_BYTES + size);
      if (kind === EXEC_STDERR) this.errors = `${this.errors}${piece.toString()}`.slice(-STDERR_KEPT_CHARACTERS);
      if (kind === EXEC_STDOUT && !this.output.write(piece)) await once(this.output, "drain");
    }
  }
}

export interface DockerEvent {
  Type?: string;
  Action?: string;
  Actor?: { Attributes?: { name?: string } };
}

interface Response {
  status: number;
  body: Buffer;
}

/** One row of `docker images`. */
export interface ImageSummary {
  Id: string;
  // Its names; none, or Docker's "<none>:<none>", for an image left without one.
  RepoTags?: string[] | null;
  // "ghcr.io/owner/app@sha256:…" for each registry it came from; none, or "<none>@<none>", for one built here.
  RepoDigests?: string[] | null;
  Size: number;
  // When it was built, in seconds.
  Created: number;
}

/** One row of `docker ps -a`. */
/** The parts of `docker info` Autoheal reads: its root, and its storage driver's own facts. */
export interface DockerVolume {
  Name: string;
  Driver?: string;
  CreatedAt?: string;
  Options?: Record<string, string> | null;
  Labels?: Record<string, string> | null;
}

export interface DockerInfo {
  DockerRootDir?: string;
  DriverStatus?: [string, string][] | null;
  // Since Docker 27: the containerd it uses, the host's own or one it started itself.
  Containerd?: { Address?: string } | null;
}

/** What Docker's list of networks says of each. */
export interface DockerNetwork {
  Name: string;
  Id?: string;
  Driver?: string;
  Internal?: boolean;
  Labels?: Record<string, string> | null;
  IPAM?: { Config?: { Subnet?: string; Gateway?: string }[] | null };
}

/** What `docker top` answers. */
export interface ContainerProcesses {
  Titles?: string[];
  Processes?: string[][] | null;
}

/** One layer of what `docker history` answers. */
export interface ContainerHistoryEntry {
  Created?: number;
  CreatedBy?: string;
  Size?: number;
}

export interface ContainerSummary {
  Id: string;
  Names: string[];
  // As it was created: an image reference, or an image id.
  Image?: string;
  ImageID?: string;
  State: string;
  Status: string;
  // How it was started, as one line: its entrypoint and command.
  Command?: string;
  Labels?: Record<string, string> | null;
  HostConfig?: { NetworkMode?: string };
  // Stopped ones keep theirs too, with no address.
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> | null };
  Mounts?: { Type?: string; Name?: string; Source?: string; Destination?: string }[] | null;
  // Each binding once per address family: a port published on 0.0.0.0 and :: is listed twice.
  Ports?: { IP?: string; PrivatePort: number; PublicPort?: number; Type: string }[] | null;
}

/** The parts of `docker image inspect` Autoheal reads. */
export interface ImageDetails {
  Id: string;
  Os?: string;
  Architecture?: string;
  RepoTags?: string[] | null;
  RepoDigests?: string[] | null;
  Config?: Partial<ContainerConfig> | null;
}

/** One network interface's counters in a `docker stats` sample. */
export interface NetworkStats {
  rx_bytes?: number;
  tx_bytes?: number;
  rx_dropped?: number;
  tx_dropped?: number;
}

/** The parts of a one-shot `docker stats` sample Autoheal reads. */
export interface ContainerStatsSample {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
    online_cpus?: number;
    throttling_data?: { periods?: number; throttled_periods?: number };
  };
  memory_stats?: { usage?: number; limit?: number; stats?: Record<string, number> };
  blkio_stats?: { io_service_bytes_recursive?: { op?: string; value?: number }[] | null };
  // Absent for a container on the host's network.
  networks?: Record<string, NetworkStats>;
  pids_stats?: { current?: number };
}

const isFailure = (status: number) => status >= HTTP_STATUS.badRequest;

export const stripSlash = (name: string) => name.replace(/^\//, "");

async function* parseJsonLines<Line>(response: IncomingMessage): AsyncGenerator<Line> {
  for await (const line of createInterface({ input: response, crlfDelay: Infinity })) {
    if (line.trim()) {
      yield JSON.parse(line) as Line;
    }
  }
}

async function readAll(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

const DISK_USAGE_VOLUMES = "volume";

const path = (template: string, reference: string) =>
  template.replace(DOCKER_PATH_PARAMETER, encodeURIComponent(reference));

/** A shell running in a container: its stream both ways, and what can be asked of it meanwhile. */
export interface ShellStream {
  socket: Duplex;
  resize: (columns: number, rows: number) => Promise<void>;
  // Null while it still runs.
  exitCode: () => Promise<number | null>;
}

/** How a command run in a container ended, and the first of what it printed and complained of. */
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/** Docker's stat of a path in a container; its mode carries Go's file-kind bits. */
export interface PathStat {
  name: string;
  size: number;
  mode: number;
  linkTarget: string;
}

/** A stream to a Docker engine's API: its local unix socket, or the one on an SSH host reached through a session. */
export interface DockerConnection {
  connect(): Promise<Duplex>;
}

/** Talks to a Docker engine over one connection. No business rules live here. */
export class DockerClient {
  private readonly connection: DockerConnection;

  // A path is the local engine's socket.
  constructor(connection: DockerConnection | string) {
    this.connection = typeof connection === "string" ? new LocalDockerConnection(connection) : connection;
  }

  async inspect(name: string): Promise<ContainerDetails | null> {
    const { status, body } = await this.request("GET", path(DOCKER_PATHS.container, name));
    if (status === HTTP_STATUS.notFound) {
      return null;
    }
    this.assertOk(status, body);
    return JSON.parse(body.toString()) as ContainerDetails;
  }

  /** Every network on the host, with the labels Compose gave those it made. */
  async networks(): Promise<DockerNetwork[]> {
    const { status, body } = await this.request("GET", DOCKER_PATHS.networks);
    this.assertOk(status, body);
    return JSON.parse(body.toString()) as DockerNetwork[];
  }

  /** A new network; Docker picks its addresses unless it is given them. */
  async createNetwork(specification: {
    name: string;
    driver: string;
    internal: boolean;
    subnet: string | null;
    parent: string | null;
  }): Promise<DockerNetwork> {
    const { name, driver, internal, subnet, parent } = specification;
    const { status, body } = await this.request("POST", DOCKER_PATHS.createNetwork, undefined, {
      Name: name,
      Driver: driver,
      Internal: internal,
      CheckDuplicate: true,
      ...(subnet === null ? {} : { IPAM: { Config: [{ Subnet: subnet }] } }),
      ...(parent === null ? {} : { Options: { parent } }),
    });
    this.assertOk(status, body);
    const { Id } = JSON.parse(body.toString()) as { Id: string };
    const created = await this.request("GET", path(DOCKER_PATHS.network, Id));
    this.assertOk(created.status, created.body);
    return JSON.parse(created.body.toString()) as DockerNetwork;
  }

  /** Docker refuses one with something running on it. */
  async removeNetwork(name: string): Promise<void> {
    const { status, body } = await this.request("DELETE", path(DOCKER_PATHS.network, name));
    this.assertOk(status, body);
  }

  async disconnect(network: string, container: string): Promise<void> {
    const { status, body } = await this.request("POST", path(DOCKER_PATHS.networkDisconnect, network), undefined, {
      Container: container,
    });
    this.assertOk(status, body);
  }

  /** What runs in it, in the columns asked for where the host's ps knows them. */
  async processes(name: string): Promise<ContainerProcesses | null> {
    const asked = await this.request(
      "GET",
      `${path(DOCKER_PATHS.processes, name)}?ps_args=${encodeURIComponent(CONTAINER_DETAILS.processColumns)}`,
    );
    const { status, body } =
      asked.status === HTTP_STATUS.ok ? asked : await this.request("GET", path(DOCKER_PATHS.processes, name));
    return status === HTTP_STATUS.ok ? (JSON.parse(body.toString()) as ContainerProcesses) : null;
  }

  /** The layers of an image, newest first; none when Docker no longer has it. */
  async imageHistory(reference: string): Promise<ContainerHistoryEntry[]> {
    const { status, body } = await this.request("GET", path(DOCKER_PATHS.imageHistory, reference));
    return status === HTTP_STATUS.ok ? (JSON.parse(body.toString()) as ContainerHistoryEntry[]) : [];
  }

  async inspectImage(reference: string): Promise<ImageDetails | null> {
    const { status, body } = await this.request("GET", path(DOCKER_PATHS.image, reference));
    if (status === HTTP_STATUS.notFound) {
      return null;
    }
    this.assertOk(status, body);
    return JSON.parse(body.toString()) as ImageDetails;
  }

  async containerNames(): Promise<Set<string>> {
    return new Set((await this.containerSummaries()).flatMap((container) => container.Names.map(stripSlash)));
  }

  /** The names of the containers one compose project made. */
  async composeProjectNames(project: string): Promise<Set<string>> {
    const members = (await this.containerSummaries()).filter(
      (container) => container.Labels?.[COMPOSE_PROJECT_LABEL] === project,
    );
    return new Set(members.flatMap((container) => container.Names.map(stripSlash)));
  }

  async containerSummaries(): Promise<ContainerSummary[]> {
    const { status, body } = await this.request("GET", DOCKER_PATHS.containers, { all: DOCKER_FLAG.on });
    this.assertOk(status, body);
    return JSON.parse(body.toString()) as ContainerSummary[];
  }

  /** One sample of a container's CPU and memory, without waiting for a second one; null once it is gone. */
  async statsOnce(containerId: string): Promise<ContainerStatsSample | null> {
    const query = { stream: DOCKER_FLAG.false, "one-shot": DOCKER_FLAG.true };
    const { status, body } = await this.request("GET", path(DOCKER_PATHS.stats, containerId), query);
    if (status === HTTP_STATUS.notFound) {
      return null;
    }
    this.assertOk(status, body);
    return JSON.parse(body.toString()) as ContainerStatsSample;
  }

  /**
   * Every container's environment entries, so a secret that one service lends another (a
   * database URL, an API key) is masked wherever it shows up in a log. Past the limit, only the
   * failed container's own values are used.
   */
  async allEnvironmentEntries(): Promise<string[]> {
    const names = (await this.containerSummaries()).map((container) => stripSlash(container.Names[0] ?? ""));
    if (names.length === 0 || names.length > REDACTION_CONTAINER_LIMIT) {
      return [];
    }
    const details = await Promise.all(names.map((name) => this.inspect(name).catch(() => null)));
    return details.flatMap((container) => container?.Config.Env ?? []);
  }

  /** The newest log output, bounded in memory however much the container wrote. */
  async logs(name: string, usesTty: boolean, tailLines: number = LOG_TAIL_LINES): Promise<string> {
    const query = { stdout: DOCKER_FLAG.on, stderr: DOCKER_FLAG.on, tail: String(tailLines) };
    const response = await this.open("GET", path(DOCKER_PATHS.logs, name), { query, signal: this.timeout() });
    if (isFailure(response.statusCode ?? 0)) {
      this.assertOk(response.statusCode ?? 0, await readAll(response));
    }
    const tail = new LogStreamTail(usesTty, LOG_READ_LIMIT_BYTES);
    for await (const chunk of response) {
      tail.feed(chunk as Buffer);
    }
    return tail.text();
  }

  async restart(name: string): Promise<void> {
    const query = { t: String(RESTART_GRACE_SECONDS) };
    const { status, body } = await this.request("POST", path(DOCKER_PATHS.restart, name), query);
    this.assertOk(status, body);
  }

  /** Starting a running container is no error: it is already what was asked for. */
  async start(reference: string): Promise<void> {
    const { status, body } = await this.request("POST", path(DOCKER_PATHS.start, reference));
    this.assertOk(status, body);
  }

  async stop(reference: string, graceSeconds: number): Promise<void> {
    const query = { t: String(graceSeconds) };
    const { status, body } = await this.request("POST", path(DOCKER_PATHS.stop, reference), query);
    this.assertOk(status, body);
  }

  /** Docker refuses one that is not running, or already paused: its answer says so. */
  async pause(reference: string): Promise<void> {
    const { status, body } = await this.request("POST", path(DOCKER_PATHS.pause, reference));
    this.assertOk(status, body);
  }

  async unpause(reference: string): Promise<void> {
    const { status, body } = await this.request("POST", path(DOCKER_PATHS.unpause, reference));
    this.assertOk(status, body);
  }

  async rename(reference: string, newName: string): Promise<void> {
    const query = { name: newName };
    const { status, body } = await this.request("POST", path(DOCKER_PATHS.rename, reference), query);
    this.assertOk(status, body);
  }

  /** Change only automatic restart behavior; recovery callers inspect-verify before touching data. */
  async setRestartPolicy(reference: string, policy: { Name: string; MaximumRetryCount?: number }): Promise<void> {
    const { status, body } = await this.request("POST", path(DOCKER_PATHS.update, reference), undefined, {
      RestartPolicy: {
        Name: policy.Name,
        ...(policy.MaximumRetryCount === undefined ? {} : { MaximumRetryCount: policy.MaximumRetryCount }),
      },
    });
    this.assertOk(status, body);
  }

  /** Removes the container but never its volumes: they may hold the only copy of its data. */
  async remove(reference: string, force = true): Promise<void> {
    const query: Record<string, string> = force ? { force: DOCKER_FLAG.on } : {};
    const { status, body } = await this.request("DELETE", path(DOCKER_PATHS.remove, reference), query);
    if (status !== HTTP_STATUS.notFound) {
      this.assertOk(status, body);
    }
  }

  /** For manual removal and rollback: never forced, so Docker refuses a running container; never its volumes. */
  async removeStopped(reference: string): Promise<void> {
    const { status, body } = await this.request("DELETE", path(DOCKER_PATHS.remove, reference));
    this.assertOk(status, body);
  }

  /** A shell in a running container: an exec with a terminal, its stream handed over raw as `docker exec -it` does. */
  async openShell(
    reference: string,
    columns: number,
    rows: number,
    command: readonly string[] = TERMINAL_SHELL,
  ): Promise<ShellStream> {
    const size = [rows, columns];
    const created = await this.request("POST", path(DOCKER_PATHS.execCreate, reference), undefined, {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Cmd: command,
      Env: TERMINAL_ENVIRONMENT,
      ConsoleSize: size,
    });
    this.assertOk(created.status, created.body);
    const execId = (JSON.parse(created.body.toString()) as { Id: string }).Id;
    const socket = await this.upgrade(path(DOCKER_PATHS.execStart, execId), {
      Detach: false,
      Tty: true,
      ConsoleSize: size,
    });
    return {
      socket,
      resize: async (newColumns, newRows) => {
        const query = { h: String(newRows), w: String(newColumns) };
        const { status, body } = await this.request("POST", path(DOCKER_PATHS.execResize, execId), query);
        this.assertOk(status, body);
      },
      exitCode: async () => {
        const { status, body } = await this.request("GET", path(DOCKER_PATHS.execInspect, execId));
        this.assertOk(status, body);
        const exec = JSON.parse(body.toString()) as { Running?: boolean; ExitCode?: number | null };
        return exec.Running === true ? null : (exec.ExitCode ?? null);
      },
    };
  }

  /** A command in a running container, without a terminal, given as arguments: no shell reads them. */
  async runCommand(reference: string, command: readonly string[], limitBytes: number): Promise<CommandResult> {
    const created = await this.request("POST", path(DOCKER_PATHS.execCreate, reference), undefined, {
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: command,
      Env: COMMAND_ENVIRONMENT,
    });
    this.assertOk(created.status, created.body);
    const execId = (JSON.parse(created.body.toString()) as { Id: string }).Id;
    const payload = { Detach: false, Tty: false };
    const response = await this.open("POST", path(DOCKER_PATHS.execStart, execId), { payload, signal: this.timeout() });
    if (isFailure(response.statusCode ?? 0)) {
      this.assertOk(response.statusCode ?? 0, await readAll(response));
    }
    const output = new CommandOutput(limitBytes);
    for await (const chunk of response) {
      output.feed(chunk as Buffer);
    }
    const inspected = await this.request("GET", path(DOCKER_PATHS.execInspect, execId));
    this.assertOk(inspected.status, inspected.body);
    const exitCode = (JSON.parse(inspected.body.toString()) as { ExitCode?: number | null }).ExitCode ?? null;
    return { exitCode, stdout: output.stdout(), stderr: output.stderr(), truncated: output.truncated };
  }

  /** Fixed helper command, no TTY: private material travels only on stdin, never exec args/env/labels. */
  async runInputCommand(
    reference: string,
    command: readonly string[],
    input: Buffer,
    limitBytes: number,
  ): Promise<CommandResult> {
    if (input.byteLength > 1024 * 1024) throw new DockerError("Helper input exceeds its fixed limit.");
    const created = await this.request("POST", path(DOCKER_PATHS.execCreate, reference), undefined, {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: command,
      Env: COMMAND_ENVIRONMENT,
    });
    this.assertOk(created.status, created.body);
    const execId = (JSON.parse(created.body.toString()) as { Id: string }).Id;
    const signal = AbortSignal.timeout(DOCKER_APPLICATION_TIMEOUT_MILLISECONDS);
    const socket = await this.upgrade(path(DOCKER_PATHS.execStart, execId), { Detach: false, Tty: false }, signal);
    const aborted = () => socket.destroy(new DockerError("Application helper timed out."));
    signal.addEventListener("abort", aborted, { once: true });
    const output = new CommandOutput(limitBytes);
    try {
      socket.end(input);
      for await (const chunk of socket) output.feed(chunk as Buffer);
      const inspected = await this.request("GET", path(DOCKER_PATHS.execInspect, execId));
      this.assertOk(inspected.status, inspected.body);
      const exec = JSON.parse(inspected.body.toString()) as { Running?: boolean; ExitCode?: number | null };
      return {
        exitCode: exec.Running ? null : (exec.ExitCode ?? null),
        stdout: output.stdout(),
        stderr: output.stderr(),
        truncated: output.truncated,
      };
    } finally {
      signal.removeEventListener("abort", aborted);
      socket.destroy();
    }
  }

  /**
   * A command given stdin as it comes, and read as it goes: a dump flows from one container into another without
   * being held here. Stdout goes to the writable; stderr's end comes back, for saying why it failed.
   */
  async streamCommand(
    reference: string,
    command: readonly string[],
    { input, output, timeoutMilliseconds }: StreamCommandOptions,
  ): Promise<{ exitCode: number | null; stderr: string }> {
    const created = await this.request("POST", path(DOCKER_PATHS.execCreate, reference), undefined, {
      AttachStdin: input !== undefined,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: command,
    });
    this.assertOk(created.status, created.body);
    const execId = (JSON.parse(created.body.toString()) as { Id: string }).Id;
    const socket = await this.upgrade(path(DOCKER_PATHS.execStart, execId), { Detach: false, Tty: false });
    const timer = setTimeout(() => socket.destroy(new DockerError("The command took too long.")), timeoutMilliseconds);
    const frames = new ExecFrames(output);
    try {
      const feed = async (source: Readable) => {
        for await (const chunk of source) {
          if (!socket.write(chunk as Buffer)) await once(socket, "drain");
        }
        socket.end();
      };
      const feeding =
        input === undefined ? Promise.resolve() : feed(input).catch((error: unknown) => socket.destroy(error as Error));
      await frames.readAll(socket);
      await feeding;
      const inspected = await this.request("GET", path(DOCKER_PATHS.execInspect, execId));
      this.assertOk(inspected.status, inspected.body);
      const exec = JSON.parse(inspected.body.toString()) as { Running?: boolean; ExitCode?: number | null };
      return { exitCode: exec.Running ? null : (exec.ExitCode ?? null), stderr: frames.stderr() };
    } finally {
      clearTimeout(timer);
      socket.destroy();
    }
  }

  /** Stream a ciphertext-only archive; callers own consumption and must close it on failure. */
  async getArchiveStream(reference: string, filePath: string): Promise<Readable> {
    const response = await this.open("GET", path(DOCKER_PATHS.archive, reference), {
      query: { path: filePath },
      signal: AbortSignal.timeout(DOCKER_APPLICATION_TIMEOUT_MILLISECONDS),
    });
    if (isFailure(response.statusCode ?? 0)) this.assertOk(response.statusCode ?? 0, await readAll(response));
    return response;
  }

  /** No buffering of an application's encrypted archive in the runner process. */
  async putArchiveStream(reference: string, folder: string, archive: Readable): Promise<void> {
    const signal = AbortSignal.timeout(DOCKER_APPLICATION_TIMEOUT_MILLISECONDS);
    let outgoing: ReturnType<typeof httpRequest> | undefined;
    let transfer: Promise<void> | undefined;
    try {
      const response = new Promise<void>((resolve, reject) => {
        outgoing = httpRequest(
          {
            createConnection: this.createConnection,
            host: DOCKER_API_HOST,
            method: "PUT",
            path: path(DOCKER_PATHS.archive, reference) + "?" + new URLSearchParams({ path: folder }),
            headers: { [HTTP_HEADERS.contentType]: TAR_CONTENT_TYPE },
            signal,
          },
          (incoming) => {
            void readAll(incoming)
              .then((body) => {
                this.assertOk(incoming.statusCode ?? 0, body);
                resolve();
              }, reject)
              .catch(reject);
          },
        );
        outgoing.on("error", reject);
        transfer = pipeline(archive, outgoing);
        void transfer.catch(reject);
      });
      await Promise.all([response, transfer]);
    } catch (error) {
      archive.destroy();
      outgoing?.destroy();
      throw error;
    }
  }

  /** What is at a path in a container, or null when nothing is. */
  async pathStat(reference: string, filePath: string): Promise<PathStat | null> {
    const query = { path: filePath };
    const response = await this.open("HEAD", path(DOCKER_PATHS.archive, reference), { query, signal: this.timeout() });
    response.resume();
    if (response.statusCode === HTTP_STATUS.notFound) {
      return null;
    }
    this.assertOk(response.statusCode ?? 0, Buffer.alloc(0));
    const stat = String(response.headers[DOCKER_PATH_STAT_HEADER] ?? "");
    return JSON.parse(Buffer.from(stat, "base64").toString()) as PathStat;
  }

  /**
   * The first entry of a path's archive: its header (owner, mode, kind), and a file's content up to the limit.
   * Only that much is read of a folder's archive, however big the folder. Null when nothing is at the path.
   */
  async readEntry(
    reference: string,
    filePath: string,
    limitBytes: number,
  ): Promise<{ header: TarHeader; content: Buffer | null } | null> {
    const query = { path: filePath };
    const response = await this.open("GET", path(DOCKER_PATHS.archive, reference), { query, signal: this.timeout() });
    if (response.statusCode === HTTP_STATUS.notFound) {
      response.resume();
      return null;
    }
    if (isFailure(response.statusCode ?? 0)) {
      this.assertOk(response.statusCode ?? 0, await readAll(response));
    }
    try {
      return await readFirstEntry(response, limitBytes);
    } finally {
      response.destroy();
    }
  }

  /** Unpacks an archive into a folder of a container, as the archive's headers say (owner and mode). */
  async putArchive(reference: string, folder: string, archive: Buffer): Promise<void> {
    const query = { path: folder };
    const response = await this.open("PUT", path(DOCKER_PATHS.archive, reference), {
      query,
      archive,
      signal: this.timeout(),
    });
    this.assertOk(response.statusCode ?? 0, await readAll(response));
  }

  /** Returns the new container's id. */
  async create(name: string, specification: Record<string, unknown>): Promise<string> {
    const { status, body } = await this.request("POST", DOCKER_PATHS.create, { name }, specification);
    this.assertOk(status, body);
    return (JSON.parse(body.toString()) as { Id: string }).Id;
  }

  async connect(network: string, container: string, endpoint: NetworkEndpoint): Promise<void> {
    const specification = { Container: container, EndpointConfig: endpoint };
    const { status, body } = await this.request("POST", path(DOCKER_PATHS.connect, network), {}, specification);
    this.assertOk(status, body);
  }

  /** Gives an image (by id or reference) one more name; a name it already had moves to it. */
  async tag(source: string, repository: string, tag: string): Promise<void> {
    const query = { repo: repository, tag };
    const { status, body } = await this.request("POST", path(DOCKER_PATHS.tag, source), query);
    this.assertOk(status, body);
  }

  /** Never forced: Docker refuses an image a container still uses, or one with other names. */
  async removeImage(reference: string): Promise<void> {
    const { status, body } = await this.request("DELETE", path(DOCKER_PATHS.removeImage, reference));
    this.assertOk(status, body);
  }

  /** Where the engine keeps what it stores, and how: what `docker info` says of its storage. */
  async info(): Promise<DockerInfo> {
    const { status, body } = await this.request("GET", DOCKER_PATHS.info);
    this.assertOk(status, body);
    return JSON.parse(body.toString()) as DockerInfo;
  }

  /** The engine's own version, as `docker version` says it. */
  async version(): Promise<string> {
    const { status, body } = await this.request("GET", DOCKER_PATHS.version);
    this.assertOk(status, body);
    return (JSON.parse(body.toString()) as { Version: string }).Version;
  }

  async images(): Promise<ImageSummary[]> {
    const { status, body } = await this.request("GET", DOCKER_PATHS.images);
    this.assertOk(status, body);
    return JSON.parse(body.toString()) as ImageSummary[];
  }

  async createVolume(
    name: string,
    labels: Record<string, string>,
    driverOptions: Record<string, string> = {},
  ): Promise<void> {
    const { status, body } = await this.request("POST", DOCKER_PATHS.volumeCreate, undefined, {
      Name: name,
      Labels: labels,
      DriverOpts: driverOptions,
    });
    this.assertOk(status, body);
  }

  /** Gone already counts as removed. */
  async removeVolume(name: string): Promise<void> {
    const { status, body } = await this.request("DELETE", path(DOCKER_PATHS.volume, name));
    if (status !== HTTP_STATUS.notFound) {
      this.assertOk(status, body);
    }
  }

  /** Driver/options must be inspected before delegated access can trust a named volume's boundary. */
  async inspectVolume(name: string): Promise<DockerVolume | null> {
    const { status, body } = await this.request("GET", path(DOCKER_PATHS.volume, name));
    if (status === HTTP_STATUS.notFound) return null;
    this.assertOk(status, body);
    return JSON.parse(body.toString()) as DockerVolume;
  }

  async allVolumes(): Promise<DockerVolume[]> {
    const { status, body } = await this.request("GET", DOCKER_PATHS.volumes);
    this.assertOk(status, body);
    return (JSON.parse(body.toString()) as { Volumes?: DockerVolume[] | null }).Volumes ?? [];
  }

  /** What each volume holds, in bytes, as Docker counts it: it walks their files, so it may take a while. */
  async volumeSizes(): Promise<ReadonlyMap<string, number>> {
    const { status, body } = await this.request("GET", DOCKER_PATHS.diskUsage, { type: DISK_USAGE_VOLUMES });
    this.assertOk(status, body);
    const { Volumes } = JSON.parse(body.toString()) as {
      Volumes?: { Name: string; UsageData?: { Size?: number } | null }[] | null;
    };
    // Docker says -1 for what it has not counted: that is not known, and certainly not empty.
    return new Map(
      (Volumes ?? []).flatMap(({ Name, UsageData }) =>
        (UsageData?.Size ?? -1) < 0 ? [] : [[Name, UsageData!.Size!] as const],
      ),
    );
  }

  /** The volumes with this label, as `key=value` or just `key`. */
  async volumes(label: string): Promise<DockerVolume[]> {
    const filters = JSON.stringify({ label: [label] });
    const { status, body } = await this.request("GET", DOCKER_PATHS.volumes, { filters });
    this.assertOk(status, body);
    return (JSON.parse(body.toString()) as { Volumes?: DockerVolume[] | null }).Volumes ?? [];
  }

  /** Clears the build cache no build is using; answers how many bytes that freed. */
  async pruneBuildCache(): Promise<number> {
    const signal = AbortSignal.timeout(DOCKER_CLEANUP_TIMEOUT_MILLISECONDS);
    const response = await this.open("POST", DOCKER_PATHS.pruneBuildCache, { query: { all: DOCKER_FLAG.on }, signal });
    const body = await readAll(response);
    this.assertOk(response.statusCode ?? 0, body);
    return (JSON.parse(body.toString()) as { SpaceReclaimed?: number }).SpaceReclaimed ?? 0;
  }

  /** Pulls an image by reference, following Docker's progress stream to its end or first error. */
  /** Pulls the image behind the tag; each line Docker streams about it goes to `onLine` as it comes. */
  async pull(reference: string, onLine: (line: PullLine) => void = () => undefined): Promise<void> {
    const digestAt = reference.indexOf("@");
    const { name, tag } =
      digestAt < 0 ? splitTag(reference) : { name: reference.slice(0, digestAt), tag: reference.slice(digestAt + 1) };
    const query = { fromImage: name, tag };
    const signal = AbortSignal.timeout(DOCKER_PULL_TIMEOUT_MILLISECONDS);
    const response = await this.open("POST", DOCKER_PATHS.pull, { query, signal });
    if (isFailure(response.statusCode ?? 0)) {
      this.assertOk(response.statusCode ?? 0, await readAll(response));
    }
    for await (const line of parseJsonLines<PullLine & { error?: string }>(response)) {
      if (line.error !== undefined) {
        throw new DockerError(RUNNER_MESSAGES.dockerError(HTTP_STATUS.ok, line.error));
      }
      onLine(line);
    }
  }

  /**
   * Opens the event stream (so the caller knows it is connected) and returns its container events,
   * which end when the engine closes the stream or the signal aborts it. No timeout: it is meant
   * to stay open for as long as the runner runs.
   */
  async events(signal?: AbortSignal): Promise<AsyncIterable<DockerEvent>> {
    const filters = JSON.stringify({ type: [EVENT_TYPE_CONTAINER] });
    const response = await this.open("GET", DOCKER_PATHS.events, { query: { filters }, signal });
    if (isFailure(response.statusCode ?? 0)) {
      response.resume();
      throw new DockerError(RUNNER_MESSAGES.dockerError(response.statusCode ?? 0, ""));
    }
    return parseJsonLines<DockerEvent>(response);
  }

  // No agent: each request opens its own stream and closes it, so none waits in a pool on a channel the session dropped.
  private readonly createConnection: NonNullable<ClientRequestArgs["createConnection"]> = (_options, created) => {
    this.connection.connect().then(
      (stream) => created(null, stream),
      (error: Error) => created(error, undefined as never),
    );
    return undefined;
  };

  private assertOk(status: number, body: Buffer) {
    if (isFailure(status)) {
      throw new DockerError(RUNNER_MESSAGES.dockerError(status, body.toString()));
    }
  }

  private timeout() {
    return AbortSignal.timeout(DOCKER_REQUEST_TIMEOUT_MILLISECONDS);
  }

  private async request(
    method: string,
    requestPath: string,
    query?: Record<string, string>,
    payload?: unknown,
  ): Promise<Response> {
    const response = await this.open(method, requestPath, { query, payload, signal: this.timeout() });
    return { status: response.statusCode ?? 0, body: await readAll(response) };
  }

  // Docker answers 101 and hands the connection over: bytes both ways, as the shell reads and prints them. Any
  // other answer is a refusal, which says why (the container stopped, say).
  private upgrade(requestPath: string, payload: unknown, signal?: AbortSignal): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest({
        createConnection: this.createConnection,
        host: DOCKER_API_HOST,
        method: "POST",
        path: requestPath,
        ...(signal ? { signal } : {}),
        headers: {
          [HTTP_HEADERS.contentType]: JSON_CONTENT_TYPE,
          [HTTP_HEADERS.connection]: DOCKER_UPGRADE.connection,
          [HTTP_HEADERS.upgrade]: DOCKER_UPGRADE.upgrade,
        },
      });
      outgoing.on("upgrade", (_response, socket, head) => {
        if (head.length > 0) {
          socket.unshift(head);
        }
        resolve(socket);
      });
      outgoing.on("response", (response) => {
        void readAll(response).then((body) =>
          reject(new DockerError(RUNNER_MESSAGES.dockerError(response.statusCode ?? 0, body.toString()))),
        );
      });
      outgoing.on("error", reject);
      outgoing.end(JSON.stringify(payload));
    });
  }

  private open(
    method: string,
    requestPath: string,
    options: {
      query?: Record<string, string> | undefined;
      payload?: unknown;
      archive?: Buffer;
      signal?: AbortSignal | undefined;
    },
  ): Promise<IncomingMessage> {
    const search = options.query === undefined ? "" : `?${new URLSearchParams(options.query)}`;
    const json = options.payload === undefined ? null : JSON.stringify(options.payload);
    const body = options.archive ?? json;
    const contentType = options.archive === undefined ? JSON_CONTENT_TYPE : TAR_CONTENT_TYPE;
    const headers = body === null ? {} : { [HTTP_HEADERS.contentType]: contentType };
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(
        {
          createConnection: this.createConnection,
          host: DOCKER_API_HOST,
          method,
          path: `${requestPath}${search}`,
          headers,
          signal: options.signal,
        },
        resolve,
      );
      outgoing.on("error", reject);
      outgoing.end(body ?? undefined);
    });
  }
}
