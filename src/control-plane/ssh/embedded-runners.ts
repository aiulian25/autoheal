import type { ControlPlaneSettings } from "../../config/runner-config.js";
import { createRuntime, startRunner, type RunnerPorts } from "../../runner/application.js";
import { DockerClient } from "../../runner/docker-client.js";
import { ShutdownJournal } from "../../runner/shutdown-journal.js";
import {
  AUDIT_ACTIONS,
  RUNNER_MESSAGES,
  SSH_HOST_FILES,
  SSH_READINESS,
  SSH_STATE,
  SSH_TEXT,
  TARGET_HOST,
  type RootMethod,
} from "../../shared/constants.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import { API_ERRORS } from "../../shared/api.js";
import { DomainError } from "../domain-error.js";
import { findRootMethod } from "./ssh-root.js";
import { startSystemOnlyRunner } from "../../runner/system-only-runner.js";
import { describeError } from "../../shared/errors.js";
import { log } from "../../shared/log.js";
import { readinessOf, type SshHostsService } from "./ssh-hosts-service.js";
import { SshDockerConnection } from "./ssh-docker-connection.js";
import { SshHostFiles, sshHostCommand, shellQuoted } from "./ssh-host-files.js";
import { sshPackageUnits } from "./ssh-package-units.js";
import { sshRunnerConfig } from "./ssh-runner-config.js";
import type { SshConnectionView } from "../../shared/api.js";
import { SshSession } from "./ssh-session.js";
import { runnerContainerRunning } from "../hosts/runner-container.js";

type StopRunner = () => Promise<void>;

/**
 * Whether the host's user may use its Docker now: the check a host is added with. A check that got no answer (turned
 * away, too slow, or cut short) says nothing about Docker either way, so it throws: taken for a no, the host would be
 * watched for its system alone and its containers dropped.
 */
async function dockerUsable(session: SshSession): Promise<boolean> {
  const result = await session
    .exec(SSH_READINESS.command, SSH_HOST_FILES.commandTimeoutMilliseconds)
    .catch((error: unknown) => {
      throw new Error(SSH_TEXT.dockerCheckFailed(describeError(error)));
    });
  if (readinessOf(result.stdout).usable) return true;
  // No exit code: its channel closed under it, as when the connection drops.
  if (result.exitCode === null) throw new Error(SSH_TEXT.dockerCheckFailed(SSH_TEXT.dockerCheckCutShort));
  return false;
}

interface EmbeddedRunner {
  // Settles once the runner and session this one replaced have stopped: no two run against one host at once.
  replaced: Promise<void>;
  // Null until then.
  session: SshSession | null;
  // Starting or running; null while the session is not connected, or after a start that failed.
  runner: Promise<StopRunner | null> | null;
  // What went wrong last, logged once rather than at every try.
  problem: string | null;
  // Whether its runner looks after Docker too, or the system alone; null until one has started.
  withDocker: boolean | null;
}

export interface EmbeddedRunnersDependencies {
  hosts: Pick<SshHostsService, "activeHostIds" | "targetOf" | "runnerOf">;
  // The runner API on this machine, and its certificate's key.
  controlPlane: Omit<ControlPlaneSettings, "token">;
  // The exact release the control plane runs: an SSH host's helpers run in it, pulled there when first needed.
  autohealImage: string;
  // Who cleared what held a host's runner back.
  audit: Pick<AuditLog, "recordUserAction">;
}

/**
 * The runner engine for each active SSH host, inside the control plane: Docker through the host's one SSH session,
 * reports through the runner API on loopback with the host's own token, as a runner container's would arrive. Its
 * guard state and journals live in labelled volumes on the host itself, as a runner's do, so they outlast a restart
 * of either side.
 */
export class EmbeddedRunners {
  private readonly runners = new Map<string, EmbeddedRunner>();
  private running = false;
  private paused = false;
  // Settles once the runners a restore closed have stopped.
  private closedForRestore: Promise<unknown> = Promise.resolve();

  constructor(private readonly dependencies: EmbeddedRunnersDependencies) {}

  begin() {
    this.running = true;
    this.tick();
  }

  /**
   * Each active SSH host has its runner and no revoked one does; a runner that could not start is tried again, and
   * a host watched for its system alone gets the full runner once Docker is there.
   */
  tick() {
    if (!this.running || this.paused) return;
    const active = new Set(this.dependencies.hosts.activeHostIds());
    [...this.runners.keys()].filter((hostId) => !active.has(hostId)).forEach((hostId) => void this.close(hostId));
    active.forEach((hostId) => {
      const embedded = this.runners.get(hostId);
      if (embedded === undefined) void this.open(hostId);
      else this.ensureRunning(hostId, embedded);
    });
    [...this.runners.entries()]
      .filter(([, embedded]) => embedded.withDocker === false)
      .forEach(([hostId, embedded]) => void this.openOnceDockerIsThere(hostId, embedded));
  }

  /** A new session and runner for the host, once its old ones stopped: it was added, or its key or settings changed. */
  async open(hostId: string) {
    if (!this.running || this.paused) return;
    const embedded: EmbeddedRunner = {
      replaced: Promise.all([this.closedForRestore, this.close(hostId)]).then(() => undefined),
      session: null,
      runner: null,
      problem: null,
      withDocker: null,
    };
    this.runners.set(hostId, embedded);
    await embedded.replaced;
    if (this.runners.get(hostId) !== embedded) return;
    const session = new SshSession(() => this.dependencies.hosts.targetOf(hostId));
    embedded.session = session;
    session.onChange((view) => {
      if (view.state === SSH_STATE.connected) this.ensureRunning(hostId, embedded);
    });
    session.start();
  }

  /** Stops the host's runner, then its session: the runner's last writes still go through it. */
  close(hostId: string): Promise<void> {
    const embedded = this.runners.get(hostId);
    if (embedded === undefined) return Promise.resolve();
    this.runners.delete(hostId);
    return embedded.replaced.then(async () => {
      const stop = await embedded.runner;
      await stop?.().catch((error: unknown) => log(SSH_TEXT.runnerFailed(hostId, describeError(error))));
      embedded.session?.close();
    });
  }

  /**
   * A restore is about to replace what every runner was built from: none starts until it is over. The restore does
   * not wait for them, work already running on a host being free to take longer than it would wait; what they report
   * meanwhile is refused and stays in their journals on the host.
   */
  pause() {
    this.paused = true;
    const closing = [...this.runners.keys()].map((hostId) => this.close(hostId));
    this.closedForRestore = Promise.all([this.closedForRestore, ...closing]);
  }

  /**
   * Every runner anew from the database as it now is, each once the old ones have stopped. A restore that fails after
   * this comes back here for the file it puts back: a runner reads its settings only once its session is up, by then.
   */
  resume() {
    this.paused = false;
    this.tick();
  }

  /** Before the runner API and the database close, as a runner container stops before its control plane would. */
  async stop() {
    this.running = false;
    await Promise.all([...this.runners.keys()].map((hostId) => this.close(hostId)));
    await this.closedForRestore;
  }

  /** The host's session for the hosts API: its state, and why its runner has not started; never the offered key. */
  connectionOf(hostId: string): SshConnectionView | null {
    const embedded = this.runners.get(hostId);
    const view = embedded?.session?.state();
    return view === undefined
      ? null
      : { state: view.state, since: view.since, reason: view.reason ?? embedded?.problem ?? null };
  }

  /** How the password makes root on the host, over its live session; null when it makes neither sudo nor su work. */
  async rootMethodOf(hostId: string, password: string): Promise<RootMethod | null> {
    const session = this.runners.get(hostId)?.session;
    if (session?.state().state !== SSH_STATE.connected) {
      throw new DomainError(API_ERRORS.sshHostNotConnected);
    }
    return findRootMethod((method, command) => session.asRoot(method, password, command));
  }

  /** Its session dialled again at the shortest pause until then: it is being rebooted or shut down. */
  redialSoon(hostId: string, until: number) {
    this.runners.get(hostId)?.session?.redialSoon(until);
  }

  /** What holds the host's runner back, in the words its log uses; nothing while it may start by itself. */
  async interruptedOf(hostId: string): Promise<string[]> {
    const records = await this.journalOf(hostId).blocking();
    return records.map((record) => RUNNER_MESSAGES.recoverySaid(record));
  }

  /**
   * A person looked at what was interrupted on the host: its records go, nothing is undone or run again, and the
   * runner starts. Never under a runner that runs or is starting, whose own journal this is.
   */
  async clearInterrupted(actor: Actor, hostId: string): Promise<string[]> {
    const journal = this.journalOf(hostId);
    if (this.runners.get(hostId)?.runner !== null) throw new DomainError(API_ERRORS.sshHostRunnerRunning);
    const cleared = (await journal.clearBlocking()).map((record) => RUNNER_MESSAGES.recoverySaid(record));
    this.dependencies.audit.recordUserAction(
      actor,
      AUDIT_ACTIONS.hostSshInterruptedCleared,
      { kind: TARGET_HOST, id: hostId },
      { operations: cleared },
    );
    this.tick();
    return cleared;
  }

  /** The host key the host offers when it is not the trusted one, for a person to compare. */
  offeredHostKeyOf(hostId: string): string | null {
    return this.runners.get(hostId)?.session?.state().offeredHostKey?.fingerprint ?? null;
  }

  // The host's journal, read over its live session as its runner reads it.
  private journalOf(hostId: string) {
    const session = this.runners.get(hostId)?.session;
    if (session?.state().state !== SSH_STATE.connected) throw new DomainError(API_ERRORS.sshHostNotConnected);
    return new ShutdownJournal(new DockerClient(new SshDockerConnection(session)));
  }

  private async openOnceDockerIsThere(hostId: string, embedded: EmbeddedRunner) {
    if (embedded.session === null) return;
    // Only on a clear yes: a look that got no answer leaves the host as it is until the next one.
    const usable = await dockerUsable(embedded.session).catch(() => false);
    if (usable && this.runners.get(hostId) === embedded) await this.open(hostId);
  }

  private ensureRunning(hostId: string, embedded: EmbeddedRunner) {
    const session = embedded.session;
    const connected = session?.state().state === SSH_STATE.connected;
    if (session === null || !connected || embedded.runner !== null || this.runners.get(hostId) !== embedded) return;
    // Closed when the start fails: else each try would keep a channel open, until the host's sshd refuses another and
    // nothing of the host can be read, nor its Docker asked for.
    const hostFiles = new SshHostFiles(session);
    embedded.runner = Promise.resolve()
      .then(async () => {
        const details = this.dependencies.hosts.runnerOf(hostId);
        const config = sshRunnerConfig(details, this.dependencies.controlPlane);
        const { root } = details;
        const ports: RunnerPorts = {
          docker: new SshDockerConnection(session),
          hostFiles,
          hostCommand: sshHostCommand(session),
          localHost: null,
          // Package jobs run as root with the password a person saved; without one they are refused, saying so.
          packageUnits:
            root === null ? null : sshPackageUnits((command) => session.asRoot(root.method, root.password, command)),
          helperImageReference: this.dependencies.autohealImage,
          hostShell: (columns, rows) => session.shell(columns, rows),
          hostScript: async (script, timeout) => {
            const { exitCode, stdout, stderr } = await session.exec(
              `sh -c ${shellQuoted(script)}`,
              timeout,
              SSH_TEXT.scriptOperation,
            );
            return { exitCode, output: `${stdout}${stderr}` };
          },
          reconnect: () => ({ ...this.dependencies.controlPlane, token: details.token }),
        };
        embedded.withDocker = await dockerUsable(session);
        if (embedded.withDocker && (await runnerContainerRunning(new SshDockerConnection(session)))) {
          throw new Error(SSH_TEXT.runnerStillThere);
        }
        return embedded.withDocker
          ? startRunner(await createRuntime(config, ports))
          : startSystemOnlyRunner(config, ports);
      })
      .then(
        (stop) => {
          embedded.problem = null;
          return stop;
        },
        (error: unknown) => {
          hostFiles.close();
          const problem = describeError(error);
          if (problem !== embedded.problem) log(SSH_TEXT.runnerFailed(hostId, problem));
          embedded.problem = problem;
          embedded.runner = null;
          return null;
        },
      );
  }
}
