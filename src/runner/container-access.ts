import type { BackupAnswer, BackupRequest } from "../shared/container-backups.js";
import type { StackAnswer, StackRequest } from "../shared/stacks.js";
import type { VolumeLookAnswer } from "../shared/volumes.js";
import type { ApplicationBackups } from "./application-backups.js";
import type { OperationPreviewAnswer, OperationPreviewRequest } from "../shared/topology.js";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CONTAINER_ACCESS_RETRY_MILLISECONDS,
  CONTROL_PLANE_CALLS,
  RUNNER_MESSAGES,
  WORK_POLL_INTERVAL_MILLISECONDS,
} from "../shared/constants.js";
import { describeError } from "../shared/errors.js";
import { log } from "../shared/log.js";
import type { HostProfileAnswer } from "../shared/protocol.js";
import type { ControlPlaneClient } from "./control-plane-client.js";
import type { SettingsReader } from "./container-settings.js";
import type { FileOperations } from "./file-operations.js";
import type { Installs } from "./installs.js";
import type { TerminalSessions } from "./terminal-sessions.js";

export interface ContainerAccessDependencies {
  controlPlane: Pick<
    ControlPlaneClient,
    | "takeContainerAccessWork"
    | "reportFileAnswer"
    | "reportSettingsAnswer"
    | "reportHostProfile"
    | "reportVolumeLook"
    | "reportStack"
    | "reportBackup"
    | "reportInstall"
  > &
    Partial<Pick<ControlPlaneClient, "reportOperationPreview" | "takeApplicationBackupWork" | "terminalEnd">>;
  recoveryBlocked?: (containerName: string) => boolean;
  applicationBackups?: Pick<ApplicationBackups, "run" | "flush">;
  previews?: { answer: (request: OperationPreviewRequest) => Promise<OperationPreviewAnswer> };
  terminals: Pick<TerminalSessions, "start">;
  files: Pick<FileOperations, "answer">;
  settings: Pick<SettingsReader, "answer">;
  profile: () => Promise<HostProfileAnswer>;
  lookInsideVolume?: (name: string) => Promise<VolumeLookAnswer>;
  stacks?: { answer: (request: StackRequest) => Promise<StackAnswer> };
  backups?: { answer: (request: BackupRequest) => Promise<BackupAnswer> };
  installs: Pick<Installs, "answer">;
}

const RECOVERY_REFUSAL = "Application data recovery is incomplete. Resume or resolve it before opening this container.";

/**
 * Listens for shells to open and files to reach for as long as the runner runs, each heard of the moment a
 * person asks. Each is started at once, so a slow one holds up none of the others. Only where the host's .env
 * lets people reach inside its containers.
 */
export async function followContainerAccess(dependencies: ContainerAccessDependencies, signal: AbortSignal) {
  let failing = false;
  const active = new Set<Promise<unknown>>();
  const track = (work: Promise<unknown>) => {
    active.add(work);
    void work.finally(() => active.delete(work));
  };
  const interactive = async () => {
    while (!signal.aborted) {
      try {
        const work = await dependencies.controlPlane.takeContainerAccessWork(signal);
        failing = false;
        if (signal.aborted) break;
        for (const request of work.previews ?? []) {
          track(
            (
              dependencies.previews?.answer(request) ??
              Promise.resolve<OperationPreviewAnswer>({
                ok: false,
                reason: "Operation previews are unavailable on this runner.",
              })
            )
              .then((answer) => dependencies.controlPlane.reportOperationPreview?.(request.id, answer))
              .catch(() => undefined),
          );
        }
        for (const terminal of work.terminals) {
          if (terminal.containerName !== null && dependencies.recoveryBlocked?.(terminal.containerName)) {
            track(
              (
                dependencies.controlPlane.terminalEnd?.(terminal.id, { exitCode: null, reason: RECOVERY_REFUSAL }) ??
                Promise.resolve()
              ).catch(() => undefined),
            );
          } else dependencies.terminals.start(terminal);
        }
        for (const request of work.files) {
          track(
            (dependencies.recoveryBlocked?.(request.containerName)
              ? Promise.resolve({ error: RECOVERY_REFUSAL, entries: null, content: null, truncated: false })
              : dependencies.files.answer(request)
            )
              .then((answer) => dependencies.controlPlane.reportFileAnswer(request.id, answer))
              .catch(() => undefined),
          );
        }
        for (const request of work.profiles ?? []) {
          track(
            dependencies
              .profile()
              .then((answer) => dependencies.controlPlane.reportHostProfile(request.id, answer))
              .catch(() => undefined),
          );
        }
        for (const request of work.volumeLooks ?? []) {
          track(
            (dependencies.lookInsideVolume?.(request.name) ?? Promise.reject(new Error("unavailable")))
              .then((answer) => dependencies.controlPlane.reportVolumeLook(request.id, answer))
              .catch(() => undefined),
          );
        }
        for (const request of work.stacks ?? []) {
          track(
            (dependencies.stacks?.answer(request) ?? Promise.reject(new Error("unavailable")))
              .then((answer) => dependencies.controlPlane.reportStack(request.id, answer))
              .catch(() => undefined),
          );
        }
        for (const request of work.backups ?? []) {
          track(
            (dependencies.backups?.answer(request) ?? Promise.reject(new Error("unavailable")))
              .then((answer) => dependencies.controlPlane.reportBackup(request.id, answer))
              .catch(() => undefined),
          );
        }
        for (const request of work.installs ?? []) {
          track(
            dependencies.installs
              .answer(request)
              .then((answer) => dependencies.controlPlane.reportInstall(request.id, answer))
              .catch(() => undefined),
          );
        }
        for (const request of work.settings) {
          track(
            (dependencies.recoveryBlocked?.(request.containerName)
              ? Promise.resolve({ error: RECOVERY_REFUSAL, settings: null })
              : dependencies.settings.answer(request)
            )
              .then((answer) => dependencies.controlPlane.reportSettingsAnswer(request.id, answer))
              .catch(() => undefined),
          );
        }
      } catch (error) {
        if (!failing && !signal.aborted) {
          log(RUNNER_MESSAGES.controlPlaneCall(CONTROL_PLANE_CALLS.containerAccess, describeError(error)));
        }
        failing = true;
        await sleep(CONTAINER_ACCESS_RETRY_MILLISECONDS, undefined, { signal }).catch(() => undefined);
      }
    }
  };
  const applicationWork = async () => {
    const applications = dependencies.applicationBackups;
    if (!applications || !dependencies.controlPlane.takeApplicationBackupWork) return;
    let failing = false;
    while (!signal.aborted) {
      try {
        await applications.flush();
        if (signal.aborted) break;
        const tasks = await dependencies.controlPlane.takeApplicationBackupWork(signal);
        for (const task of tasks) {
          if (signal.aborted) break;
          await applications.run(task);
        }
        failing = false;
      } catch (error) {
        if (!failing && !signal.aborted) log(`Application backup work could not be followed: ${describeError(error)}`);
        failing = true;
      }
      await sleep(WORK_POLL_INTERVAL_MILLISECONDS, undefined, { signal }).catch(() => undefined);
    }
  };
  try {
    await Promise.all([interactive(), applicationWork()]);
  } finally {
    await Promise.allSettled([...active]);
  }
}
