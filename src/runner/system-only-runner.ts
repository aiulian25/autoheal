import { RUNNING_VERSION } from "../shared/build-version.js";
import type { RunnerConfig } from "../config/runner-config.js";
import {
  CONTAINER_ACCESS_REFUSALS,
  HEARTBEAT_INTERVAL_MILLISECONDS,
  JOB_OUTCOMES,
  METRICS_INTERVAL_MILLISECONDS,
  NVIDIA_SMI,
  RUNNER_MESSAGES,
  WORK_POLL_INTERVAL_MILLISECONDS,
} from "../shared/constants.js";
import { describeError } from "../shared/errors.js";
import { log } from "../shared/log.js";
import { isHostJob, type Heartbeat, type JobResult } from "../shared/protocol.js";
import { hostPackageJobsOf, type RunnerPorts } from "./application.js";
import { ControlPlaneClient, refusedForGood } from "./control-plane-client.js";
import { RemedyGuard } from "./remedy-guard.js";
import { allGpus, NvidiaGpus } from "./gpu-metrics.js";
import { SysfsGpus } from "./sysfs-gpus.js";
import { readHostHealth } from "./host-health.js";
import { HostMetricsSampler } from "./host-metrics.js";
import { followContainerAccess } from "./container-access.js";
import { TerminalSessions } from "./terminal-sessions.js";

const NO_CONTAINERS = { error: CONTAINER_ACCESS_REFUSALS.noDocker };

/**
 * A host without Docker: its health every 30 s and its usage every 5 s, read over its session, and its operating
 * system's package jobs, as root with its saved password. With no containers there is nothing to heal or update; a
 * host that gets Docker later is given the full runner instead. Starts at once; the function it gives stops it.
 */
export function startSystemOnlyRunner(
  config: RunnerConfig,
  ports: Pick<RunnerPorts, "hostFiles" | "hostCommand" | "packageUnits" | "hostShell" | "reconnect">,
): () => Promise<void> {
  const controlPlane = new ControlPlaneClient(config.controlPlane!, ports.reconnect ?? null);
  const gpus = new NvidiaGpus(NVIDIA_SMI.command, ports.hostCommand);
  const kernelGpus = new SysfsGpus(config.hostRoot, ports.hostFiles);
  const metrics = new HostMetricsSampler({
    hostRoot: config.hostRoot,
    readGpus: () => allGpus(gpus, kernelGpus),
    files: ports.hostFiles,
  });
  const running = new Set<Promise<void>>();
  let problem: string | null = null;
  const noted = (error: unknown) => {
    const now = describeError(error);
    if (now !== problem) log(RUNNER_MESSAGES.systemOnlyFailed(config.hostLabel, now));
    problem = now;
  };
  const tracked = (work: () => Promise<unknown>) => {
    const done: Promise<void> = work().then(() => undefined, noted);
    running.add(done);
    void done.finally(() => running.delete(done));
  };
  const heartbeat = async () => {
    const [host, clockOffset] = await Promise.all([
      readHostHealth({
        hostRoot: config.hostRoot,
        filesystems: config.hostFilesystems,
        packages: config.hostPackages,
        files: ports.hostFiles,
      }).catch((error: unknown) => {
        noted(error);
        return null;
      }),
      ports.hostFiles.clockOffset(),
    ]);
    const payload: Heartbeat = {
      runnerVersion: RUNNING_VERSION,
      hostLabel: config.hostLabel,
      dryRun: config.dryRun,
      eventStreamConnected: false,
      protectedContainers: [...config.protectedContainers].sort(),
      restartBudget: {},
      host,
      containers: [],
      containerAccess: false,
      docker: false,
      hostTerminal: config.hostTerminal,
      ...(clockOffset === null ? {} : { hostClock: Date.now() + clockOffset }),
    };
    await controlPlane.heartbeat(payload);
  };
  const report = async () => {
    const host = await metrics.sample();
    if (host !== null) await controlPlane.reportMetrics({ host, containers: [] });
  };
  const hostJobs = hostPackageJobsOf(
    { localHost: null, packageUnits: ports.packageUnits, hostFiles: ports.hostFiles },
    {
      guard: new RemedyGuard(config.protectedContainers),
      settings: config,
      progress: (jobId, output) => controlPlane.reportJobProgress(jobId, { output }),
    },
  );
  // Results not yet taken by the control plane, sent again at each poll; one it refuses for good is dropped.
  const unreported = new Map<string, JobResult>();
  const reportResults = async () => {
    for (const [jobId, result] of unreported) {
      await controlPlane.reportJobResult(jobId, result).then(
        () => unreported.delete(jobId),
        (error: unknown) => {
          if (refusedForGood(error)) {
            unreported.delete(jobId);
          }
          noted(error);
        },
      );
    }
  };
  const follow = (jobId: string, result: Promise<JobResult>) =>
    tracked(async () => {
      unreported.set(jobId, await result);
      await reportResults();
    });
  let polling = false;
  const takeWork = async () => {
    if (polling) return;
    polling = true;
    try {
      await reportResults();
      const { jobs } = await controlPlane.takeWork();
      for (const job of jobs) {
        if (isHostJob(job)) {
          follow(job.id, hostJobs.run(job));
        } else {
          unreported.set(job.id, { succeeded: false, outcome: JOB_OUTCOMES.noDockerHere, output: null });
        }
      }
    } finally {
      polling = false;
    }
  };
  log(RUNNER_MESSAGES.systemOnly(config.hostLabel));
  tracked(heartbeat);
  tracked(report);
  // Runs still going on the host after a restart are followed to their end.
  tracked(async () => {
    for (const run of await hostJobs.followable()) follow(run.jobId, run.result);
  });
  // A shell on the host is the one thing reached here as on a runner with Docker: nothing is inside containers.
  const terminals = new TerminalSessions({ docker: null, hostShell: ports.hostShell, controlPlane, settings: config });
  const stopping = new AbortController();
  const accessing = followContainerAccess(
    {
      controlPlane,
      terminals,
      files: { answer: async () => ({ ...NO_CONTAINERS, entries: null, content: null, truncated: false }) },
      settings: { answer: async () => ({ ...NO_CONTAINERS, settings: null }) },
      profile: async () => ({ ...NO_CONTAINERS, profile: null }),
      installs: { answer: async () => ({ ...NO_CONTAINERS, draft: null, checks: [] }) },
    },
    stopping.signal,
  );
  const heartbeats = setInterval(() => tracked(heartbeat), HEARTBEAT_INTERVAL_MILLISECONDS);
  const reports = setInterval(() => tracked(report), METRICS_INTERVAL_MILLISECONDS);
  const work = setInterval(() => tracked(takeWork), WORK_POLL_INTERVAL_MILLISECONDS);
  return async () => {
    clearInterval(heartbeats);
    clearInterval(reports);
    clearInterval(work);
    terminals.stop();
    stopping.abort();
    await Promise.all([...running, accessing, terminals.settled()]);
  };
}
