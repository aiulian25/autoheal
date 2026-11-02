import {
  OPERATOR_REFUSAL,
  OPERATOR_ISOLATION_REFUSAL,
  operatorAccessTarget,
  type OperatorAccessAuthorizer,
} from "./operator-authorization.js";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CONTAINER_ACCESS_REFUSALS,
  HOST_TERMINAL_REFUSALS,
  HOST_TERMINAL_TARGET,
  RUNNER_MESSAGES,
  TERMINAL_CLOSE_GRACE_MILLISECONDS,
  TERMINAL_CLOSE_KEYS,
  TERMINAL_ANSWER_PAUSE_MILLISECONDS,
  TERMINAL_CURSOR_ANSWER,
  TERMINAL_EXITED,
  TERMINAL_OUTPUT_CHUNK_BYTES,
  TERMINAL_OUTPUT_FLUSH_MILLISECONDS,
} from "../shared/constants.js";
import { describeError } from "../shared/errors.js";
import { log } from "../shared/log.js";
import type { TerminalEnd, TerminalStart } from "../shared/protocol.js";
import { containerAccessRefusal, type ContainerAccessSettings } from "./container-access-guard.js";
import type { ControlPlaneClient } from "./control-plane-client.js";
import type { DockerClient, ShellStream } from "./docker-client.js";

// As a person would: stop what runs, end the shell, and cut the stream should something still hold it open.
function close(shell: ShellStream) {
  shell.socket.end(TERMINAL_CLOSE_KEYS);
  setTimeout(() => shell.socket.destroy(), TERMINAL_CLOSE_GRACE_MILLISECONDS).unref();
}

/**
 * Types into the shell, each terminal's answer to the shell's question for the cursor on its own: busybox's line
 * editor reads on for 50 ms after an escape it does not know at once, as `ESC[1;5R` looks like Ctrl and an arrow,
 * then drops all it read, the keys typed behind the answer with it.
 */
async function typeInto(shell: ShellStream, data: string) {
  for (const piece of data.split(TERMINAL_CURSOR_ANSWER).filter((part) => part !== "")) {
    shell.socket.write(piece);
    if (TERMINAL_CURSOR_ANSWER.test(piece)) {
      await sleep(TERMINAL_ANSWER_PAUSE_MILLISECONDS);
    }
  }
}

/** A shell on the host itself: over its SSH session, or through a helper container that enters the host. */
export type HostShellOpener = (columns: number, rows: number) => Promise<ShellStream>;

export interface TerminalSessionsDependencies {
  authorizeOperator?: OperatorAccessAuthorizer;
  // None on a host watched for its system alone: only its own shell opens there.
  docker:
    | (Pick<DockerClient, "inspect" | "openShell"> &
        Partial<Pick<DockerClient, "containerSummaries" | "inspectVolume">>)
    | null;
  hostShell: HostShellOpener | null;
  controlPlane: Pick<ControlPlaneClient, "terminalInput" | "terminalOutput" | "terminalEnd">;
  settings: ContainerAccessSettings & { hostTerminal: boolean };
}

// Why a shell on the host is not opened; null when it is. Its own .env decides, as for reaching inside containers.
function hostTerminalRefusal(settings: TerminalSessionsDependencies["settings"]): string | null {
  if (!settings.hostTerminal) return HOST_TERMINAL_REFUSALS.off;
  return settings.dryRun ? HOST_TERMINAL_REFUSALS.dryRun : null;
}

const targetOf = (terminal: TerminalStart) => terminal.containerName ?? HOST_TERMINAL_TARGET;

/**
 * Shells people opened in the dashboard, each in its container or on the host itself: what they type is fetched as
 * it comes, and what the shell prints goes back in small bursts. The host decides first, as for any action: its .env
 * must let people reach inside containers, or onto the host, and a protected container, the runner's own and dry-run
 * are refused.
 */
export class TerminalSessions {
  // Shells running now, so one asked for twice opens once.
  private stopping = false;
  private readonly shells = new Set<ShellStream>();
  private readonly running = new Set<string>();

  constructor(private readonly dependencies: TerminalSessionsDependencies) {}

  stop() {
    this.stopping = true;
    for (const shell of this.shells) close(shell);
  }

  start(terminal: TerminalStart) {
    if (this.stopping || this.running.has(terminal.id)) {
      return;
    }
    this.running.add(terminal.id);
    void this.run(terminal)
      .catch((error: unknown) => this.end(terminal, { exitCode: null, reason: describeError(error) }))
      .finally(() => this.running.delete(terminal.id));
  }

  /** Resolves when every shell started so far has ended; for tests. */
  async settled() {
    while (this.running.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, TERMINAL_OUTPUT_FLUSH_MILLISECONDS));
    }
  }

  private async run(terminal: TerminalStart) {
    const shell =
      terminal.containerName === null
        ? await this.openOnHost(terminal)
        : await this.openInContainer(terminal, terminal.containerName);
    if (shell === null) return;
    this.shells.add(shell);
    if (this.stopping) close(shell);
    log(RUNNER_MESSAGES.terminalOpened(targetOf(terminal), terminal.requestedBy));
    let ended = false;
    const printed = this.forward(terminal.id, shell).finally(() => {
      ended = true;
    });
    // Typing goes on beside it, and stops at its next answer once the shell has ended: the end is told at once.
    void this.feed(terminal.id, shell, () => ended);
    await printed.finally(() => this.shells.delete(shell));
    await this.end(terminal, { exitCode: await shell.exitCode().catch(() => null), reason: null });
  }

  private async openOnHost(terminal: TerminalStart): Promise<ShellStream | null> {
    const { hostShell, settings } = this.dependencies;
    if (hostShell === null) return this.refuse(terminal, HOST_TERMINAL_REFUSALS.unavailable);
    const refusal = hostTerminalRefusal(settings);
    if (refusal !== null) return this.refuse(terminal, refusal);
    return this.stopping ? null : hostShell(terminal.columns, terminal.rows);
  }

  private async openInContainer(terminal: TerminalStart, containerName: string): Promise<ShellStream | null> {
    const { settings, docker } = this.dependencies;
    if (docker === null) return this.refuse(terminal, CONTAINER_ACCESS_REFUSALS.noDocker);
    const refusal = await containerAccessRefusal(containerName, settings, docker);
    if (refusal !== null) return this.refuse(terminal, refusal);
    if (terminal.operatorUserId !== undefined) {
      const target = await operatorAccessTarget(containerName, docker);
      const authorized =
        target !== null && (await this.dependencies.authorizeOperator?.(terminal.id, target).catch(() => false));
      if (target === null) return this.refuse(terminal, OPERATOR_ISOLATION_REFUSAL);
      if (!authorized) return this.refuse(terminal, OPERATOR_REFUSAL);
    }
    return this.stopping ? null : docker.openShell(containerName, terminal.columns, terminal.rows);
  }

  private async refuse(terminal: TerminalStart, reason: string): Promise<null> {
    await this.end(terminal, { exitCode: null, reason });
    return null;
  }

  /**
   * What the shell prints, gathered for a moment and sent in pieces the control plane takes. The shell is
   * paused while a piece is on its way, so one that floods its screen waits for the network instead of
   * filling the runner's memory. Resolves once the shell has ended and everything it printed is sent.
   */
  private forward(terminalId: string, shell: ShellStream): Promise<void> {
    const { controlPlane } = this.dependencies;
    return new Promise((resolve) => {
      let gathered: Buffer[] = [];
      let timer: NodeJS.Timeout | null = null;
      let sending: Promise<unknown> = Promise.resolve();
      let finished = false;
      const flush = () => {
        timer = null;
        const bytes = Buffer.concat(gathered);
        gathered = [];
        if (bytes.length === 0) {
          return;
        }
        shell.socket.pause();
        for (let start = 0; start < bytes.length; start += TERMINAL_OUTPUT_CHUNK_BYTES) {
          const piece = bytes.subarray(start, start + TERMINAL_OUTPUT_CHUNK_BYTES).toString("base64");
          sending = sending.then(() => controlPlane.terminalOutput(terminalId, piece)).catch(() => undefined);
        }
        sending = sending.then(() => shell.socket.resume());
      };
      shell.socket.on("data", (data: Buffer) => {
        gathered.push(data);
        timer ??= setTimeout(flush, TERMINAL_OUTPUT_FLUSH_MILLISECONDS);
      });
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        clearTimeout(timer ?? undefined);
        flush();
        void sending.then(() => resolve());
      };
      shell.socket.on("end", finish);
      shell.socket.on("close", finish);
      shell.socket.on("error", finish);
    });
  }

  // What is typed, as it comes: typed into the shell, a new size passed on, and a close ends it. A control
  // plane that forgot the shell (it started again) or can't be reached leaves nobody to type: it ends too.
  private async feed(terminalId: string, shell: ShellStream, ended: () => boolean) {
    try {
      while (!ended() && !this.stopping) {
        const input = await this.dependencies.controlPlane.terminalInput(terminalId);
        if (this.stopping) return;
        for (const data of input.data) {
          await typeInto(shell, data);
        }
        if (input.size !== null) {
          await shell.resize(input.size.columns, input.size.rows).catch(() => undefined);
        }
        if (input.closed) {
          close(shell);
          return;
        }
      }
    } catch {
      close(shell);
    }
  }

  private async end(terminal: TerminalStart, end: TerminalEnd) {
    log(RUNNER_MESSAGES.terminalEnded(targetOf(terminal), end.reason ?? TERMINAL_EXITED(end.exitCode)));
    await this.dependencies.controlPlane.terminalEnd(terminal.id, end).catch(() => undefined);
  }
}
