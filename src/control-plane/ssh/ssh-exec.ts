import type { ClientCallback, ClientChannel } from "ssh2";
import { SSH_SESSION, SSH_TEXT } from "../../shared/constants.js";
import type { SshExecResult } from "./ssh-session.js";

export interface SshExecBounds {
  // From before the channel is asked for: a host that never opens one is held to it too.
  timeoutMilliseconds: number;
  // For its errors: what it is, never its text.
  operation: string;
  // Its output and errors together; a command past it is stopped, not cut short and read as if whole.
  outputLimitBytes?: number;
}

/**
 * One command on a channel, settled once: by its end, by its deadline, by printing too much, or by the channel not
 * opening. Only its own channel closes. What the command started on the host, such as a package unit, is not its to
 * stop: a unit outlives this as it outlives the session.
 */
export function runBounded(
  open: (opened: ClientCallback) => void,
  { timeoutMilliseconds, operation, outputLimitBytes = SSH_SESSION.outputLimitBytes }: SshExecBounds,
  onChannel: (channel: ClientChannel) => void = () => {},
): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let channel: ClientChannel | null = null;
    let printed = 0;
    let settled = false;

    const collector = (chunks: Buffer[]) => (chunk: Buffer) => {
      printed += chunk.length;
      if (printed > outputLimitBytes) {
        abandon(new Error(SSH_TEXT.printedTooMuch(operation, outputLimitBytes)));
        return;
      }
      chunks.push(chunk);
    };
    const onStdout = collector(stdout);
    const onStderr = collector(stderr);
    const onClose = (code: number | null) => {
      if (!settle()) return;
      resolve({
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        exitCode: code ?? null,
      });
    };
    const settle = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      channel?.off("data", onStdout);
      channel?.stderr.off("data", onStderr);
      channel?.off("close", onClose);
      return true;
    };
    const abandon = (error: unknown) => {
      if (!settle()) return;
      channel?.close();
      reject(error);
    };
    const timer = setTimeout(
      () => abandon(new Error(SSH_TEXT.timedOut(operation, timeoutMilliseconds))),
      timeoutMilliseconds,
    );

    try {
      open((error, opened) => {
        if (error) {
          abandon(error);
          return;
        }
        if (settled) {
          opened.close();
          return;
        }
        channel = opened;
        opened.on("data", onStdout);
        opened.stderr.on("data", onStderr);
        opened.on("close", onClose);
        onChannel(opened);
      });
    } catch (error) {
      abandon(error);
    }
  });
}
