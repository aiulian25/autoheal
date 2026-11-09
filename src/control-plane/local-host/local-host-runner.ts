import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { loadRunnerConfig, type ControlPlaneSettings, type RunnerConfig } from "../../config/runner-config.js";
import { createRuntime, localRunnerPorts, startRunner, type RunnerPorts } from "../../runner/application.js";
import { DockerClient } from "../../runner/docker-client.js";
import { kernelBootId } from "../../runner/guard-state.js";
import { containerNameOf } from "../../runner/incident-report.js";
import { LocalDockerConnection } from "../../runner/local-docker-connection.js";
import {
  DEFAULT_DOCKER_SOCKET_PATH,
  ENV_CONTROL_PLANE_URL,
  ENV_DOCKER_SOCKET_PATH,
  ENV_JOIN_CODE,
  ENV_RUNNER_TOKEN,
  LOCAL_HOST,
  SELF_UPDATE,
} from "../../shared/constants.js";
import { describeError } from "../../shared/errors.js";
import { log } from "../../shared/log.js";
import { runnerContainerRunning } from "../hosts/runner-container.js";
import { LocalHostUnready, type LocalHostService, type LocalRunnerDetails } from "./local-host-service.js";

type StopRunner = () => Promise<void>;

export interface LocalHostRunnerDependencies {
  hosts: Pick<LocalHostService, "ensure">;
  // The runner API on loopback, and its certificate's key: as an SSH host's runner reaches it.
  controlPlane: Omit<ControlPlaneSettings, "token">;
  // The control plane's own environment: the .env a runner container on this machine would have read. Null where it
  // runs without one (tests): never in place.
  environment: NodeJS.ProcessEnv | null;
  // Docker names a container's hostname after its id: how the control plane finds its own container.
  ownContainer?: string;
  // What its runner reaches the machine through: a runner container's own, by default.
  portsOf?: (config: RunnerConfig) => RunnerPorts;
}

/**
 * This machine's settings from its .env, as its runner container read them, reaching the control plane on loopback
 * with its host's token. Autoheal's own container, its update helper and the one an update keeps aside are never
 * acted on, as a runner never acts on itself.
 */
export function localRunnerConfig(
  environment: NodeJS.ProcessEnv,
  details: LocalRunnerDetails,
  controlPlane: Omit<ControlPlaneSettings, "token">,
  selfContainerName: string,
): RunnerConfig {
  const config = loadRunnerConfig(
    {
      ...environment,
      [ENV_JOIN_CODE]: undefined,
      [ENV_CONTROL_PLANE_URL]: controlPlane.url,
      [ENV_RUNNER_TOKEN]: details.token,
    },
    LOCAL_HOST.noJoinFile,
  );
  return {
    ...config,
    selfContainerName,
    controlPlane: { ...controlPlane, token: details.token },
    joinFile: null,
    protectedContainers: new Set([
      ...config.protectedContainers,
      selfContainerName,
      `${selfContainerName}${SELF_UPDATE.previousSuffix}`,
      SELF_UPDATE.helperName,
    ]),
  };
}

/**
 * The control plane's own machine, looked after from inside its container: the runner
 * engine in this process, on the Docker socket and the host's files mounted into it, as a runner container would have
 * them. Only where the socket is mounted; while a runner container still runs here it waits, saying so, and a revoked
 * host has none.
 */
export class LocalHostRunner {
  private running = false;
  private paused = false;
  // Settles once every runner stopped so far has: no two run against this machine at once.
  private stopped: Promise<unknown> = Promise.resolve();
  private hostId: string | null = null;
  private runner: Promise<StopRunner | null> | null = null;
  private problem: string | null = null;
  readonly socketPath: string;

  constructor(private readonly dependencies: LocalHostRunnerDependencies) {
    this.socketPath = dependencies.environment?.[ENV_DOCKER_SOCKET_PATH] ?? DEFAULT_DOCKER_SOCKET_PATH;
  }

  /** Whether this machine is looked after in place: the Docker socket is mounted into the control plane's container. */
  inPlace(): boolean {
    return this.dependencies.environment !== null && existsSync(this.socketPath);
  }

  begin() {
    if (!this.inPlace()) return;
    this.running = true;
    this.tick();
  }

  /** Its runner started where it can be, again after one that could not start; stopped once its host is revoked. */
  tick() {
    if (!this.running || this.paused) return;
    let details: LocalRunnerDetails | null;
    try {
      details = this.dependencies.hosts.ensure();
    } catch (error) {
      // Said once, and on its host's page; the next tick tries again, and the rest of the round runs on meanwhile.
      if (error instanceof LocalHostUnready) this.hostId = error.hostId;
      const problem = describeError(error);
      if (problem !== this.problem) log(LOCAL_HOST.failed(problem));
      this.problem = problem;
      return;
    }
    if (details === null) {
      this.hostId = null;
      void this.stopRunner();
      return;
    }
    this.hostId = details.hostId;
    if (this.runner === null) {
      const starting: Promise<StopRunner | null> = this.start(details).then((stop) => {
        if (stop === null && this.runner === starting) this.runner = null;
        return stop;
      });
      this.runner = starting;
    }
  }

  /** A restore is about to replace its host's token: as for an SSH host's runner, it does not wait for this one. */
  pause() {
    this.paused = true;
    void this.stopRunner();
  }

  /**
   * Started anew from the database as it now is. A restore that fails after this comes back here for the file it puts
   * back, so a runner started a moment ago with the other file's token goes first. Nothing here may fail that restore.
   */
  resume() {
    this.pause();
    this.paused = false;
    try {
      this.tick();
    } catch (error) {
      log(LOCAL_HOST.failed(describeError(error)));
    }
  }

  async stop() {
    this.running = false;
    await this.stopRunner();
  }

  /** For the hosts API: why this machine's runner has not started, or null once it has; null for any other host. */
  inPlaceOf(hostId: string): { problem: string | null } | null {
    return hostId === this.hostId ? { problem: this.problem } : null;
  }

  private async start(details: LocalRunnerDetails): Promise<StopRunner | null> {
    const environment = this.dependencies.environment!;
    await this.stopped;
    try {
      const connection = new LocalDockerConnection(this.socketPath);
      if (await runnerContainerRunning(connection)) {
        throw new Error(LOCAL_HOST.runnerStillThere);
      }
      const ownName = this.dependencies.ownContainer ?? hostname();
      const own = await new DockerClient(connection).inspect(ownName);
      if (own === null) {
        throw new Error(LOCAL_HOST.ownContainerUnknown(ownName));
      }
      const config = localRunnerConfig(environment, details, this.dependencies.controlPlane, containerNameOf(own));
      const ports = {
        ...(this.dependencies.portsOf ?? localRunnerPorts)(config),
        localHost: { currentBoot: kernelBootId, aliveFile: LOCAL_HOST.aliveFile },
        reconnect: () => ({ ...this.dependencies.controlPlane, token: details.token }),
      };
      const stop = await startRunner(await createRuntime(config, ports));
      this.problem = null;
      return stop;
    } catch (error) {
      const problem = describeError(error);
      if (problem !== this.problem) log(LOCAL_HOST.failed(problem));
      this.problem = problem;
      return null;
    }
  }

  private stopRunner(): Promise<unknown> {
    const runner = this.runner;
    this.runner = null;
    const stopping = runner?.then((stop) =>
      stop?.().catch((error: unknown) => log(LOCAL_HOST.failed(describeError(error)))),
    );
    this.stopped = Promise.all([this.stopped, stopping]);
    return this.stopped;
  }
}
