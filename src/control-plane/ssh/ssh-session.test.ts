import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { utils } from "ssh2";
import { FakeDockerEngine } from "../../../test/fakes/fake-docker-engine.js";
import { FakeSshServer } from "../../../test/fakes/fake-ssh-server.js";
import { ROOT_METHOD, SSH_HOST_FILES, SSH_STATE, type SshState } from "../../shared/constants.js";
import { describeError } from "../../shared/errors.js";
import { SshHostFiles, shellQuoted, sshHostCommand } from "./ssh-host-files.js";
import { SshSession, probeSsh, sshFingerprint, type SshTarget } from "./ssh-session.js";

const USER = "alex";
const PASSPHRASE = "the key's own passphrase";
// ssh2's generator makes an unreadable ed25519 key about once in 200, so each test key is read back first.
function readableKey(make: () => { private: string; public: string }, passphrase?: string) {
  for (;;) {
    const pair = make();
    if (!(utils.parseKey(pair.private, passphrase) instanceof Error)) return pair;
  }
}
// The user's own keys: one without a passphrase, one RSA key with one.
const ed25519 = readableKey(() => utils.generateKeyPairSync("ed25519"));
const rsa = readableKey(
  () => utils.generateKeyPairSync("rsa", { bits: 2048, passphrase: PASSPHRASE, cipher: "aes256-cbc" }),
  PASSPHRASE,
);
const FAST = { reconnectFirstMilliseconds: 50, reconnectMostMilliseconds: 200 };
const SETTLE_MILLISECONDS = 5_000;

async function until(session: SshSession, state: SshState) {
  const started = Date.now();
  while (session.state().state !== state) {
    if (Date.now() - started > SETTLE_MILLISECONDS) {
      throw new Error(`still ${session.state().state} (${session.state().reason}), not ${state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("an SSH host's session", () => {
  let engine: FakeDockerEngine;
  let server: FakeSshServer;
  const sessions: SshSession[] = [];

  beforeEach(async () => {
    engine = await FakeDockerEngine.start();
    server = await FakeSshServer.start(USER, [ed25519.public, rsa.public], engine.socketPath);
  });

  afterEach(async () => {
    sessions.splice(0).forEach((session) => session.close());
    await server.stop();
    engine.close();
  });

  const target = (overrides: Partial<SshTarget> = {}): SshTarget => ({
    address: "127.0.0.1",
    port: server.port,
    user: USER,
    privateKey: ed25519.private,
    passphrase: null,
    pinnedHostKey: server.hostKeyBlob(),
    ...overrides,
  });
  const open = (current: () => SshTarget) => {
    const session = new SshSession(current, Date.now, FAST);
    sessions.push(session);
    session.start();
    return session;
  };

  it("connects with the user's own keys, with or without a passphrase, and carries commands, files and Docker", async () => {
    const plain = open(() => target());
    await until(plain, SSH_STATE.connected);
    server.exec = (command) => (command === "id -nG" ? { stdout: "alex docker\n" } : { stderr: "no", exitCode: 1 });
    expect(await plain.exec("id -nG", 1_000)).toEqual({ stdout: "alex docker\n", stderr: "", exitCode: 0 });
    expect(await plain.exec("false", 1_000)).toEqual({ stdout: "", stderr: "no", exitCode: 1 });

    const sftp = await plain.sftp();
    const home = await new Promise<string>((resolve, reject) =>
      sftp.realpath(".", (error, path) => (error ? reject(error) : resolve(path))),
    );
    expect(home).toBe("/home");

    // Docker's socket, forwarded: the Engine API answers over it.
    const docker = await plain.docker();
    const answer = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      docker.on("data", (chunk: Buffer) => chunks.push(chunk));
      docker.on("end", () => resolve(Buffer.concat(chunks).toString()));
      docker.write("GET /containers/json HTTP/1.0\r\nHost: docker\r\n\r\n");
    });
    expect(answer).toMatch(/^HTTP\/1\.1 200/);

    const withPassphrase = open(() => target({ privateKey: rsa.private, passphrase: PASSPHRASE }));
    await until(withPassphrase, SSH_STATE.connected);
  });

  it("opens the SSH user's login shell with a terminal of the size asked, resizes it, and says how it ended", async () => {
    const session = open(() => target());
    await until(session, SSH_STATE.connected);
    const shell = await session.shell(120, 30);
    const printed: Buffer[] = [];
    shell.socket.on("data", (chunk: Buffer) => printed.push(chunk));
    const ended = new Promise((resolve) => shell.socket.once("close", resolve));
    await shell.resize(100, 40);
    shell.socket.write("exit\r");
    await ended;
    expect(Buffer.concat(printed).toString()).toBe("exit\rlogout\r\n");
    expect(await shell.exitCode()).toBe(0);
    expect(server.shells).toEqual([{ term: "xterm-256color", columns: 120, rows: 30, resizes: ["100x40"] }]);
  });

  describe("a command that does not end", () => {
    const SECRET = "sentinel-database-password";
    const ENCODED = Buffer.from(`DB_PASSWORD=${SECRET}\n`).toString("base64");
    // What saving a Compose .env sends: its text in the command, as base64.
    const composeWrite = `printf %s ${shellQuoted(ENCODED)} | base64 -d > "$dir/.env"`;
    const TIMEOUT_MILLISECONDS = 50;

    const connected = async () => {
      server.exec = () => ({ hang: true });
      const session = open(() => target());
      await until(session, SSH_STATE.connected);
      return session;
    };
    const timeoutOf = (running: Promise<unknown>) =>
      running.then(
        () => {
          throw new Error("it did not time out");
        },
        (error: unknown) => describeError(error),
      );
    const expectNoPayload = (text: string) => {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(ENCODED);
      expect(text).not.toContain("base64");
    };

    it("says it took too long without the command or anything in it", async () => {
      const session = await connected();
      const text = await timeoutOf(session.exec(`sh -c ${shellQuoted(composeWrite)}`, TIMEOUT_MILLISECONDS));
      expectNoPayload(text);
      expect(text).toContain("over SSH");
    });

    it("says the same of one run as root", async () => {
      server.sudoPassword = "alex's own";
      const session = await connected();
      const running = session.asRoot(ROOT_METHOD.sudo, "alex's own", composeWrite, TIMEOUT_MILLISECONDS);
      const text = await timeoutOf(running);
      expectNoPayload(text);
      expect(text).not.toContain("alex's own");
      expect(text).toContain("over SSH");
    });

    it("names the program of a host command, never its arguments", async () => {
      const session = await connected();
      const text = await timeoutOf(sshHostCommand(session)("nvidia-smi", [ENCODED, SECRET], TIMEOUT_MILLISECONDS));
      expectNoPayload(text);
      expect(text).toContain("nvidia-smi");
    });
  });

  describe("bounds on one command", () => {
    const DEADLINE_MILLISECONDS = 200;
    const connected = async () => {
      const session = open(() => target());
      await until(session, SSH_STATE.connected);
      return session;
    };
    const failureOf = (running: Promise<unknown>) =>
      running.then(
        () => "it finished",
        (error: unknown) => describeError(error),
      );

    it("gives up on a channel the host never opens, within its deadline", async () => {
      const session = await connected();
      server.stallExec = true;
      const started = Date.now();
      expect(await failureOf(session.exec("id", DEADLINE_MILLISECONDS))).toContain("did not finish");
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("gives up on a root command the host never opens, within its deadline", async () => {
      const session = await connected();
      server.stallExec = true;
      const running = session.asRoot(ROOT_METHOD.sudo, "alex's own", "id", DEADLINE_MILLISECONDS);
      expect(await failureOf(running)).toContain("did not finish");
    });

    it("stops a command printing without end, saying so, and the session still works", async () => {
      const session = await connected();
      server.exec = (command) => (command === "noisy" ? { flood: true } : { stdout: "fine" });
      const text = await failureOf(session.exec("noisy", 30_000));
      expect(text).toContain("printed more than");
      expect(text).not.toContain("noisy");
      expect((await session.exec("id", 1_000)).stdout).toBe("fine");
    }, 20_000);

    it("stops a root command printing without end the same way", async () => {
      server.sudoPassword = "alex's own";
      const session = await connected();
      server.exec = () => ({ flood: true });
      const text = await failureOf(session.asRoot(ROOT_METHOD.sudo, "alex's own", "noisy", 30_000));
      expect(text).toContain("printed more than");
      // Stopping what it read is all it did: nothing more was sent to end what the command started.
      expect(server.rootCommands).toEqual(["noisy"]);
    }, 20_000);

    it.each([
      ["never answers", () => (server.exec = () => ({ hang: true }))],
      ["prints without end", () => (server.exec = () => ({ flood: true }))],
      ["is never opened", () => (server.stallExec = true)],
    ])(
      "ends a probe whose command %s: the key was accepted, and nothing of its output kept",
      async (_name, stall) => {
        stall();
        const started = Date.now();
        const probe = await probeSsh(target(), 500, "id");
        expect(probe).toMatchObject({ state: SSH_STATE.connected, output: null });
        expect(Date.now() - started).toBeLessThan(5_000);
      },
      10_000,
    );

    it("still hands back all of a probe's output when it fits", async () => {
      server.exec = () => ({ stdout: "docker-socket\n" });
      expect((await probeSsh(target(), 2_000, "id")).output).toBe("docker-socket\n");
    });
  });

  describe("bounds on reading a host's files", () => {
    const connectedFiles = async (timeout: number) => {
      const folder = mkdtempSync(join(tmpdir(), "autoheal-ssh-files-"));
      server.filesRoot = folder;
      const session = open(() => target());
      await until(session, SSH_STATE.connected);
      return { folder, files: new SshHostFiles(session, timeout) };
    };

    it("reads as missing a file the host never answers for, then reads again on a new channel", async () => {
      const { folder, files } = await connectedFiles(200);
      writeFileSync(join(folder, "text"), "hello");
      server.stallFiles = true;
      expect(await files.readText("/text")).toBeNull();
      expect(await files.readEnd("/text", 10)).toBeNull();
      server.stallFiles = false;
      expect(await files.readText("/text")).toBe("hello");
    });

    it("reads a file up to its ceiling, reads one past it as unreadable, and reads what reports no size", async () => {
      const { folder, files } = await connectedFiles(5_000);
      writeFileSync(join(folder, "fits"), "x".repeat(SSH_HOST_FILES.textFileBytes));
      writeFileSync(join(folder, "over"), "x".repeat(SSH_HOST_FILES.textFileBytes + 1));
      writeFileSync(join(folder, "empty"), "");
      symlinkSync("/proc/version", join(folder, "version"));
      expect((await files.readText("/fits"))?.length).toBe(SSH_HOST_FILES.textFileBytes);
      expect(await files.readText("/over")).toBeNull();
      expect(await files.readText("/empty")).toBe("");
      expect(await files.readText("/missing")).toBeNull();
      expect(await files.readText("/version")).toContain("Linux");
    });
  });

  it("refuses a wrong passphrase, a key the host does not accept, and a host key it did not trust", async () => {
    const wrongPassphrase = open(() => target({ privateKey: rsa.private, passphrase: "not it" }));
    await until(wrongPassphrase, SSH_STATE.authenticationFailed);
    expect(wrongPassphrase.state().reason).toMatch(/^The private key could not be read/);

    const stranger = readableKey(() => utils.generateKeyPairSync("ed25519"));
    const refused = open(() => target({ privateKey: stranger.private }));
    await until(refused, SSH_STATE.authenticationFailed);
    expect(refused.state().reason).toBe("The host refused the key for this user.");

    // No key trusted yet: the host's is offered for a person to confirm, and nothing more happens.
    const first = open(() => target({ pinnedHostKey: null }));
    await until(first, SSH_STATE.hostKeyOffered);
    expect(first.state().offeredHostKey).toEqual({
      key: server.hostKeyBlob(),
      fingerprint: sshFingerprint(Buffer.from(server.hostKeyBlob(), "base64")),
    });
    expect(first.state().offeredHostKey!.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    await expect(first.docker()).rejects.toThrow("the SSH session is hostKeyOffered, not connected");
  });

  it("refuses a changed host key, naming both, and dials again by itself after the host comes back", async () => {
    let current = target();
    const session = open(() => current);
    await until(session, SSH_STATE.connected);

    // The host restarts: the session drops, waits, and connects again by itself.
    await server.restart();
    await until(session, SSH_STATE.connected);

    // The host comes back with another key: refused, both fingerprints named, and no further dialling.
    const trusted = sshFingerprint(Buffer.from(server.hostKeyBlob(), "base64"));
    server.hostKey = FakeSshServer.newHostKey();
    await server.restart();
    await until(session, SSH_STATE.hostKeyChanged);
    const offered = session.state().offeredHostKey!;
    expect(session.state().reason).toBe(
      `The host's key changed: ${trusted} was trusted, and it now offers ${offered.fingerprint}.`,
    );
    await new Promise((resolve) => setTimeout(resolve, 3 * FAST.reconnectMostMilliseconds));
    expect(session.state().state).toBe(SSH_STATE.hostKeyChanged);

    // A person trusts the new key: the session connects with it.
    current = { ...current, pinnedHostKey: offered.key };
    session.start();
    await until(session, SSH_STATE.connected);
  });

  it("waits and dials again while its target cannot be read, as during a database restore", async () => {
    let unreadable = 2;
    const session = open(() => {
      if (unreadable > 0) {
        unreadable -= 1;
        throw new Error("restore in progress");
      }
      return target();
    });
    expect(session.state()).toMatchObject({ state: SSH_STATE.unreachable, reason: "restore in progress" });
    await until(session, SSH_STATE.connected);
    expect(unreadable).toBe(0);
  });
});
