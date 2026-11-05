import { mkdtempSync, rmSync } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Readable, type Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ContainerStatsSample,
  ContainerSummary,
  DockerEvent,
  DockerVolume,
  ImageSummary,
} from "../../src/runner/docker-client.js";
import type { ContainerDetails } from "../../src/runner/incident-report.js";
import { readFirstEntry, singleEntryArchive } from "../../src/runner/tar.js";
import { GO_FILE_MODE, TAR } from "../../src/shared/constants.js";
import { sha256Hex } from "../../src/shared/hash.js";

const STDOUT = 1;
const CURSOR_ANSWER = /\u001b\[\d+;\d+R/;
const BUSYBOX_ESCAPE_MILLISECONDS = 50;
const STDERR = 2;
const frame = (text: string, stream = STDOUT) => {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

/** What a container is created with: the parts the fake keeps. */
export interface CreateSpecification {
  Image: string;
  Env?: string[];
  Labels?: Record<string, string>;
  Tty?: boolean;
  HostConfig?: ContainerDetails["HostConfig"];
}

/** A file or folder in a fake container, as its archive calls see it. */
export interface FakeFile {
  folder: boolean;
  content: Buffer;
  mode: number;
  uid: number;
  gid: number;
}

/** A command run without a terminal: what it prints, complains of, and exits with. */
export interface FakeCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export const exitedContainer = (name: string, overrides: Partial<ContainerDetails> = {}): ContainerDetails => ({
  Name: `/${name}`,
  RestartCount: 0,
  State: { Status: "exited", Running: false, ExitCode: 1, OOMKilled: false, Error: "" },
  Config: { Image: `example/${name}:1`, Tty: false, Env: [] },
  ...overrides,
});

// Like Docker's: 64 hex characters, stable for a name so tests can predict it.
export const containerIdOf = (name: string) => sha256Hex(name);

function stateOf(container: ContainerDetails): string {
  if (container.State.Restarting) {
    return "restarting";
  }
  if (container.State.Running) {
    return "running";
  }
  return container.State.Status ?? "exited";
}

// How `docker ps` writes health into its status text.
const HEALTH_IN_STATUS: Record<string, string> = {
  starting: " (health: starting)",
  healthy: " (healthy)",
  unhealthy: " (unhealthy)",
};

function statusOf(container: ContainerDetails): string {
  if (!container.State.Running) {
    return `Exited (${container.State.ExitCode ?? 0}) 1 minute ago`;
  }
  return `Up 2 hours${HEALTH_IN_STATUS[container.State.Health?.Status ?? ""] ?? ""}`;
}

/** The parts of the Docker Engine API the runner uses, on a real unix socket. */
export class FakeDockerEngine {
  readonly volumes = new Map<string, DockerVolume>();
  readonly containers = new Map<string, ContainerDetails>();
  readonly logs = new Map<string, string>();
  readonly stats = new Map<string, ContainerStatsSample>();
  readonly restarts: string[] = [];
  // Holds a restart's answer until it settles, for a test that needs a runner's work still going.
  restartHeldUntil: Promise<void> = Promise.resolve();
  readonly stops: string[] = [];
  // Each container created: the name asked for and what it was created with.
  readonly creations: { name: string; specification: CreateSpecification }[] = [];
  readonly inspected: string[] = [];
  // Each removal asked for: the container's name and the query it came with.
  readonly removals: string[] = [];
  // What each container publishes, as Docker's listing gives it.
  readonly ports = new Map<string, ContainerSummary["Ports"]>();
  readonly images: ImageSummary[] = [];
  // Each image's labels by its id, as `docker image inspect` gives them, and every image inspected.
  readonly imageLabels = new Map<string, Record<string, string>>();
  readonly imagesInspected: string[] = [];
  // Which image a tag points at, by its id; a tag not here is its own id. A pull moves the tags listed below.
  readonly imageIds = new Map<string, string>();
  readonly tagsMovedOnPull = new Map<string, string>();
  // Images whose containers exit as soon as they start, by id.
  readonly failingImages = new Set<string>();
  // How much a build cache clean-up frees, and the query of each one asked for.
  buildCacheBytes = 0;
  readonly buildCachePrunes: string[] = [];
  // Each image pulled, as `name:tag`; a pull streams one progress line for a layer, then its status.
  readonly pulls: string[] = [];
  // What a pull was given for a private registry, as Docker reads it: by image, decoded from its own header.
  readonly pullCredentials = new Map<string, { username: string; password: string; serveraddress: string }>();
  private readonly streams = new Set<ServerResponse>();
  // Each exec asked for: the container it runs in, its command and whether it has a terminal (a shell), the
  // sizes it was given, and how it ended.
  readonly execs = new Map<
    string,
    {
      container: string;
      command: string[];
      tty: boolean;
      environment: string[];
      sizes: string[];
      exitCode: number | null;
    }
  >();
  // A command's result, by the command; each runs successfully and quietly unless said otherwise.
  commandResult: (command: string[]) => FakeCommandResult = () => ({ stdout: "", stderr: "", exitCode: 0 });
  // Each container's files by path, as Docker's archive calls reach them.
  readonly files = new Map<string, Map<string, FakeFile>>();
  private readonly directory = mkdtempSync(join(tmpdir(), "autoheal-docker-"));
  readonly socketPath = join(this.directory, "docker.sock");
  private server: Server | null = null;

  static async start(): Promise<FakeDockerEngine> {
    const engine = new FakeDockerEngine();
    engine.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on(
        "end",
        () =>
          void engine.route(request.method ?? "", request.url ?? "", Buffer.concat(chunks), response, request.headers),
      );
    });
    engine.server.on("upgrade", (request: IncomingMessage, socket: Duplex) => engine.shell(request, socket));
    await new Promise<void>((resolve) => engine.server!.listen(engine.socketPath, resolve));
    return engine;
  }

  add(container: ContainerDetails, logs = "") {
    const name = container.Name.replace(/^\//, "");
    this.containers.set(name, container);
    this.logs.set(name, logs);
  }

  remove(name: string) {
    this.containers.delete(name);
  }

  emit(event: DockerEvent) {
    for (const stream of this.streams) {
      stream.write(`${JSON.stringify(event)}\n`);
    }
  }

  async waitForEventStream() {
    while (this.streams.size === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  close() {
    for (const stream of this.streams) {
      stream.end();
    }
    return new Promise<void>((resolve) =>
      this.server!.close(() => {
        rmSync(this.directory, { recursive: true, force: true });
        resolve();
      }),
    );
  }

  // Docker accepts a name or an id wherever it takes a container: its own Id, or one predicted from its name.
  private nameOf(reference: string): string {
    const found = [...this.containers.entries()].find(
      ([candidate, container]) => container.Id === reference || containerIdOf(candidate) === reference,
    );
    return found?.[0] ?? reference;
  }

  // A shell as a terminal shows it: what is typed comes back, and "exit" or Ctrl-D ends it with code 0. As busybox's
  // line editor does, it drops what comes within 50 ms of a terminal's answer for the cursor, the answer included.
  private shell(request: IncomingMessage, socket: Duplex) {
    const id = /^\/exec\/([^/]+)\/start$/.exec(request.url ?? "")?.[1];
    const exec = id === undefined ? undefined : this.execs.get(id);
    if (exec === undefined) {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    socket.write(
      "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
    );
    let answeredAt = -Infinity;
    let typed = "";
    socket.on("data", (chunk: Buffer) => {
      if (Date.now() - answeredAt < BUSYBOX_ESCAPE_MILLISECONDS) {
        return;
      }
      const whole = chunk.toString();
      const answer = whole.search(CURSOR_ANSWER);
      if (answer >= 0) {
        answeredAt = Date.now();
      }
      const text = answer >= 0 ? whole.slice(0, answer) : whole;
      typed += text;
      socket.write(text);
      if (/exit\r?\n?$/.test(typed.trimEnd()) || typed.includes("\u0004")) {
        exec.exitCode = 0;
        socket.end("bye\r\n");
      }
    });
  }

  private async archive(method: string, container: string, path: string, body: Buffer, response: ServerResponse) {
    const files = this.files.get(container) ?? new Map<string, FakeFile>();
    this.files.set(container, files);
    if (method === "PUT") {
      const entry = (await readFirstEntry(Readable.from([body]), body.length))!;
      const folder = entry.header.type === TAR.types.folder;
      const { mode, uid, gid } = entry.header;
      files.set(`${path === "/" ? "" : path}/${entry.header.name}`, {
        folder,
        content: entry.content ?? Buffer.alloc(0),
        mode,
        uid,
        gid,
      });
      response.writeHead(200);
      return response.end();
    }
    const file = files.get(path);
    if (file === undefined) {
      response.writeHead(404, { "content-type": "application/json" });
      return response.end(JSON.stringify({ message: `Could not find the file ${path} in container ${container}` }));
    }
    const name = path.slice(path.lastIndexOf("/") + 1);
    const stat = {
      name,
      size: file.content.length,
      mode: (file.folder ? GO_FILE_MODE.folder : 0) + file.mode,
      linkTarget: "",
    };
    response.writeHead(200, { "x-docker-container-path-stat": Buffer.from(JSON.stringify(stat)).toString("base64") });
    if (method === "HEAD") {
      return response.end();
    }
    const type = file.folder ? TAR.types.folder : TAR.types.file;
    return response.end(
      singleEntryArchive({ name, type, mode: file.mode, uid: file.uid, gid: file.gid }, file.content),
    );
  }

  // A command without a terminal answers at once, in Docker's frames: what it printed, then what it complained of.
  private runCommand(id: string, response: ServerResponse) {
    const exec = this.execs.get(id)!;
    const result = this.commandResult(exec.command);
    exec.exitCode = result.exitCode;
    response.writeHead(200, { "content-type": "application/vnd.docker.raw-stream" });
    response.end(Buffer.concat([frame(result.stdout), frame(result.stderr, STDERR)]));
  }

  private async route(
    method: string,
    url: string,
    body: Buffer,
    response: ServerResponse,
    headers: IncomingHttpHeaders = {},
  ) {
    const { pathname, search, searchParams } = new URL(url, "http://docker");
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (pathname === "/volumes" && method === "GET") {
      const filters = JSON.parse(searchParams.get("filters") ?? "{}") as { label?: string[] };
      return json(200, {
        Volumes: [...this.volumes.values()].filter((volume) =>
          (filters.label ?? []).every((label) => {
            const separator = label.indexOf("=");
            return separator < 0
              ? volume.Labels?.[label] !== undefined
              : volume.Labels?.[label.slice(0, separator)] === label.slice(separator + 1);
          }),
        ),
      });
    }
    if (pathname === "/volumes/create" && method === "POST") {
      const requested = JSON.parse(body.toString()) as DockerVolume;
      // An existing name keeps its labels; creation is not an overwrite operation.
      if (!this.volumes.has(requested.Name)) this.volumes.set(requested.Name, requested);
      return json(201, this.volumes.get(requested.Name));
    }
    if (pathname.startsWith("/volumes/") && method === "GET") {
      const volume = this.volumes.get(decodeURIComponent(pathname.slice("/volumes/".length)));
      return volume === undefined ? json(404, { message: "No such volume" }) : json(200, volume);
    }
    if (pathname.startsWith("/volumes/") && method === "DELETE") {
      const name = decodeURIComponent(pathname.slice("/volumes/".length));
      if (!this.volumes.delete(name)) return json(404, { message: "No such volume" });
      response.writeHead(204);
      return response.end();
    }
    if (pathname === "/events") {
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      this.streams.add(response);
      response.on("close", () => this.streams.delete(response));
      return;
    }
    if (pathname === "/images/json") {
      return json(200, this.images);
    }
    const inspectedImage = /^\/images\/([^/]+)\/json$/.exec(pathname);
    if (inspectedImage !== null && method === "GET") {
      const imageId = decodeURIComponent(inspectedImage[1]!);
      this.imagesInspected.push(imageId);
      // A tag answers as the image it points at.
      const resolved = this.imageIds.get(imageId) ?? imageId;
      const labels = this.imageLabels.get(imageId) ?? this.imageLabels.get(resolved);
      return labels === undefined
        ? json(404, { message: `No such image: ${imageId}` })
        : json(200, { Id: resolved, RepoTags: [], RepoDigests: [], Config: { Labels: labels } });
    }
    if (pathname === "/images/create" && method === "POST") {
      const pulled = `${searchParams.get("fromImage")}:${searchParams.get("tag")}`;
      this.pulls.push(pulled);
      const given = headers["x-registry-auth"];
      if (typeof given === "string") {
        this.pullCredentials.set(pulled, JSON.parse(Buffer.from(given, "base64url").toString()));
      }
      // A registry whose tag moved on: the pull points it at the new image.
      const moved = this.tagsMovedOnPull.get(pulled);
      if (moved !== undefined) this.imageIds.set(pulled, moved);
      response.writeHead(200, { "content-type": "application/json" });
      response.write(`${JSON.stringify({ status: "Downloading", id: "layer", progress: "[=>  ]" })}\n`);
      return response.end(`${JSON.stringify({ status: "Downloaded newer image" })}\n`);
    }
    if (pathname === "/version") {
      return json(200, { Version: "29.9.2", ApiVersion: "1.53" });
    }
    if (pathname === "/build/prune" && method === "POST") {
      this.buildCachePrunes.push(search.slice(1));
      return json(200, { CachesDeleted: [], SpaceReclaimed: this.buildCacheBytes });
    }
    if (pathname === "/containers/json") {
      return json(
        200,
        [...this.containers.entries()].map(([name, container]) => ({
          Id: containerIdOf(name),
          Names: [`/${name}`],
          State: stateOf(container),
          Status: statusOf(container),
          Command: (container.Config as { Cmd?: string[] }).Cmd?.join(" ") ?? "",
          Labels: container.Config.Labels ?? {},
          HostConfig: { NetworkMode: container.HostConfig?.NetworkMode ?? "bridge" },
          Ports: this.ports.get(name) ?? [],
        })),
      );
    }
    const exec = /^\/containers\/([^/]+)\/exec$/.exec(pathname);
    if (exec !== null && method === "POST") {
      const target = this.containers.get(decodeURIComponent(exec[1]!));
      if (target === undefined || target.State.Running !== true) {
        return json(409, { message: "container is not running" });
      }
      const id = `exec-${this.execs.size + 1}`;
      const created = JSON.parse(body.toString()) as { Cmd: string[]; Tty: boolean; Env?: string[] };
      this.execs.set(id, {
        container: decodeURIComponent(exec[1]!),
        command: created.Cmd,
        tty: created.Tty,
        environment: created.Env ?? [],
        sizes: [],
        exitCode: null,
      });
      return json(201, { Id: id });
    }
    const started = /^\/exec\/([^/]+)\/start$/.exec(pathname);
    if (started !== null && this.execs.get(started[1]!)?.tty === false) {
      return this.runCommand(started[1]!, response);
    }
    const archive = /^\/containers\/([^/]+)\/archive$/.exec(pathname);
    if (archive !== null) {
      return this.archive(method, decodeURIComponent(archive[1]!), searchParams.get("path") ?? "", body, response);
    }
    const execAction = /^\/exec\/([^/]+)\/(resize|json)$/.exec(pathname);
    const known = execAction === null ? undefined : this.execs.get(execAction[1]!);
    if (execAction !== null && known !== undefined) {
      if (execAction[2] === "resize") {
        known.sizes.push(search.slice(1));
        response.writeHead(201);
        return response.end();
      }
      return json(200, { Running: known.exitCode === null, ExitCode: known.exitCode });
    }
    // As Docker creates one: stopped, under the name asked for, from the specification given.
    if (pathname === "/containers/create" && method === "POST") {
      const created = searchParams.get("name") ?? "";
      if (this.containers.has(created)) {
        return json(409, { message: `Conflict. The container name "/${created}" is already in use` });
      }
      const specification = JSON.parse(body.toString()) as CreateSpecification;
      this.creations.push({ name: created, specification });
      const id = sha256Hex(`${created}:${this.creations.length}`);
      this.containers.set(created, {
        Id: id,
        Name: `/${created}`,
        Image: this.imageIds.get(specification.Image) ?? specification.Image,
        RestartCount: 0,
        State: { Status: "created", Running: false, ExitCode: 0, OOMKilled: false, Error: "" },
        Config: {
          Image: specification.Image,
          Env: specification.Env ?? [],
          Labels: specification.Labels ?? {},
          Tty: specification.Tty ?? false,
        },
        ...(specification.HostConfig === undefined ? {} : { HostConfig: specification.HostConfig }),
      });
      return json(201, { Id: id, Warnings: [] });
    }
    // Only its restart policy changes, as the runner asks.
    const updating = /^\/containers\/([^/]+)\/update$/.exec(pathname);
    if (updating !== null && method === "POST") {
      const target = this.containers.get(this.nameOf(decodeURIComponent(updating[1]!)));
      if (target === undefined) return json(404, { message: "No such container" });
      const { RestartPolicy } = JSON.parse(body.toString()) as {
        RestartPolicy: { Name: string; MaximumRetryCount?: number };
      };
      target.HostConfig = { ...target.HostConfig, RestartPolicy };
      return json(200, { Warnings: [] });
    }
    const renaming = /^\/containers\/([^/]+)\/rename$/.exec(pathname);
    if (renaming !== null && method === "POST") {
      const from = this.nameOf(decodeURIComponent(renaming[1]!));
      const to = searchParams.get("name") ?? "";
      const target = this.containers.get(from);
      if (target === undefined) return json(404, { message: `No such container: ${from}` });
      this.containers.delete(from);
      this.containers.set(to, { ...target, Name: `/${to}` });
      response.writeHead(204);
      return response.end();
    }
    // As Docker does: a running container is removed only when forced.
    const removal = /^\/containers\/([^/]+)$/.exec(pathname);
    if (removal !== null && method === "DELETE") {
      const removed = this.nameOf(decodeURIComponent(removal[1]!));
      const target = this.containers.get(removed);
      this.removals.push(`${removed}${search}`);
      if (target === undefined) {
        return json(404, { message: `No such container: ${removed}` });
      }
      if (target.State.Running === true && !search.includes("force=")) {
        return json(409, { message: `cannot remove container "/${removed}": container is running` });
      }
      this.containers.delete(removed);
      response.writeHead(204);
      return response.end();
    }
    const match = /^\/containers\/([^/]+)\/(json|logs|restart|stats|stop|start)$/.exec(pathname);
    const name = this.nameOf(decodeURIComponent(match?.[1] ?? ""));
    const container = this.containers.get(name);
    if (match === null || container === undefined) {
      return json(404, { message: `No such container: ${name}` });
    }
    if (match[2] === "json") {
      this.inspected.push(name);
      return json(200, container);
    }
    if (match[2] === "stats") {
      return json(200, this.stats.get(name) ?? {});
    }
    if (match[2] === "logs") {
      response.writeHead(200);
      return response.end(frame(this.logs.get(name) ?? ""));
    }
    if (match[2] === "start" && method === "POST") {
      // A version that fails at once: it exits as soon as it starts.
      const fails = this.failingImages.has(container.Image ?? "");
      container.State = fails
        ? { ...container.State, Status: "exited", Running: false, ExitCode: 1 }
        : { ...container.State, Status: "running", Running: true, ExitCode: 0 };
      response.writeHead(204);
      return response.end();
    }
    if (match[2] === "stop" && method === "POST") {
      this.stops.push(name);
      container.State = { ...container.State, Status: "exited", Running: false, ExitCode: 0 };
      response.writeHead(204);
      return response.end();
    }
    if (method === "POST") {
      this.restarts.push(name);
      void this.restartHeldUntil.then(() => {
        container.State = { ...container.State, Status: "running", Running: true };
        response.writeHead(204);
        response.end();
      });
      return;
    }
    return json(405, {});
  }
}
