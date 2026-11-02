import { randomUUID } from "node:crypto";
import { HOST_TERMINAL_HELPER } from "../shared/constants.js";
import type { DockerClient, ShellStream } from "./docker-client.js";
import type { HostScript } from "./installs.js";
import type { HostShellOpener } from "./terminal-sessions.js";

/**
 * Root's login shell on the runner's own host, through a helper container of its own image: privileged, in the
 * host's process namespace, holding still while nsenter enters the host's first process's namespaces. The helper
 * goes once the shell's end is read; one a runner left behind goes by itself when its hold runs out.
 */
export function hostShellThroughDocker(
  docker: Pick<DockerClient, "inspect" | "create" | "start" | "remove" | "openShell">,
  selfContainerName: string,
): HostShellOpener {
  return async (columns, rows): Promise<ShellStream> => {
    const self = await docker.inspect(selfContainerName);
    if (self?.Image === undefined) {
      throw new Error(`the runner cannot find its own container, ${selfContainerName}`);
    }
    const name = `${HOST_TERMINAL_HELPER.containerPrefix}${randomUUID()}`;
    await docker.create(name, {
      Image: self.Image,
      User: HOST_TERMINAL_HELPER.user,
      Entrypoint: HOST_TERMINAL_HELPER.hold(HOST_TERMINAL_HELPER.holdHours),
      Cmd: [],
      Labels: { [HOST_TERMINAL_HELPER.label]: HOST_TERMINAL_HELPER.labelValue },
      Healthcheck: { Test: [HOST_TERMINAL_HELPER.noHealthcheck] },
      HostConfig: {
        Privileged: true,
        PidMode: HOST_TERMINAL_HELPER.pidMode,
        NetworkMode: HOST_TERMINAL_HELPER.network,
        AutoRemove: true,
      },
    });
    const removed = () => void docker.remove(name).catch(() => undefined);
    try {
      await docker.start(name);
      const shell = await docker.openShell(name, columns, rows, HOST_TERMINAL_HELPER.shell);
      return { ...shell, exitCode: () => shell.exitCode().finally(removed) };
    } catch (error) {
      removed();
      throw error;
    }
  };
}

const HELPER_POLL_MILLISECONDS = 500;
const HELPER_OUTPUT_LINES = 400;

/**
 * Runs a POSIX sh script as root on the runner's own host, through the same helper: it enters the host, runs it and
 * ends. A script holds no secret's value, which it makes on the host, so its command line may show in Docker for
 * as long as it runs.
 */
export function hostScriptThroughDocker(
  docker: Pick<DockerClient, "inspect" | "create" | "start" | "remove" | "logs">,
  selfContainerName: string,
  wait: (milliseconds: number) => Promise<unknown>,
  clock: () => number,
): HostScript {
  return async (script, timeoutMilliseconds) => {
    const self = await docker.inspect(selfContainerName);
    if (self?.Image === undefined) {
      throw new Error(`the runner cannot find its own container, ${selfContainerName}`);
    }
    const name = `${HOST_TERMINAL_HELPER.containerPrefix}${randomUUID()}`;
    await docker.create(name, {
      Image: self.Image,
      User: HOST_TERMINAL_HELPER.user,
      Entrypoint: [...HOST_TERMINAL_HELPER.enter, "sh", "-c", script],
      Cmd: [],
      Labels: { [HOST_TERMINAL_HELPER.label]: HOST_TERMINAL_HELPER.labelValue },
      Healthcheck: { Test: [HOST_TERMINAL_HELPER.noHealthcheck] },
      HostConfig: {
        Privileged: true,
        PidMode: HOST_TERMINAL_HELPER.pidMode,
        NetworkMode: HOST_TERMINAL_HELPER.network,
      },
    });
    try {
      await docker.start(name);
      const started = clock();
      while (clock() - started < timeoutMilliseconds) {
        const state = (await docker.inspect(name))?.State;
        if (state?.Running !== true) {
          return { exitCode: state?.ExitCode ?? null, output: await docker.logs(name, false, HELPER_OUTPUT_LINES) };
        }
        await wait(HELPER_POLL_MILLISECONDS);
      }
      return { exitCode: null, output: "" };
    } finally {
      await docker.remove(name).catch(() => undefined);
    }
  };
}
