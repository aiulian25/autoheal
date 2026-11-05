import type { ShutdownJournal } from "./shutdown-journal.js";
import { join } from "node:path";
import { helperReportSchema, type HelperReport } from "../host-helper/helper-report.js";
import {
  COMMAND_HOST_HELPER,
  CONTAINER_RETURN_GRACE_MILLISECONDS,
  CONTAINER_STATE_RUNNING,
  ERROR_TEXT_LIMIT,
  HOST_HELPER,
  HOST_HELPER_MESSAGES,
  HOST_HELPER_OUTCOME,
  HOST_PACKAGE_FOLLOW,
  HOST_PACKAGE_JOB_VERBS,
  HOST_PACKAGE_LOG_DIRECTORY,
  HOST_PACKAGE_LOG_FILE,
  HOST_PACKAGE_LOG_READ_BYTES,
  HOST_PACKAGE_MANAGER,
  HOST_PACKAGE_OUTCOMES,
  JOB_OUTCOMES,
  HOST_PACKAGE_RUN_PATTERN,
  HOST_PACKAGE_STATUS_FILE,
  HOST_PACKAGE_STOPPED,
  HOST_PACKAGE_SUCCESS,
  HOST_PACKAGE_TIMEOUT_MICROSECONDS,
  HOST_PACKAGE_VERB,
  PACKAGES_UNSUPPORTED,
  isPowerVerb,
  HOST_PACKAGES,
  JOB_OUTPUT_CHARACTERS,
  MICROSECONDS_PER_MILLISECOND,
  OUTCOME_TEXT_LIMIT,
  REBOOT_REFUSED_EXIT,
  type HostPackageManager,
  type HostPackagesSetting,
  type HostPackageVerb,
} from "../shared/constants.js";
import { describeError } from "../shared/errors.js";
import type { HostJob, JobResult } from "../shared/protocol.js";
import { redactSecrets } from "../shared/redaction.js";
import type { DockerClient } from "./docker-client.js";
import { LOCAL_HOST_FILES, type HostFiles } from "./host-files.js";
import { parseCheck, problemIn } from "./package-check.js";
import { packageSupport } from "./package-facts.js";
import type { RemedyGuard } from "./remedy-guard.js";

/** Starts one job's transient unit on the host, and says whether systemd took it. */
export type PackageUnitStarter = (
  manager: HostPackageManager,
  verb: HostPackageVerb,
  jobId: string,
  packages: readonly string[],
) => Promise<HelperReport>;

export interface HostPackageJobsDependencies {
  applicationRecoveryPending?: () => boolean;
  journal?: Pick<ShutdownJournal, "run" | "delegate">;
  // Absent on a host without Docker: there are no containers to watch come back after an upgrade.
  docker?: Pick<DockerClient, "inspect" | "create" | "start" | "remove" | "logs" | "containerSummaries">;
  // How the unit is started: by this runner's helper container unless given (over SSH, as root).
  startUnit?: PackageUnitStarter;
  // How the host's files are read; its mount here unless given.
  files?: HostFiles;
  guard: Pick<RemedyGuard, "holdHost" | "releaseHost" | "heldContainers" | "operations" | "recoveries">;
  settings: {
    hostPackages: HostPackagesSetting;
    dryRun: boolean;
    hostRoot: string;
    selfContainerName: string;
    hostDbusDirectory: string;
  };
  // The newest part of a run's log while it runs, for the dashboard; one that does not arrive is no loss.
  progress?: (jobId: string, output: string) => Promise<unknown>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

/** A run this runner follows: started for a job, or found on the host after the runner restarted. */
export interface FollowedRun {
  jobId: string;
  result: Promise<JobResult>;
}

type Permission = { manager: HostPackageManager } | { refusal: string };

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const failure = (outcome: string): JobResult => ({ succeeded: false, outcome, output: null });
const APPLICATION_RECOVERY_PENDING =
  "Refused: application backup recovery is incomplete. Resume or resolve that recovery before changing host packages or rebooting.";
const limitOf = (verb: HostPackageVerb) =>
  Number(HOST_PACKAGE_TIMEOUT_MICROSECONDS[verb] / MICROSECONDS_PER_MILLISECOND);
const LONGEST_RUN_MILLISECONDS = Math.max(
  ...Object.keys(HOST_PACKAGE_TIMEOUT_MICROSECONDS).map((verb) => limitOf(verb as HostPackageVerb)),
);
const FINISHED = {
  repair: HOST_PACKAGE_OUTCOMES.repaired,
  autoremove: HOST_PACKAGE_OUTCOMES.autoremoved,
  reboot: HOST_PACKAGE_OUTCOMES.rebooting,
  shutdown: HOST_PACKAGE_OUTCOMES.shuttingDown,
} as const;
// The status file's "$SERVICE_RESULT $EXIT_CODE $EXIT_STATUS": the exit status is the third.
const exitStatusOf = (status: string) => Number(status.trim().split(" ")[2]);

// The helper prints one JSON line; anything else (a usage error, a crash) is its failure.
function reportIn(printed: string): HelperReport {
  const lines = printed.trim().split("\n");
  try {
    const parsed = helperReportSchema.safeParse(JSON.parse(lines.at(-1) ?? ""));
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // Not JSON: reported below with what it printed.
  }
  return { outcome: HOST_HELPER_OUTCOME.failed, reason: printed.trim().slice(0, ERROR_TEXT_LIMIT) };
}

/**
 * Package jobs on the host itself. The host's .env decides what may run at all, dry-run still holds,
 * and the job runs as a transient systemd unit, so it outlives this runner and even Docker restarting.
 * The runner follows it through the files the unit leaves on the host.
 */
export class HostPackageJobs {
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly files: HostFiles;
  private readonly startUnit: PackageUnitStarter;

  constructor(private readonly dependencies: HostPackageJobsDependencies) {
    this.sleep = dependencies.sleep ?? wait;
    this.now = dependencies.now ?? Date.now;
    this.files = dependencies.files ?? LOCAL_HOST_FILES;
    this.startUnit = dependencies.startUnit ?? ((...unit) => this.startHelper(...unit));
  }

  /** Runs the job to its end, which for an upgrade can take many minutes: callers don't wait on it. */
  run(job: HostJob): Promise<JobResult> {
    return (
      this.dependencies.journal?.run(`host:${job.id}`, job.containerName, () => this.runJob(job), {
        reboot: isPowerVerb(HOST_PACKAGE_JOB_VERBS[job.action]),
      }) ?? this.runJob(job)
    );
  }

  private async runJob(job: HostJob): Promise<JobResult> {
    const { guard, progress } = this.dependencies;
    const changing = HOST_PACKAGE_JOB_VERBS[job.action] !== HOST_PACKAGE_VERB.check;
    let queued = false;
    const result = await guard.operations
      .host(
        async () => {
          if (queued) {
            void progress?.(job.id, "Starting the host job.").catch(() => undefined);
          }
          if (changing) {
            guard.holdHost();
          }
          try {
            return await this.carryOut(job);
          } finally {
            if (changing) {
              guard.releaseHost();
            }
          }
        },
        () => {
          queued = true;
          void progress?.(job.id, "Waiting for other work on this host before starting the host job.").catch(
            () => undefined,
          );
        },
      )
      .catch((error: unknown) => failure(HOST_PACKAGE_OUTCOMES.failed(describeError(error))));
    return { ...result, outcome: result.outcome.slice(0, OUTCOME_TEXT_LIMIT) };
  }

  /**
   * After a restart: the runs of the last two hours, still going or just ended, followed to their result.
   * One already reported is reported again, and the control plane turns it away.
   */
  async followable(): Promise<FollowedRun[]> {
    const { hostRoot } = this.dependencies.settings;
    const { manager } = await packageSupport((file) => join(hostRoot, file), this.files);
    const directory = join(hostRoot, HOST_PACKAGE_LOG_DIRECTORY);
    const logs = manager === null ? [] : await this.files.list(directory);
    const runs: FollowedRun[] = [];
    for (const match of logs.map((file) => HOST_PACKAGE_RUN_PATTERN.exec(file))) {
      const [file = "", jobId = "", verb = ""] = match ?? [];
      const modifiedAt = (await this.files.modifiedAt(join(directory, file))) ?? 0;
      const recent = this.now() - modifiedAt < LONGEST_RUN_MILLISECONDS + HOST_PACKAGE_FOLLOW.marginMilliseconds;
      if (match !== null && manager !== null && recent) {
        runs.push({ jobId, result: this.follow(jobId, verb as HostPackageVerb, manager, [], true) });
      }
    }
    return runs;
  }

  private async carryOut(job: HostJob): Promise<JobResult> {
    if (HOST_PACKAGE_JOB_VERBS[job.action] !== HOST_PACKAGE_VERB.check) {
      if (this.dependencies.applicationRecoveryPending?.()) return failure(APPLICATION_RECOVERY_PENDING);
      const recovery = (await this.dependencies.guard.recoveries())[0];
      if (recovery !== undefined) return failure(JOB_OUTCOMES.rollbackPending(recovery.owner));
    }

    const verb = HOST_PACKAGE_JOB_VERBS[job.action];
    const permission = await this.permission(verb);
    if ("refusal" in permission) {
      return failure(permission.refusal);
    }
    if (this.dependencies.settings.dryRun && verb !== HOST_PACKAGE_VERB.check) {
      return failure(this.dryRunOutcome(verb, job.packages));
    }
    if (verb !== HOST_PACKAGE_VERB.check && this.dependencies.applicationRecoveryPending?.())
      return failure(APPLICATION_RECOVERY_PENDING);
    const report = await this.startUnit(permission.manager, verb, job.id, job.packages);
    if (report.outcome === HOST_HELPER_OUTCOME.busy) {
      return failure(HOST_PACKAGE_OUTCOMES.busy);
    }
    if (report.outcome === HOST_HELPER_OUTCOME.failed) {
      return failure(HOST_PACKAGE_OUTCOMES.helperFailed(report.reason ?? ""));
    }
    await this.dependencies.journal?.delegate(job.id);
    return this.follow(job.id, verb, permission.manager, job.packages, false);
  }

  // Only the host's own .env lets a package job through (any setting but off: the control plane keeps the jobs
  // Autoheal and Ollama start themselves to apply), only on a host whose systemd can be asked, and a reboot or a
  // shutdown, which any admin may ask for, never while a person's container action is still going on.
  private async permission(verb: HostPackageVerb): Promise<Permission> {
    const { hostPackages, hostRoot } = this.dependencies.settings;
    const powering = isPowerVerb(verb);
    const checking = verb === HOST_PACKAGE_VERB.check;
    const allowed = powering || hostPackages !== HOST_PACKAGES.off;
    if (!allowed) {
      return {
        refusal: checking ? HOST_PACKAGE_OUTCOMES.checkNotAllowed : HOST_PACKAGE_OUTCOMES.notAllowed(hostPackages),
      };
    }
    const support = await packageSupport((file) => join(hostRoot, file), this.files);
    // Powering needs systemd alone: every package manager's table runs the same script for it.
    if (powering && support.unsupported === PACKAGES_UNSUPPORTED.noPackageManager) {
      return { manager: HOST_PACKAGE_MANAGER.apt };
    }
    if (support.unsupported !== null) {
      return { refusal: HOST_PACKAGE_OUTCOMES.unsupported[support.unsupported] };
    }
    if (verb === HOST_PACKAGE_VERB.repair && support.manager === HOST_PACKAGE_MANAGER.dnf) {
      return { refusal: HOST_PACKAGE_OUTCOMES.noRepairWithDnf };
    }
    const changing = this.dependencies.guard.heldContainers();
    if (isPowerVerb(verb) && changing.length > 0) {
      return { refusal: HOST_PACKAGE_OUTCOMES.containersChanging(changing) };
    }
    return { manager: support.manager };
  }

  private dryRunOutcome(verb: Exclude<HostPackageVerb, typeof HOST_PACKAGE_VERB.check>, packages: readonly string[]) {
    const { dryRun } = HOST_PACKAGE_OUTCOMES;
    return verb === HOST_PACKAGE_VERB.upgrade ? dryRun.upgrade(packages) : dryRun[verb];
  }

  /** The helper: this runner's own image, as root, with nothing but the host's D-Bus socket. */
  private async startHelper(
    manager: HostPackageManager,
    verb: HostPackageVerb,
    jobId: string,
    packages: readonly string[],
  ): Promise<HelperReport> {
    const { docker, settings } = this.dependencies;
    if (docker === undefined) {
      throw new Error(HOST_HELPER_MESSAGES.noDocker);
    }
    const self = await docker.inspect(settings.selfContainerName);
    if (self?.Image === undefined) {
      throw new Error(`the runner cannot find its own container, ${settings.selfContainerName}`);
    }
    const name = `${HOST_HELPER.containerPrefix}${jobId}`;
    await docker.create(name, {
      Image: self.Image,
      Cmd: [COMMAND_HOST_HELPER, manager, verb, jobId, ...packages],
      User: HOST_HELPER.user,
      Labels: { [HOST_HELPER.label]: HOST_HELPER.labelValue },
      NetworkDisabled: true,
      Healthcheck: { Test: [HOST_HELPER.noHealthcheck] },
      HostConfig: {
        Binds: [`${settings.hostDbusDirectory}:${HOST_HELPER.dbusTarget}`],
        ReadonlyRootfs: true,
        CapDrop: [HOST_HELPER.allCapabilities],
        SecurityOpt: [HOST_HELPER.noNewPrivileges, HOST_HELPER.noSelinuxLabel, HOST_HELPER.noAppArmorProfile],
        NetworkMode: HOST_HELPER.network,
        Memory: HOST_HELPER.memoryBytes,
        PidsLimit: HOST_HELPER.pidsLimit,
      },
    });
    try {
      await docker.start(name);
      await this.untilExited(name);
      return reportIn(await docker.logs(name, false));
    } finally {
      await docker.remove(name).catch(() => undefined);
    }
  }

  private async untilExited(name: string) {
    const deadline = this.now() + HOST_HELPER.exitDeadlineMilliseconds;
    while (this.now() < deadline) {
      const helper = await this.dependencies.docker?.inspect(name);
      if (helper === null || helper === undefined || !helper.State.Running) {
        return;
      }
      await this.sleep(HOST_HELPER.exitPollMilliseconds);
    }
    throw new Error(HOST_HELPER_MESSAGES.didNotFinish);
  }

  private async runningContainers(): Promise<Set<string>> {
    const containers = (await this.dependencies.docker?.containerSummaries()) ?? [];
    const running = containers.filter(({ State }) => State === CONTAINER_STATE_RUNNING);
    return new Set(running.flatMap(({ Names }) => Names.map((name) => name.replace(/^\//, ""))));
  }

  // What ran before and isn't running now, after Docker's restart policies had their chance.
  private async notBack(before: ReadonlySet<string>): Promise<string[]> {
    const missing = async () => {
      const running = await this.runningContainers();
      return [...before].filter((name) => !running.has(name));
    };
    if ((await missing()).length === 0) {
      return [];
    }
    await this.sleep(CONTAINER_RETURN_GRACE_MILLISECONDS);
    return missing();
  }

  /** The newest part of the log, sent on whenever it grew; returns what was last sent. */
  private async sendProgress(jobId: string, logPath: string, sent: string): Promise<string> {
    const { progress } = this.dependencies;
    const output = redactSecrets((await this.files.readEnd(logPath, HOST_PACKAGE_FOLLOW.progressBytes)) ?? "", []);
    if (progress === undefined || output === sent) {
      return sent;
    }
    await progress(jobId, output).catch(() => undefined);
    return output;
  }

  private async untilStatus(jobId: string, verb: HostPackageVerb, deadline: number): Promise<string | null> {
    const host = (file: string) => join(this.dependencies.settings.hostRoot, file);
    const statusPath = host(HOST_PACKAGE_STATUS_FILE(jobId, verb));
    let sent = "";
    while (this.now() < deadline) {
      if (await this.files.exists(statusPath)) {
        return (await this.files.readEnd(statusPath, ERROR_TEXT_LIMIT)) ?? "";
      }
      sent = await this.sendProgress(jobId, host(HOST_PACKAGE_LOG_FILE(jobId, verb)), sent);
      await this.sleep(HOST_PACKAGE_FOLLOW.pollMilliseconds);
    }
    return null;
  }

  /** Waits for the run's status file, healing standing aside on this host while packages change. */
  private async follow(
    jobId: string,
    verb: HostPackageVerb,
    manager: HostPackageManager,
    packages: readonly string[],
    resumed: boolean,
  ): Promise<JobResult> {
    const work = () => this.followRun(jobId, verb, manager, packages, resumed);
    return resumed ? this.dependencies.guard.operations.host(work) : work();
  }

  private async followRun(
    jobId: string,
    verb: HostPackageVerb,
    manager: HostPackageManager,
    packages: readonly string[],
    resumed: boolean,
  ): Promise<JobResult> {
    const { guard, settings } = this.dependencies;
    const started = this.now();
    const changing = verb !== HOST_PACKAGE_VERB.check;
    // A reboot takes every container down with the host: none of them is missing afterwards.
    const watching = changing && !isPowerVerb(verb);
    const before = watching ? await this.runningContainers() : new Set<string>();
    if (changing) {
      guard.holdHost();
    }
    const deadline = started + limitOf(verb) + HOST_PACKAGE_FOLLOW.marginMilliseconds;
    // A host that can no longer be read once its reboot or shutdown started has gone down, as asked: over SSH the
    // session goes with it.
    const powering = isPowerVerb(verb);
    const wentAway =
      <Value>(fallback: Value) =>
      (error: unknown) => {
        if (powering) return fallback;
        throw error;
      };
    const status = await this.untilStatus(jobId, verb, deadline)
      .catch(wentAway(HOST_PACKAGE_STOPPED))
      .finally(() => {
        if (changing) {
          guard.releaseHost();
        }
      });
    const log =
      (await this.files
        .readEnd(join(settings.hostRoot, HOST_PACKAGE_LOG_FILE(jobId, verb)), HOST_PACKAGE_LOG_READ_BYTES)
        .catch(wentAway(null))) ?? "";
    const output = redactSecrets(log, []).slice(-JOB_OUTPUT_CHARACTERS) || null;
    const missing = watching ? await this.notBack(before) : [];
    const suffix =
      (missing.length > 0 ? HOST_PACKAGE_OUTCOMES.notBack(missing) : "") +
      (resumed ? HOST_PACKAGE_OUTCOMES.resumed : "");
    if (status === null) {
      return { succeeded: false, outcome: HOST_PACKAGE_OUTCOMES.noResult(this.now() - started) + suffix, output };
    }
    // The reboot's own refusal (a Proxmox backup running) says why in its last line. Once it asked for
    // the reboot, the shutdown may stop the unit before it ends by itself.
    if (powering && exitStatusOf(status) === REBOOT_REFUSED_EXIT) {
      return { succeeded: false, outcome: problemIn(log) + suffix, output };
    }
    const wentDown = powering && status.startsWith(HOST_PACKAGE_STOPPED);
    if (!status.startsWith(HOST_PACKAGE_SUCCESS) && !wentDown) {
      return { succeeded: false, outcome: HOST_PACKAGE_OUTCOMES.failed(problemIn(log)) + suffix, output };
    }
    const done = this.success(verb, manager, packages, log, resumed);
    // A check that went well is all in its result; the package manager's own words are kept for the rest.
    return { ...done, outcome: done.outcome + suffix, output: verb === HOST_PACKAGE_VERB.check ? null : output };
  }

  private success(
    verb: HostPackageVerb,
    manager: HostPackageManager,
    packages: readonly string[],
    log: string,
    resumed: boolean,
  ): Omit<JobResult, "output"> {
    if (verb === HOST_PACKAGE_VERB.check) {
      const check = parseCheck(manager, log);
      const notes = [
        check.refreshProblem === null ? "" : HOST_PACKAGE_OUTCOMES.notRefreshed(check.refreshProblem),
        check.needsRepair ? HOST_PACKAGE_OUTCOMES.needsRepair : "",
      ];
      const counts = [check.upgradable.length, check.keptBack.length, check.removable.length] as const;
      return { succeeded: true, outcome: HOST_PACKAGE_OUTCOMES.checked(...counts) + notes.join(""), packages: check };
    }
    if (verb === HOST_PACKAGE_VERB.upgrade) {
      // After a restart the runner no longer knows which packages the job named.
      const outcome = resumed ? HOST_PACKAGE_OUTCOMES.upgradeFinished : HOST_PACKAGE_OUTCOMES.upgraded(packages);
      return { succeeded: true, outcome };
    }
    return { succeeded: true, outcome: FINISHED[verb] };
  }
}
