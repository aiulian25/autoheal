import type { Client } from "ssh2";
import { ROOT_COMMANDS, ROOT_METHOD, ROOT_METHODS, SSH_TEXT, type RootMethod } from "../../shared/constants.js";
import { runBounded } from "./ssh-exec.js";
import { shellQuoted } from "./ssh-host-files.js";
import type { SshExecResult } from "./ssh-session.js";

const LINE_END = "\n";

/**
 * One command as root, with the saved password: sudo reads it from its input; su asks for it in a terminal, and it is
 * typed at the first thing su prints, its prompt. The password never goes on a command line.
 */
export function runAsRoot(
  client: Client,
  method: RootMethod,
  password: string,
  command: string,
  timeout: number = ROOT_COMMANDS.timeoutMilliseconds,
): Promise<SshExecResult> {
  const line = ROOT_COMMANDS[method](shellQuoted(command));
  const terminal = method === ROOT_METHOD.su;
  return runBounded(
    (opened) => client.exec(line, { pty: terminal }, opened),
    { timeoutMilliseconds: timeout, operation: SSH_TEXT.rootCommandOperation },
    (channel) => {
      if (terminal) channel.once("data", () => channel.write(`${password}${LINE_END}`));
      else channel.end(`${password}${LINE_END}`);
    },
  );
}

/** Which way the password makes root: sudo for the user's own, su for root's; null when it opens neither. */
export async function findRootMethod(
  run: (method: RootMethod, command: string) => Promise<SshExecResult>,
): Promise<RootMethod | null> {
  for (const method of ROOT_METHODS) {
    const result = await run(method, ROOT_COMMANDS.check).catch(() => null);
    const lastLine = result?.stdout.trim().split(LINE_END).at(-1)?.trim();
    if (result?.exitCode === 0 && lastLine === ROOT_COMMANDS.rootUserId) return method;
  }
  return null;
}
