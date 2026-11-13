import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  statSync,
  type Stats,
} from "node:fs";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { SSH_READINESS } from "../../src/shared/constants.js";
import {
  Server,
  utils,
  type Attributes,
  type Connection,
  type ParsedKey,
  type ServerChannel,
  type SFTPWrapper,
} from "ssh2";

const { STATUS_CODE } = utils.sftp;

const FLOOD_CHUNK_BYTES = 64 * 1024;
const ROOT_CHECK = "id -u";
const ROOT_REFUSAL = {
  sudo: "Sorry, try again.\nsudo: no password was provided\n",
  su: "su: Authentication failure\n",
};
const unquoted = (quoted: string) => quoted.replaceAll("'\\''", "'");

/** A command run as root, as the control plane writes one: through sudo or su, the command in single quotes. */
function rootCommandOf(line: string): { method: "sudo" | "su"; command: string } | null {
  const sudo = /^sudo -S -k -p '' -- sh -c '(.*)'$/s.exec(line);
  if (sudo !== null) return { method: "sudo", command: unquoted(sudo[1]!) };
  const su = /^su -c '(.*)' root$/s.exec(line);
  return su === null ? null : { method: "su", command: unquoted(su[1]!) };
}

function flood(stream: ServerChannel) {
  const chunk = Buffer.alloc(FLOOD_CHUNK_BYTES, "x");
  let closed = false;
  stream.once("close", () => {
    closed = true;
  });
  const pump = () => {
    if (closed) return;
    if (stream.write(chunk)) setImmediate(pump);
    else stream.once("drain", pump);
  };
  pump();
}

function answerWith(stream: ServerChannel, answer: FakeExecAnswer) {
  if (answer.hang === true) return;
  if (answer.flood === true) {
    flood(stream);
    return;
  }
  stream.write(answer.stdout ?? "");
  stream.stderr.write(answer.stderr ?? "");
  stream.exit(answer.exitCode ?? 0);
  stream.end();
}

const attributesOf = (status: Stats): Attributes => ({
  mode: status.mode,
  uid: status.uid,
  gid: status.gid,
  size: status.size,
  atime: Math.floor(status.atimeMs / 1000),
  mtime: Math.floor(status.mtimeMs / 1000),
});

export interface FakeExecAnswer {
  // Never answers, as a command that does not end.
  hang?: boolean;
  // Prints without end, as a command gone wrong, until the channel closes.
  flood?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

const parsed = (key: string): ParsedKey => {
  const result = utils.parseKey(key);
  if (result instanceof Error) throw result;
  return Array.isArray(result) ? result[0]! : result;
};

/**
 * An OpenSSH server on 127.0.0.1 for tests: one user, the public keys it accepts, a host key (which a test may
 * change), commands answered from `exec`, an SFTP subsystem that answers REALPATH, and the Docker socket forwarded
 * to a local socket (the fake Docker engine's).
 */
export class FakeSshServer {
  hostKey = FakeSshServer.newHostKey();
  // What the readiness check finds when a host is added: Docker there and usable on an Ubuntu host, unless a test says.
  readiness = `${SSH_READINESS.socketMark}\n${SSH_READINESS.usableMark}\n`;
  exec: (command: string) => FakeExecAnswer = (command) =>
    command === SSH_READINESS.command ? { stdout: this.readiness } : {};
  readonly commands: string[] = [];
  // A host gone quiet: an exec request, or a file opened, is never answered.
  stallExec = false;
  stallFiles = false;
  // The passwords that make root here: the user's own through sudo, root's through su; null where that way is shut.
  sudoPassword: string | null = null;
  rootPassword: string | null = null;
  // Each command that ran as root.
  readonly rootCommands: string[] = [];
  // Each login shell opened: its terminal, as the client asked for it, and each new size it was given.
  readonly shells: { term: string; columns: number; rows: number; resizes: string[] }[] = [];
  // Every SFTP request answered, for a test to count what one reading costs.
  sftpRequests = 0;
  // The session channels open now, commands, shells and SFTP alike, as sshd counts them against its MaxSessions.
  openSessions = 0;
  // The host's files: SFTP serves this directory as its /. Null answers only REALPATH.
  filesRoot: string | null = null;
  // Each signed-in connection's start and end, in order: whether two ever overlapped.
  readonly connections: ("ready" | "closed")[] = [];
  port = 0;
  private server: Server | null = null;
  private readonly clients = new Set<Connection>();

  private constructor(
    readonly user: string,
    // The public keys it accepts; a test may add one.
    readonly acceptedKeys: string[],
    private readonly dockerSocketPath: string | null,
  ) {}

  // ssh2's generator makes an unreadable ed25519 key about once in 200: read each back before using it.
  static newHostKey(): string {
    for (;;) {
      const key = utils.generateKeyPairSync("ed25519").private;
      if (!(utils.parseKey(key) instanceof Error)) return key;
    }
  }

  static async start(user: string, acceptedKeys: string[], dockerSocketPath: string | null = null) {
    const server = new FakeSshServer(user, acceptedKeys, dockerSocketPath);
    await server.listen();
    return server;
  }

  /** The host key, as a session sees it: base64 of its public blob. */
  hostKeyBlob(): string {
    return parsed(this.hostKey).getPublicSSH().toString("base64");
  }

  /** Stops, as a host that reboots does; `restart` comes back on the same port. */
  async stop() {
    const server = this.server;
    this.server = null;
    // A host that goes down drops its sessions; close() alone would wait for them.
    this.clients.forEach((client) => client.end());
    this.clients.clear();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  async restart() {
    await this.stop();
    await this.listen();
  }

  // Read-only, as the host's user would see its files: what the test's user cannot read is refused.
  private serveFiles(sftp: SFTPWrapper, root: string) {
    const local = (path: string) => join(root, path);
    const open = new Map<string, { descriptor: number } | { entries: string[] }>();
    let nextHandle = 0;
    const handle = (value: { descriptor: number } | { entries: string[] }) => {
      const key = String((nextHandle += 1));
      open.set(key, value);
      return Buffer.from(key);
    };
    const answer = (requestId: number, work: () => void) => {
      this.sftpRequests += 1;
      try {
        work();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        sftp.status(requestId, code === "EACCES" ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.NO_SUCH_FILE);
      }
    };
    sftp.on("OPEN", (requestId, path) => {
      if (this.stallFiles) return;
      answer(requestId, () => sftp.handle(requestId, handle({ descriptor: openSync(local(path), "r") })));
    });
    sftp.on("OPENDIR", (requestId, path) =>
      answer(requestId, () => sftp.handle(requestId, handle({ entries: readdirSync(local(path)) }))),
    );
    sftp.on("READ", (requestId, key, offset, length) =>
      answer(requestId, () => {
        const file = open.get(key.toString());
        if (file === undefined || !("descriptor" in file)) throw new Error("not a file");
        const buffer = Buffer.alloc(length);
        const read = readSync(file.descriptor, buffer, 0, length, offset);
        if (read === 0) sftp.status(requestId, STATUS_CODE.EOF);
        else sftp.data(requestId, buffer.subarray(0, read));
      }),
    );
    sftp.on("READDIR", (requestId, key) =>
      answer(requestId, () => {
        const directory = open.get(key.toString());
        if (directory === undefined || !("entries" in directory)) throw new Error("not a directory");
        const entries = directory.entries.splice(0);
        if (entries.length === 0) sftp.status(requestId, STATUS_CODE.EOF);
        else
          sftp.name(
            requestId,
            entries.map((filename) => ({ filename, longname: filename, attrs: {} as Attributes })),
          );
      }),
    );
    sftp.on("FSTAT", (requestId, key) =>
      answer(requestId, () => {
        const file = open.get(key.toString());
        if (file === undefined || !("descriptor" in file)) throw new Error("not a file");
        sftp.attrs(requestId, attributesOf(fstatSync(file.descriptor)));
      }),
    );
    sftp.on("CLOSE", (requestId, key) =>
      answer(requestId, () => {
        const file = open.get(key.toString());
        open.delete(key.toString());
        if (file !== undefined && "descriptor" in file) closeSync(file.descriptor);
        sftp.status(requestId, STATUS_CODE.OK);
      }),
    );
    sftp.on("STAT", (requestId, path) =>
      answer(requestId, () => sftp.attrs(requestId, attributesOf(statSync(local(path))))),
    );
    sftp.on("LSTAT", (requestId, path) =>
      answer(requestId, () => sftp.attrs(requestId, attributesOf(lstatSync(local(path))))),
    );
    sftp.on("READLINK", (requestId, path) =>
      answer(requestId, () =>
        sftp.name(requestId, [{ filename: readlinkSync(local(path)), longname: "", attrs: {} as Attributes }]),
      ),
    );
  }

  private listen() {
    const server = new Server({ hostKeys: [this.hostKey] }, (client) => {
      this.clients.add(client);
      let signedIn = false;
      client.on("close", () => {
        this.clients.delete(client);
        if (signedIn) this.connections.push("closed");
      });
      client.on("authentication", (context) => {
        const accepted =
          context.method === "publickey" &&
          context.username === this.user &&
          this.acceptedKeys
            .map(parsed)
            .find((key) => key.getPublicSSH().equals(context.key.data) && key.type === context.key.algo);
        if (!accepted) {
          context.reject();
          return;
        }
        const signed =
          context.signature === undefined || accepted.verify(context.blob!, context.signature, context.hashAlgo);
        if (signed) context.accept();
        else context.reject();
      });
      client.on("ready", () => {
        // So the fake adds no delay of its own to its replies; @types/ssh2 leaves out the server side's setNoDelay.
        (client as Connection & { setNoDelay(noDelay: boolean): void }).setNoDelay(true);
        signedIn = true;
        this.connections.push("ready");
        client.on("session", (acceptSession) => {
          const session = acceptSession();
          this.openSessions += 1;
          session.once("close", () => {
            this.openSessions -= 1;
          });
          let terminal = { term: "", columns: 0, rows: 0, resizes: [] as string[] };
          session.on("pty", (acceptPty, _rejectPty, info) => {
            terminal = { term: info.term, columns: info.cols, rows: info.rows, resizes: [] };
            acceptPty?.();
          });
          session.on("window-change", (acceptChange, _rejectChange, info) => {
            terminal.resizes.push(`${info.cols}x${info.rows}`);
            acceptChange?.();
          });
          // A login shell as a terminal shows it: what is typed comes back, and "exit" ends it with code 0.
          session.on("shell", (acceptShell) => {
            const stream = acceptShell();
            this.shells.push(terminal);
            let typed = "";
            stream.on("data", (chunk: Buffer) => {
              typed += chunk.toString();
              stream.write(chunk);
              if (/exit\r$/.test(typed)) {
                stream.exit(0);
                stream.end("logout\r\n");
              }
            });
          });
          session.on("exec", (acceptExec, _reject, info) => {
            if (this.stallExec) return;
            const stream = acceptExec();
            this.commands.push(info.command);
            const asRoot = rootCommandOf(info.command);
            if (asRoot === null) {
              answerWith(stream, this.exec(info.command));
              return;
            }
            // su asks in its terminal; sudo -S reads the password from its input without a word.
            if (asRoot.method === "su") stream.write("Password: ");
            stream.once("data", (typed: Buffer) => {
              const password = typed.toString().split("\n")[0];
              // A terminal ends the prompt's line once the hidden password is typed.
              if (asRoot.method === "su") stream.write("\r\n");
              const expected = asRoot.method === "su" ? this.rootPassword : this.sudoPassword;
              if (expected === null || password !== expected) {
                answerWith(stream, { stderr: ROOT_REFUSAL[asRoot.method], exitCode: 1 });
                return;
              }
              this.rootCommands.push(asRoot.command);
              answerWith(stream, asRoot.command === ROOT_CHECK ? { stdout: "0\n" } : this.exec(asRoot.command));
            });
          });
          session.on("sftp", (acceptSftp) => {
            const sftp = acceptSftp();
            sftp.on("REALPATH", (requestId, path) =>
              sftp.name(requestId, [{ filename: path === "." ? "/home" : path, longname: "", attrs: {} as never }]),
            );
            if (this.filesRoot !== null) this.serveFiles(sftp, this.filesRoot);
          });
        });
        client.on("openssh.streamlocal", (acceptForward, rejectForward, info) => {
          if (this.dockerSocketPath === null || info.socketPath !== "/var/run/docker.sock") {
            rejectForward();
            return;
          }
          const channel = acceptForward();
          const socket = connect(this.dockerSocketPath);
          // As sshd does, an engine that goes away closes the channel.
          socket.on("error", () => channel.close());
          channel.pipe(socket).pipe(channel);
        });
      });
      client.on("error", () => undefined);
    });
    this.server = server;
    return new Promise<void>((resolve) =>
      server.listen(this.port, "127.0.0.1", () => {
        this.port = (server.address() as AddressInfo).port;
        resolve();
      }),
    );
  }
}
