import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import { Client, type SFTPWrapper } from "ssh2";
import type { ShellStream } from "../../runner/docker-client.js";
import {
  HOST_TERMINAL_SSH,
  SSH_FINGERPRINT_PREFIX,
  SSH_HOST_FILES,
  SSH_KEY,
  SSH_SESSION,
  SSH_STATE,
  SSH_TEXT,
  type RootMethod,
  type SshState,
} from "../../shared/constants.js";
import { describeError } from "../../shared/errors.js";
import { runBounded } from "./ssh-exec.js";
import { runAsRoot } from "./ssh-root.js";

/** Where and as whom to connect. Read again at each dial, so a replaced key or a trusted host key takes effect. */
export interface SshTarget {
  address: string;
  port: number;
  user: string;
  privateKey: string;
  passphrase: string | null;
  // The host key a person trusted, base64; null until one is.
  pinnedHostKey: string | null;
}

export interface SshExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface SshSessionView {
  state: SshState;
  since: number;
  reason: string | null;
  // The host key the host offered when none was trusted yet, or when it changed: for a person to confirm.
  offeredHostKey: { key: string; fingerprint: string } | null;
}

// How long to wait before dialling again; tests shorten it.
export type SshReconnectTiming = Pick<typeof SSH_SESSION, "reconnectFirstMilliseconds" | "reconnectMostMilliseconds">;

const ERROR_LEVEL_AUTHENTICATION = "client-authentication";
// States a new dial cannot fix: a person must trust a key or give another.
const NEEDS_A_PERSON: readonly SshState[] = [
  SSH_STATE.hostKeyOffered,
  SSH_STATE.hostKeyChanged,
  SSH_STATE.authenticationFailed,
  SSH_STATE.closed,
];

/** A host key's fingerprint as `ssh-keygen -lf` prints it. */
export const sshFingerprint = (key: Buffer) =>
  `${SSH_FINGERPRINT_PREFIX}${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;

/**
 * One host's SSH session: dialled with the host's own key, its host key checked against the trusted one, kept
 * alive, and dialled again with a growing wait when the network drops it. Docker, commands and files go over it.
 */
export class SshSession {
  private client: Client | null = null;
  private view: SshSessionView;
  private retry: NodeJS.Timeout | null = null;
  // Until then it is dialled again at the shortest pause: a host coming back from a reboot is seen as soon as it answers.
  private quickUntil = 0;
  private failures = 0;
  private readonly listeners = new Set<(view: SshSessionView) => void>();

  constructor(
    private readonly target: () => SshTarget,
    private readonly clock: () => number = Date.now,
    private readonly timing: SshReconnectTiming = SSH_SESSION,
  ) {
    this.view = { state: SSH_STATE.connecting, since: clock(), reason: null, offeredHostKey: null };
  }

  /** Dials now; a person's fix (a trusted key, another key) calls this again. */
  start() {
    this.clearRetry();
    this.client?.end();
    this.dial();
  }

  state(): SshSessionView {
    return this.view;
  }

  /** Called with the session's view whenever its state changes. */
  onChange(listener: (view: SshSessionView) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Async, as exec and sftp are: a session that is not connected refuses through the promise, never by a throw.
  /** A stream to the host's Docker socket, as `docker -H ssh://` reaches it. */
  async docker(): Promise<Duplex> {
    const client = this.connected();
    return new Promise((resolve, reject) =>
      client.openssh_forwardOutStreamLocal(SSH_SESSION.dockerSocketPath, (error, channel) =>
        error ? reject(error) : resolve(channel),
      ),
    );
  }

  /** Runs one command; its output, and its exit code (null when a signal ended it). */
  async exec(
    command: string,
    timeoutMilliseconds: number,
    operation: string = SSH_TEXT.commandOperation,
  ): Promise<SshExecResult> {
    const client = this.connected();
    return runBounded((opened) => client.exec(command, opened), { timeoutMilliseconds, operation });
  }

  /** The SSH user's login shell with a terminal, as `ssh -t` gives it; its exit code once it has ended. */
  async shell(columns: number, rows: number): Promise<ShellStream> {
    const client = this.connected();
    return new Promise((resolve, reject) =>
      client.shell({ term: HOST_TERMINAL_SSH.term, cols: columns, rows }, (error, channel) => {
        if (error) {
          reject(error);
          return;
        }
        let exitCode: number | null = null;
        channel.once("exit", (code: number | null) => {
          exitCode = code ?? null;
        });
        resolve({
          socket: channel,
          resize: async (newColumns, newRows) => {
            channel.setWindow(newRows, newColumns, 0, 0);
          },
          exitCode: async () => exitCode,
        });
      }),
    );
  }

  /** A command as root, with the password a person saved for this host: no prompt, no approval. */
  async asRoot(method: RootMethod, password: string, command: string, timeout?: number): Promise<SshExecResult> {
    return runAsRoot(this.connected(), method, password, command, timeout);
  }

  async sftp(): Promise<SFTPWrapper> {
    const client = this.connected();
    const timeout = SSH_HOST_FILES.commandTimeoutMilliseconds;
    return new Promise((resolve, reject) => {
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        reject(new Error(SSH_TEXT.timedOut(SSH_TEXT.fileChannelOperation, timeout)));
      }, timeout);
      client.sftp((error, sftp) => {
        clearTimeout(timer);
        if (late) sftp?.end();
        if (error) reject(error);
        else resolve(sftp);
      });
    });
  }

  /** Ends the session for good: the host was removed, or the control plane stops. */
  close() {
    this.clearRetry();
    this.change(SSH_STATE.closed, null);
    this.client?.end();
    this.client = null;
  }

  private dial() {
    const target = this.readTarget();
    if (target === null) return;
    const client = new Client();
    this.client = client;
    this.change(SSH_STATE.connecting, null);
    client.on("ready", () => {
      // Many small requests go out at once (SFTP reads, Docker calls): without this, each after the first waits for
      // the host's delayed acknowledgement, some 40 ms.
      client.setNoDelay(true);
      this.failures = 0;
      this.change(SSH_STATE.connected, null);
    });
    client.on("error", (error: Error & { level?: string }) => {
      if (this.client !== client || NEEDS_A_PERSON.includes(this.view.state)) return;
      if (error.level === ERROR_LEVEL_AUTHENTICATION) {
        this.change(SSH_STATE.authenticationFailed, SSH_TEXT.refused);
        return;
      }
      this.change(SSH_STATE.unreachable, describeError(error));
    });
    client.on("close", () => {
      if (this.client !== client || NEEDS_A_PERSON.includes(this.view.state)) return;
      if (this.view.state !== SSH_STATE.unreachable) {
        this.change(SSH_STATE.unreachable, null);
      }
      this.scheduleRetry();
    });
    try {
      client.connect({
        host: target.address,
        port: target.port,
        username: target.user,
        privateKey: target.privateKey,
        passphrase: target.passphrase ?? undefined,
        readyTimeout: SSH_SESSION.connectTimeoutMilliseconds,
        keepaliveInterval: SSH_SESSION.keepaliveIntervalMilliseconds,
        keepaliveCountMax: SSH_SESSION.keepaliveMisses,
        hostVerifier: (key: Buffer) => this.verifyHostKey(key, target.pinnedHostKey),
      });
    } catch (error) {
      // ssh2 reads the private key before dialling: a wrong passphrase or a key it cannot read ends here.
      this.change(SSH_STATE.authenticationFailed, SSH_TEXT.keyUnreadable(describeError(error)));
    }
  }

  // Reading the target can fail for a while (a database restore) or until a person acts (a key sealed with another
  // passphrase): either way it is tried again later, and the reason shown meanwhile.
  private readTarget(): SshTarget | null {
    try {
      return this.target();
    } catch (error) {
      this.change(SSH_STATE.unreachable, describeError(error));
      this.scheduleRetry();
      return null;
    }
  }

  private verifyHostKey(key: Buffer, pinned: string | null): boolean {
    const offered = { key: key.toString("base64"), fingerprint: sshFingerprint(key) };
    if (pinned === null) {
      this.change(SSH_STATE.hostKeyOffered, null, offered);
      return false;
    }
    if (pinned === offered.key) {
      return true;
    }
    const trusted = sshFingerprint(Buffer.from(pinned, "base64"));
    this.change(SSH_STATE.hostKeyChanged, SSH_TEXT.hostKeyChanged(trusted, offered.fingerprint), offered);
    return false;
  }

  /** Dialled again at the shortest pause until then, a longer pause already waited on cut short. */
  redialSoon(until: number) {
    this.quickUntil = Math.max(this.quickUntil, until);
    if (this.retry !== null && this.failures > 1) {
      this.clearRetry();
      this.failures = 0;
      this.scheduleRetry();
    }
  }

  private scheduleRetry() {
    const growing = Math.min(
      this.timing.reconnectFirstMilliseconds * 2 ** this.failures,
      this.timing.reconnectMostMilliseconds,
    );
    const wait = this.clock() < this.quickUntil ? this.timing.reconnectFirstMilliseconds : growing;
    this.failures += 1;
    this.retry = setTimeout(() => this.dial(), wait);
  }

  private clearRetry() {
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
  }

  private connected(): Client {
    if (this.view.state !== SSH_STATE.connected || this.client === null) {
      throw new Error(SSH_TEXT.notConnected(this.view.state));
    }
    return this.client;
  }

  private change(state: SshState, reason: string | null, offeredHostKey: SshSessionView["offeredHostKey"] = null) {
    this.view = { state, since: this.clock(), reason, offeredHostKey };
    this.listeners.forEach((listener) => listener(this.view));
  }
}

/** How one probe ended, the host key the host offered on the way, and what its command printed. */
export interface SshProbe {
  state: SshState;
  hostKey: { key: string; fingerprint: string } | null;
  // Null without a command, or when it could not run.
  output: string | null;
}

/**
 * One connection, closed at once: proves the key opens the host and reads the host key it offers. Without a trusted
 * host key, the offered one is accepted for this connection alone (with key authentication nothing the host could
 * reuse is sent), so a person can compare its fingerprint before anything is stored. With one, a different key ends it.
 * A command given runs once the key is accepted, and what it prints comes back.
 */
export function probeSsh(
  target: SshTarget,
  timeoutMilliseconds: number,
  command: string | null = null,
): Promise<SshProbe> {
  // One time limit for dialling and the command together; readyTimeout covers only the first.
  const deadline = Date.now() + timeoutMilliseconds;
  return new Promise((resolve) => {
    const client = new Client();
    let hostKey: SshProbe["hostKey"] = null;
    let output: string | null = null;
    let settled = false;
    const settle = (state: SshState) => {
      if (settled) return;
      settled = true;
      client.end();
      resolve({ state, hostKey, output });
    };
    const run = (line: string) =>
      runBounded((opened) => client.exec(line, opened), {
        timeoutMilliseconds: Math.max(0, deadline - Date.now()),
        operation: SSH_TEXT.commandOperation,
        outputLimitBytes: SSH_KEY.probeOutputBytes,
      }).then(
        (result) => {
          output = result.stdout;
          settle(SSH_STATE.connected);
        },
        () => settle(SSH_STATE.connected),
      );
    client.on("ready", () => (command === null ? settle(SSH_STATE.connected) : run(command)));
    client.on("error", (error: Error & { level?: string }) => {
      const refused = error.level === ERROR_LEVEL_AUTHENTICATION;
      settle(refused ? SSH_STATE.authenticationFailed : SSH_STATE.unreachable);
    });
    client.on("close", () => settle(SSH_STATE.unreachable));
    try {
      client.connect({
        host: target.address,
        port: target.port,
        username: target.user,
        privateKey: target.privateKey,
        passphrase: target.passphrase ?? undefined,
        readyTimeout: timeoutMilliseconds,
        hostVerifier: (key: Buffer) => {
          hostKey = { key: key.toString("base64"), fingerprint: sshFingerprint(key) };
          if (target.pinnedHostKey === null || target.pinnedHostKey === hostKey.key) return true;
          settle(SSH_STATE.hostKeyChanged);
          return false;
        },
      });
    } catch {
      settle(SSH_STATE.authenticationFailed);
    }
  });
}
