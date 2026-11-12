import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDockerEngine, exitedContainer } from "../../test/fakes/fake-docker-engine.js";
import { FakeSshServer } from "../../test/fakes/fake-ssh-server.js";
import { SshDockerConnection } from "../control-plane/ssh/ssh-docker-connection.js";
import { SshSession } from "../control-plane/ssh/ssh-session.js";
import { DOCKER_READ_LIMITS, RUNNER_MESSAGES, SSH_STATE } from "../shared/constants.js";
import { DockerClient, type DockerEvent } from "./docker-client.js";
import { LocalDockerConnection } from "./local-docker-connection.js";
import { singleEntryArchive } from "./tar.js";

describe("DockerClient over the unix socket", () => {
  let engine: FakeDockerEngine;
  let docker: DockerClient;

  beforeEach(async () => {
    engine = await FakeDockerEngine.start();
    docker = new DockerClient(engine.socketPath);
  });

  afterEach(() => engine.close());

  it("pulls an immutable digest using Docker's digest parameter, without treating its colon as a mutable tag", async () => {
    const directory = mkdtempSync(join(tmpdir(), "autoheal-digest-pull-"));
    const socket = join(directory, "engine.sock");
    let query: URLSearchParams | undefined;
    const server = createServer((request, response) => {
      query = new URL(request.url!, "http://docker").searchParams;
      response.end('{"status":"Downloaded reviewed image"}\n');
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      await new DockerClient(socket).pull(`ghcr.io/example/app@sha256:${"a".repeat(64)}`);
      expect(query?.get("fromImage")).toBe("ghcr.io/example/app");
      expect(query?.get("tag")).toBe(`sha256:${"a".repeat(64)}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("gives Docker the stored credential for a private image, and nothing for a public one", async () => {
    const directory = mkdtempSync(join(tmpdir(), "autoheal-private-pull-"));
    const socket = join(directory, "engine.sock");
    const asked: { image: string | null; credential: string | undefined }[] = [];
    const server = createServer((request, response) => {
      asked.push({
        image: new URL(request.url!, "http://docker").searchParams.get("fromImage"),
        credential: request.headers["x-registry-auth"] as string | undefined,
      });
      response.end('{"status":"Downloaded"}\n');
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const client = new DockerClient(socket, () => [
        { registry: "ghcr.io", repository: "owner/app", username: "owner", password: "a-token" },
      ]);
      await client.pull("ghcr.io/owner/app:2");
      await client.pull("nginx:1.27");

      const [privateImage, publicImage] = asked;
      expect(privateImage!.image).toBe("ghcr.io/owner/app");
      expect(JSON.parse(Buffer.from(privateImage!.credential!, "base64url").toString())).toEqual({
        username: "owner",
        password: "a-token",
        serveraddress: "ghcr.io",
      });
      expect(publicImage!.credential).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("changes only the restart policy and reports Docker refusals", async () => {
    const directory = mkdtempSync(join(tmpdir(), "autoheal-restart-policy-"));
    const socket = join(directory, "engine.sock");
    const requests: { path: string; body: unknown }[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { RestartPolicy: { Name: string } };
      requests.push({ path: request.url!, body });
      response.statusCode = body.RestartPolicy.Name === "invalid" ? 400 : 200;
      response.end(JSON.stringify({ Warnings: [] }));
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      const client = new DockerClient(socket);
      await client.setRestartPolicy("app/id", { Name: "no", MaximumRetryCount: 0 });
      await client.setRestartPolicy("app/id", { Name: "on-failure", MaximumRetryCount: 3 });
      expect(requests).toEqual([
        { path: "/containers/app%2Fid/update", body: { RestartPolicy: { Name: "no", MaximumRetryCount: 0 } } },
        { path: "/containers/app%2Fid/update", body: { RestartPolicy: { Name: "on-failure", MaximumRetryCount: 3 } } },
      ]);
      await expect(client.setRestartPolicy("app/id", { Name: "invalid" })).rejects.toThrow(/HTTP 400/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("inspects volume driver/options without mutating the volume and distinguishes missing volumes", async () => {
    engine.volumes.set("host-root", {
      Name: "host-root",
      Driver: "local",
      Options: { type: "none", o: "bind", device: "/" },
    });
    expect(await docker.inspectVolume("host-root")).toMatchObject({ Driver: "local", Options: { device: "/" } });
    expect(await docker.inspectVolume("missing")).toBeNull();
    expect(engine.volumes.size).toBe(1);
  });

  it("inspects containers, and returns null for unknown ones", async () => {
    engine.add(exitedContainer("paperless"));
    expect((await docker.inspect("paperless"))?.State.ExitCode).toBe(1);
    expect(await docker.inspect("missing")).toBeNull();
  });

  it("lists images, and clears the whole build cache, saying how much that freed", async () => {
    const tika = { Id: "sha256:0123", RepoTags: ["tika:2"], Size: 12_000_000, Created: 1_760_000_000 };
    engine.images.push(tika);
    engine.buildCacheBytes = 1_822_000_000;

    expect(await docker.images()).toEqual([tika]);
    expect(await docker.pruneBuildCache()).toBe(1_822_000_000);
    expect(engine.buildCachePrunes).toEqual(["all=1"]);
  });

  it("says the engine's version", async () => {
    expect(await docker.version()).toBe("29.9.2");
  });

  it("lists names without Docker's leading slash", async () => {
    engine.add(exitedContainer("paperless"));
    engine.add(exitedContainer("tika"));
    expect([...(await docker.containerNames())].sort()).toEqual(["paperless", "tika"]);
  });

  it("strips the frame headers from non-TTY logs", async () => {
    engine.add(exitedContainer("paperless"), "booting\nerror: no key\n");
    expect(await docker.logs("paperless", false)).toBe("booting\nerror: no key\n");
  });

  it("keeps only the newest bytes of enormous logs", async () => {
    engine.add(exitedContainer("paperless"), `${"x".repeat(2_000_000)}\nNEWEST`);
    const logs = await docker.logs("paperless", false);
    expect(logs.length).toBeLessThanOrEqual(256 * 1024);
    expect(logs.endsWith("NEWEST")).toBe(true);
  });

  it("collects every container's environment entries", async () => {
    engine.add(exitedContainer("paperless", { Config: { Image: "p", Env: ["A=1"] } }));
    engine.add(exitedContainer("tika", { Config: { Image: "t", Env: ["B=2", "C=3"] } }));
    expect((await docker.allEnvironmentEntries()).sort()).toEqual(["A=1", "B=2", "C=3"]);
  });

  it("restarts, and reports engine errors", async () => {
    engine.add(exitedContainer("paperless"));
    await docker.restart("paperless");
    expect(engine.restarts).toEqual(["paperless"]);
    await expect(docker.restart("missing")).rejects.toThrow(/Docker answered HTTP 404/);
  });

  it("removes a stopped container without forcing it, and Docker refuses a running one", async () => {
    engine.add(exitedContainer("paperless"));
    await docker.removeStopped("paperless");
    expect(await docker.inspect("paperless")).toBeNull();
    const tika = exitedContainer("tika");
    engine.add({ ...tika, State: { ...tika.State, Status: "running", Running: true } });
    await expect(docker.removeStopped("tika")).rejects.toThrow(/Docker answered HTTP 409/);
    expect(engine.removals).toEqual(["paperless", "tika"]);
  });

  it("opens a shell in a running container, its stream both ways, resized, and says how it ended", async () => {
    const paperless = exitedContainer("paperless");
    engine.add({ ...paperless, State: { ...paperless.State, Status: "running", Running: true } });
    const shell = await docker.openShell("paperless", 120, 30);
    const printed: string[] = [];
    shell.socket.on("data", (chunk: Buffer) => printed.push(chunk.toString()));
    const ended = new Promise((resolve) => shell.socket.on("end", resolve));

    await shell.resize(100, 40);
    expect(await shell.exitCode()).toBeNull();
    shell.socket.write("ls\r");
    shell.socket.write("exit\r");
    await ended;
    expect(printed.join("")).toBe("ls\rexit\rbye\r\n");
    expect(await shell.exitCode()).toBe(0);
    expect([...engine.execs.values()][0]!.sizes).toEqual(["h=40&w=100"]);
    // A stopped container has no shell to give.
    engine.add(exitedContainer("tika"));
    await expect(docker.openShell("tika", 80, 24)).rejects.toThrow(/Docker answered HTTP 409/);
  });

  it("runs a command without a terminal, as arguments, keeping what it printed apart from its complaints", async () => {
    const paperless = exitedContainer("paperless");
    engine.add({ ...paperless, State: { ...paperless.State, Status: "running", Running: true } });
    engine.commandResult = (command) => ({
      stdout: `listed ${command.at(-1)}\n`.repeat(10),
      stderr: "ls: cannot access 'x': Permission denied\n",
      exitCode: 1,
    });

    const result = await docker.runCommand("paperless", ["ls", "-la", "/srv/"], 64);
    expect(result).toEqual({
      exitCode: 1,
      stdout: "listed /srv/\n".repeat(10).slice(0, 64),
      stderr: "ls: cannot access 'x': Permission denied\n",
      truncated: true,
    });
    const [exec] = engine.execs.values();
    expect(exec).toMatchObject({ command: ["ls", "-la", "/srv/"], tty: false, environment: ["LC_ALL=C"] });
  });

  describe("a command's output streamed as it comes, without a terminal", () => {
    // One piece of output in Docker's framing: an 8-byte header saying whose it is and how long, then the bytes.
    const framed = (text: string) => {
      const payload = Buffer.from(text);
      const header = Buffer.alloc(8);
      header[0] = 1;
      header.writeUInt32BE(payload.length, 4);
      return Buffer.concat([header, payload]);
    };
    const collected = () => {
      const chunks: Buffer[] = [];
      const output = new Writable({
        write(chunk: Buffer, _encoding, done) {
          chunks.push(chunk);
          done();
        },
      });
      return { output, text: () => Buffer.concat(chunks).toString() };
    };
    const dump = (output: Writable) =>
      docker.streamCommand("db", ["pg_dumpall"], { output, timeoutMilliseconds: 5000 });

    beforeEach(() => {
      const database = exitedContainer("db");
      engine.add({ ...database, State: { ...database.State, Status: "running", Running: true } });
    });

    it("ends at its deadline a command whose stream Docker never begins, letting its connection go", async () => {
      engine.holdStarts = true;
      const { output } = collected();
      const asked = docker.streamCommand("db", ["pg_dumpall"], { output, timeoutMilliseconds: 200 });
      await expect(asked).rejects.toThrow(RUNNER_MESSAGES.commandTookTooLong);
      await vi.waitFor(() => expect(engine.heldOpen()).toBe(0));
    });

    it("ends at the same deadline a command whose stream runs on", async () => {
      engine.holdStreams = true;
      const { output } = collected();
      const asked = docker.streamCommand("db", ["pg_dumpall"], { output, timeoutMilliseconds: 200 });
      await expect(asked).rejects.toThrow(RUNNER_MESSAGES.commandTookTooLong);
      await vi.waitFor(() => expect(engine.heldOpen()).toBe(0));
    });

    it("passes every whole piece on, and says how the command ended", async () => {
      engine.streamed = () => Buffer.concat([framed("CREATE TABLE a;\n"), framed("COPY a;\n")]);
      const { output, text } = collected();

      expect(await dump(output)).toEqual({ exitCode: 0, stderr: "" });
      expect(text()).toBe("CREATE TABLE a;\nCOPY a;\n");
    });

    it("fails on a piece larger than any it takes at once, passing on what came before it", async () => {
      const header = Buffer.alloc(8);
      header[0] = 1;
      header.writeUInt32BE(DOCKER_READ_LIMITS.frameBytes + 1, 4);
      engine.streamed = () => Buffer.concat([framed("CREATE TABLE a;\n"), header, Buffer.alloc(1024)]);
      const { output, text } = collected();

      await expect(dump(output)).rejects.toThrow(RUNNER_MESSAGES.execFrameTooLarge);
      expect(text()).toBe("CREATE TABLE a;\n");
    });

    it.each([
      ["in its header", (piece: Buffer) => piece.subarray(0, 5)],
      ["in its bytes", (piece: Buffer) => piece.subarray(0, piece.length - 3)],
    ])("fails a stream that ends part-way through a piece, %s, though the command ended well", async (_where, cut) => {
      engine.streamed = () => Buffer.concat([framed("CREATE TABLE a;\n"), cut(framed("COPY a;\n"))]);
      const { output, text } = collected();

      await expect(dump(output)).rejects.toThrow(RUNNER_MESSAGES.execStreamCutShort);
      expect(text()).toBe("CREATE TABLE a;\n");
    });
  });

  it("reaches a container's files through its archive: stat, read, read only the header, and write", async () => {
    engine.files.set(
      "paperless",
      new Map([
        ["/srv", { folder: true, content: Buffer.alloc(0), mode: 0o755, uid: 33, gid: 33 }],
        ["/srv/app.env", { folder: false, content: Buffer.from("A=1\n"), mode: 0o640, uid: 33, gid: 34 }],
      ]),
    );

    expect(await docker.pathStat("paperless", "/srv/gone")).toBeNull();
    expect(await docker.pathStat("paperless", "/srv/app.env")).toEqual({
      name: "app.env",
      size: 4,
      mode: 0o640,
      linkTarget: "",
    });
    expect((await docker.pathStat("paperless", "/srv"))!.mode).toBe(2 ** 31 + 0o755);
    const read = await docker.readEntry("paperless", "/srv/app.env", 1024);
    expect(read!.content!.toString()).toBe("A=1\n");
    expect(read!.header).toMatchObject({ mode: 0o640, uid: 33, gid: 34 });
    expect((await docker.readEntry("paperless", "/srv/app.env", 0))!.content).toBeNull();
    expect(await docker.readEntry("paperless", "/srv/gone", 1024)).toBeNull();

    const archive = singleEntryArchive(
      { name: "new.txt", type: "0", mode: 0o600, uid: 33, gid: 33 },
      Buffer.from("hi"),
    );
    await docker.putArchive("paperless", "/srv", archive);
    expect(engine.files.get("paperless")!.get("/srv/new.txt")).toEqual({
      folder: false,
      content: Buffer.from("hi"),
      mode: 0o600,
      uid: 33,
      gid: 33,
    });
  });

  it("streams container events until aborted", async () => {
    const stop = new AbortController();
    const events = await docker.events(stop.signal);
    const received: DockerEvent[] = [];
    const reading = (async () => {
      for await (const event of events) {
        received.push(event);
        if (received.length === 2) {
          stop.abort();
        }
      }
    })().catch(() => undefined);
    await engine.waitForEventStream();
    engine.emit({ Type: "container", Action: "die", Actor: { Attributes: { name: "paperless" } } });
    engine.emit({ Type: "container", Action: "start", Actor: { Attributes: { name: "paperless" } } });
    await reading;
    expect(received.map((event) => event.Action)).toEqual(["die", "start"]);
  });
});

const SSH_USER = "alex";
const CONNECT_MILLISECONDS = 5_000;

// What one engine answers to the same requests, over whichever connection reaches it.
async function sameRequests(engine: FakeDockerEngine, docker: DockerClient) {
  const paperless = exitedContainer("paperless");
  engine.add({ ...paperless, State: { ...paperless.State, Status: "running", Running: true } });
  engine.add(exitedContainer("tika"));
  engine.files.set(
    "paperless",
    new Map([["/srv/app.env", { folder: false, content: Buffer.from("A=1\n"), mode: 0o640, uid: 33, gid: 34 }]]),
  );

  const inventory = (await docker.containerSummaries()).map((container) => [container.Names, container.State]);

  const stop = new AbortController();
  const events = await docker.events(stop.signal);
  let event: DockerEvent | undefined;
  const reading = (async () => {
    for await (const each of events) {
      event = each;
      stop.abort();
    }
  })().catch(() => undefined);
  await engine.waitForEventStream();
  engine.emit({ Type: "container", Action: "die", Actor: { Attributes: { name: "tika" } } });
  await reading;

  await docker.restart("tika");

  const shell = await docker.openShell("paperless", 120, 30);
  const printed: Buffer[] = [];
  shell.socket.on("data", (chunk: Buffer) => printed.push(chunk));
  const ended = new Promise((resolve) => shell.socket.on("end", resolve));
  await shell.resize(100, 40);
  shell.socket.write("exit\r");
  await ended;

  const pulled: unknown[] = [];
  await docker.pull("example/app:2", (line) => pulled.push(line));

  const read = await docker.readEntry("paperless", "/srv/app.env", 1024);

  return {
    inventory,
    event,
    restarts: engine.restarts,
    shell: {
      printed: Buffer.concat(printed).toString(),
      exitCode: await shell.exitCode(),
      sizes: [...engine.execs.values()][0]!.sizes,
    },
    pulls: engine.pulls,
    pulled,
    archive: { content: read!.content!.toString(), header: read!.header },
  };
}

describe("DockerClient over a connection: the local socket, or an SSH host's session", () => {
  it("gives the same answers both ways", async () => {
    const local = await FakeDockerEngine.start();
    const remote = await FakeDockerEngine.start();
    // The fake server reads the public half from whichever key it is given.
    const key = FakeSshServer.newHostKey();
    const server = await FakeSshServer.start(SSH_USER, [key], remote.socketPath);
    const session = new SshSession(() => ({
      address: "127.0.0.1",
      port: server.port,
      user: SSH_USER,
      privateKey: key,
      passphrase: null,
      pinnedHostKey: server.hostKeyBlob(),
    }));
    try {
      session.start();
      const started = Date.now();
      while (session.state().state !== SSH_STATE.connected && Date.now() - started < CONNECT_MILLISECONDS) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const overSocket = await sameRequests(local, new DockerClient(new LocalDockerConnection(local.socketPath)));
      const overSsh = await sameRequests(remote, new DockerClient(new SshDockerConnection(session)));
      expect(overSocket).toMatchObject({
        inventory: [
          [["/paperless"], "running"],
          [["/tika"], "exited"],
        ],
        event: { Action: "die" },
        restarts: ["tika"],
        shell: { printed: "exit\rbye\r\n", exitCode: 0, sizes: ["h=40&w=100"] },
        pulls: ["example/app:2"],
        pulled: [{ status: "Downloading", id: "layer", progress: "[=>  ]" }, { status: "Downloaded newer image" }],
        archive: { content: "A=1\n", header: { mode: 0o640, uid: 33, gid: 34 } },
      });
      expect(overSsh).toEqual(overSocket);
    } finally {
      session.close();
      await server.stop();
      await Promise.all([local.close(), remote.close()]);
    }
  });

  it("refuses requests while the session is not connected", async () => {
    const session = new SshSession(() => ({
      address: "127.0.0.1",
      port: 1,
      user: SSH_USER,
      privateKey: FakeSshServer.newHostKey(),
      passphrase: null,
      pinnedHostKey: null,
    }));
    await expect(new DockerClient(new SshDockerConnection(session)).version()).rejects.toThrow(
      /the SSH session is connecting, not connected/,
    );
  });
});

describe("Docker's refusals, as Autoheal tells them", () => {
  it("keeps one on a single line, though Docker ends its answer with a newline", () => {
    expect(RUNNER_MESSAGES.dockerError(404, '{"message":"No such container: autoheal-autoheal-previous"}\n')).toBe(
      'Docker answered HTTP 404: {"message":"No such container: autoheal-autoheal-previous"}',
    );
  });
});

describe("what an engine sends, read only as far as any real one goes", () => {
  // An engine at the end of a socket that keeps sending until it is cut off, or has sent this much more than the limit.
  async function sending(limit: number, chunk: Buffer, status = 200) {
    const directory = mkdtempSync(join(tmpdir(), "autoheal-docker-limits-"));
    const socket = join(directory, "engine.sock");
    const answered = { closed: false };
    const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.on("close", () => (answered.closed = true));
      let sent = 0;
      const more = () => {
        while (!answered.closed && sent <= limit + 2 * chunk.length) {
          sent += chunk.length;
          if (!response.write(chunk)) {
            response.once("drain", more);
            return;
          }
        }
        response.end();
      };
      more();
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    return {
      docker: new DockerClient(socket),
      answered,
      close: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(directory, { recursive: true, force: true });
      },
    };
  }

  it("stops reading an answer larger than any it needs, and cuts it off", async () => {
    // Spaces: what JSON allows anywhere, so only its size is wrong.
    const engine = await sending(DOCKER_READ_LIMITS.bodyBytes, Buffer.alloc(1024 * 1024, " "));
    try {
      await expect(engine.docker.containerSummaries()).rejects.toThrow(RUNNER_MESSAGES.dockerAnswerTooLarge);
      await vi.waitFor(() => expect(engine.answered.closed).toBe(true));
    } finally {
      await engine.close();
    }
  });

  it("fails a command whose start is refused with an answer cut off part-way, instead of waiting on it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "autoheal-docker-refusal-"));
    const socket = join(directory, "engine.sock");
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      if (request.url?.endsWith("/start")) {
        // A refusal that says how long it is, then stops a few bytes in.
        response.writeHead(409, { "content-type": "application/json", "content-length": "100" });
        response.write('{"message"');
        response.socket?.destroy();
        return;
      }
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ Id: "exec-1" }));
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      let settled: string | null = null;
      void new DockerClient(socket).runInputCommand("app", ["true"], Buffer.alloc(0), 1024).then(
        () => (settled = "done"),
        () => (settled = "failed"),
      );

      await vi.waitFor(() => expect(settled).toBe("failed"), { timeout: 2000 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails a command whose start is refused with an answer larger than any it reads, instead of waiting on it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "autoheal-docker-refusal-"));
    const socket = join(directory, "engine.sock");
    const answered = { closed: false };
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      if (!request.url?.endsWith("/start")) {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ Id: "exec-1" }));
        return;
      }
      response.writeHead(409, { "content-type": "application/json" });
      response.on("close", () => (answered.closed = true));
      const chunk = Buffer.alloc(1024 * 1024, " ");
      let sent = 0;
      const more = () => {
        while (!answered.closed && sent <= DOCKER_READ_LIMITS.bodyBytes + 2 * chunk.length) {
          sent += chunk.length;
          if (!response.write(chunk)) {
            response.once("drain", more);
            return;
          }
        }
        response.end();
      };
      more();
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      let settled: string | null = null;
      void new DockerClient(socket).runInputCommand("app", ["true"], Buffer.alloc(0), 1024).then(
        () => (settled = "done"),
        (error: Error) => (settled = error.message),
      );

      await vi.waitFor(() => expect(settled).toBe(RUNNER_MESSAGES.dockerAnswerTooLarge), { timeout: 5000 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("closes its event stream on a line longer than any event", async () => {
    const engine = await sending(DOCKER_READ_LIMITS.lineCharacters, Buffer.alloc(64 * 1024, "x"));
    try {
      const events = await engine.docker.events();
      const reading = (async () => {
        for await (const _event of events) {
          // Nothing is expected.
        }
      })();
      await expect(reading).rejects.toThrow(RUNNER_MESSAGES.dockerLineTooLong);
      await vi.waitFor(() => expect(engine.answered.closed).toBe(true));
    } finally {
      await engine.close();
    }
  });
});
