import { BACKUP_DIALOG, BackupDialog, type BackupDialogMode } from "../pages/container-backup.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { API_ROUTES, apiPath, type ContainerView, type StackRestartView } from "../../../src/shared/api.js";
import {
  CONTAINER_HEALTH_NONE,
  CONTAINER_STATE_RUNNING,
  HEALTH_HEALTHY,
  JOB_ACTION,
  JOB_STATUS,
  UPDATE_RUN_STATUS,
} from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { ERROR_TEXT, INVENTORY_REFRESH_MILLISECONDS, JOB_REFRESH_MILLISECONDS, TEXT } from "../constants.js";
import { Bar, ErrorNotice } from "./common.js";
import { bringUnderListHeader } from "../container-motion.js";
import { ComposePanel, stackDriftKey, useStackJob } from "./compose-panel.js";
import { StackDriftPanel } from "./stack-drift.js";
import type { StackDriftView } from "../../../src/shared/stacks.js";
import { isWaiting } from "./container-actions.js";
import { StackLogsPanel, StackRemovePanel, StackUpdatePanel } from "./stack-panels.js";

const text = TEXT.hostContainers.stack;
const stackText = TEXT.stacks;
const PANEL = { compose: "compose", update: "update", logs: "logs", remove: "remove", drift: "drift" } as const;
const DRIFT_REFRESH_MILLISECONDS = 60_000;
type Panel = (typeof PANEL)[keyof typeof PANEL];
const workingLine = (action: string, stack: string) =>
  stackText.working[action as keyof typeof stackText.working]?.(stack) ?? stack;

export const stackRestartQuery = (hostId: string) => ({
  queryKey: ["stack-restart", hostId],
  queryFn: () => api<StackRestartView | null>("GET", apiPath(API_ROUTES.stackRestarts, { hostId })),
});

// Up: running, and healthy where it has a health check.
const isUp = (container: ContainerView) =>
  container.state === CONTAINER_STATE_RUNNING &&
  (container.health === HEALTH_HEALTHY || container.health === CONTAINER_HEALTH_NONE);

function toneOf(up: number, total: number) {
  if (up === total) {
    return "good";
  }
  return up === 0 ? "danger" : "warning";
}

// A restart of the stack while it goes, or where it stopped while that container is still down; nothing otherwise.
function RestartLine({ restart, members }: { restart: StackRestartView; members: readonly ContainerView[] }) {
  if (restart.status === UPDATE_RUN_STATUS.running) {
    return (
      <span className="stack-restart-line muted" role="status">
        {text.restarting(restart.current ?? "", restart.done.length + 1, restart.names.length)}
      </span>
    );
  }
  const failed = members.find((container) => container.name === restart.failed);
  if (restart.status !== UPDATE_RUN_STATUS.stopped || failed === undefined || isUp(failed)) {
    return null;
  }
  const why = restart.refusal === null ? restart.outcome : ERROR_TEXT[restart.refusal];
  return (
    <span className="stack-restart-line text-danger" role="status">
      {text.stoppedAt(failed.name)} {why}
    </span>
  );
}

/** A stack's header row: its name, how many of its containers are up, and its restart, those the others need first. */
export function StackHead({
  hostId,
  stack,
  members,
  canRestart,
  admin = false,
  overSsh = false,
  tick,
}: {
  hostId: string;
  stack: string;
  members: readonly ContainerView[];
  canRestart: boolean;
  // Stop, start, update, remove and the Compose file: an admin's, and read only where the host keeps one to itself.
  admin?: boolean;
  overSsh?: boolean;
  tick?: { ticked: boolean; onChange: () => void };
}) {
  const queryClient = useQueryClient();
  const [panel, setPanel] = useState<Panel | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (panel !== null && bar.current !== null) bringUnderListHeader(bar.current);
  }, [panel]);
  const [backingUp, setBackingUp] = useState<BackupDialogMode | null>(null);
  const stackJob = useStackJob(hostId);
  const restart = useQuery({
    ...stackRestartQuery(hostId),
    refetchInterval: (current) =>
      current.state.data?.status === UPDATE_RUN_STATUS.running
        ? JOB_REFRESH_MILLISECONDS
        : INVENTORY_REFRESH_MILLISECONDS,
  });
  const start = useMutation({
    mutationFn: () => api<StackRestartView>("POST", apiPath(API_ROUTES.stackRestart, { hostId, stack })),
    onSuccess: (view) => {
      queryClient.setQueryData(stackRestartQuery(hostId).queryKey, view);
      void queryClient.invalidateQueries({ queryKey: ["jobs", hostId] });
    },
  });
  const up = members.filter(isUp).length;
  const busy = start.isPending || stackJob.running || restart.data?.status === UPDATE_RUN_STATUS.running;
  const keptByHost = members.some((member) => member.handsOff !== null);
  const drifts = useQuery({
    queryKey: stackDriftKey(hostId),
    queryFn: () => api<StackDriftView[]>("GET", apiPath(API_ROUTES.stackDrift, { hostId })),
    enabled: admin,
    refetchInterval: DRIFT_REFRESH_MILLISECONDS,
  });
  const drift = drifts.data?.find(({ project }) => project === stack);
  const anyRunning = members.some((member) => member.state === CONTAINER_STATE_RUNNING);
  const canChange = admin && !keptByHost;
  const job = stackJob.job;
  const toggle = (next: Panel) => setPanel(panel === next ? null : next);
  const panelButton = (next: Panel, label: string, aria: string, danger = false) => (
    <button
      type="button"
      className={danger ? "quiet danger stack-restart" : "quiet stack-restart"}
      aria-label={aria}
      aria-expanded={panel === next}
      onClick={() => toggle(next)}
    >
      {label}
    </button>
  );
  return (
    <div className="stack-head">
      <div className="stack-head-bar" ref={bar}>
        <span>{stack}</span>
        {tick !== undefined && (
          <input
            type="checkbox"
            checked={tick.ticked}
            aria-label={stackText.labels.tick(stack)}
            onChange={tick.onChange}
          />
        )}
        <span className="stack-score">
          <Bar fraction={up / members.length} tone={toneOf(up, members.length)} />
          {text.up(up, members.length)}
        </span>
        {backingUp !== null && (
          <BackupDialog
            hostId={hostId}
            target={{ container: null, stack }}
            mode={backingUp}
            onClose={() => setBackingUp(null)}
          />
        )}
        {admin && (
          <button
            type="button"
            className="quiet stack-restart"
            aria-label={TEXT.containerBackup.backUpStackLabel(stack)}
            disabled={busy}
            onClick={() => setBackingUp(BACKUP_DIALOG.backUp)}
          >
            {TEXT.containerBackup.backUpStack}
          </button>
        )}
        {admin && (
          <button
            type="button"
            className="quiet stack-restart"
            aria-label={TEXT.containerBackup.restoreStackLabel(stack)}
            disabled={busy}
            onClick={() => setBackingUp(BACKUP_DIALOG.restore)}
          >
            {TEXT.containerBackup.restoreStack}
          </button>
        )}
        {canRestart && (
          <button
            type="button"
            className="quiet stack-restart"
            aria-label={text.restartLabel(stack)}
            disabled={busy}
            onClick={() => start.mutate()}
          >
            {text.restart}
          </button>
        )}
        {canChange &&
          (anyRunning ? (
            <button
              type="button"
              className="quiet stack-restart"
              aria-label={stackText.labels.stop(stack)}
              disabled={busy}
              onClick={() => stackJob.start.mutate({ action: JOB_ACTION.stackStop, project: stack })}
            >
              {stackText.actions.stop}
            </button>
          ) : (
            <button
              type="button"
              className="quiet stack-restart"
              aria-label={stackText.labels.start(stack)}
              disabled={busy}
              onClick={() => stackJob.start.mutate({ action: JOB_ACTION.stackStart, project: stack })}
            >
              {stackText.actions.start}
            </button>
          ))}
        {canChange && panelButton(PANEL.update, stackText.actions.update, stackText.labels.update(stack))}
        {admin && panelButton(PANEL.logs, stackText.actions.logs, stackText.labels.logs(stack))}
        {admin && panelButton(PANEL.compose, stackText.actions.compose, stackText.labels.compose(stack))}
        {drift !== undefined && panelButton(PANEL.drift, stackText.drift.badge, stackText.drift.badgeLabel(stack))}
        {canChange && panelButton(PANEL.remove, stackText.actions.remove, stackText.labels.remove(stack), true)}
        {restart.data?.stack === stack && <RestartLine restart={restart.data} members={members} />}
        {stackJob.running && job !== null && (
          <span className="stack-restart-line muted" role="status">
            {workingLine(job.action, stack)}
          </span>
        )}
        {job !== null && !isWaiting(job) && job.status === JOB_STATUS.failed && (
          <span className="stack-restart-line text-danger" role="status">
            {job.outcome}
          </span>
        )}
        <ErrorNotice error={start.error ?? stackJob.start.error} />
      </div>
      {panel !== null && (
        <div className="stack-panel">
          {panel === PANEL.compose && (
            <ComposePanel hostId={hostId} project={stack} readOnly={keptByHost} onClose={() => setPanel(null)} />
          )}
          {panel === PANEL.update && (
            <StackUpdatePanel
              hostId={hostId}
              stack={stack}
              members={members}
              overSsh={overSsh}
              onClose={() => setPanel(null)}
            />
          )}
          {panel === PANEL.logs && <StackLogsPanel hostId={hostId} stack={stack} />}
          {panel === PANEL.drift && drift !== undefined && (
            <StackDriftPanel hostId={hostId} drift={drift} canChange={canChange} />
          )}
          {panel === PANEL.remove && <StackRemovePanel hostId={hostId} stack={stack} onClose={() => setPanel(null)} />}
        </div>
      )}
    </div>
  );
}
