import { useMutation, useQuery } from "@tanstack/react-query";
import { API_ROUTES, apiPath, type HostView } from "../../../src/shared/api.js";
import { HOST_KIND, JOB_ACTION, RUNNER_UPDATE_REPORT } from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { ErrorNotice } from "../components/common.js";
import { RUNNER_UPDATE_COMMAND, RUNNER_UPDATE_SHOWN_MILLISECONDS, TEXT } from "../constants.js";
import { timeAgo } from "../format.js";
import { settingsQuery } from "../queries.js";
import { isAdmin, useSession } from "../session.js";
import { CommandBlock } from "./ssh-setup.js";

export const isRunnerHost = (host: HostView) => (host.kind ?? HOST_KIND.runner) === HOST_KIND.runner;

/** Asks a sidecar runner to replace itself with the newest image behind its own tag; what happens next once asked. */
export function UpdateRunnerButton({ hostId, asked }: { hostId: string; asked: string }) {
  const update = useMutation({
    mutationFn: () => api("POST", apiPath(API_ROUTES.hostActions, { hostId }), { action: JOB_ACTION.updateRunner }),
  });
  if (update.isSuccess) {
    return <span className="small">{asked}</span>;
  }
  return (
    <>
      <button type="button" disabled={update.isPending} onClick={() => update.mutate()}>
        {TEXT.ssh.updateRunner}
      </button>
      <ErrorNotice error={update.error} />
    </>
  );
}

/** Its last update from here, where its version does not say how that went: at work, or not gone through and why. */
function LastRunnerUpdate({ update }: { update: NonNullable<HostView["runnerUpdate"]> }) {
  if (update.state === RUNNER_UPDATE_REPORT.state.running) return <p>{TEXT.ssh.runnerUpdating}</p>;
  if (update.state === RUNNER_UPDATE_REPORT.state.succeeded) return null;
  return (
    <p>
      {TEXT.ssh.runnerUpdateFailed(update.message ?? TEXT.ssh.runnerUpdateUnsaid)}
      {update.finishedAt !== null && <span className="muted"> {timeAgo(update.finishedAt)}</span>}
    </p>
  );
}

/**
 * A runner level with Autoheal: what an update from here is still doing, as its helper watches the new one, or that one
 * lately did not go through. There is nothing more to ask for.
 */
function LevelRunnerUpdate({ update }: { update: HostView["runnerUpdate"] }) {
  if (update === null || update === undefined) return null;
  const lately = update.finishedAt !== null && Date.now() - update.finishedAt < RUNNER_UPDATE_SHOWN_MILLISECONDS;
  const underWay = update.state === RUNNER_UPDATE_REPORT.state.running;
  const failedLately = update.state === RUNNER_UPDATE_REPORT.state.failed && lately;
  if (!underWay && !failedLately) return null;
  return (
    <div className="notice small stack" role="status">
      <LastRunnerUpdate update={update} />
    </div>
  );
}

/**
 * A runner on another version than Autoheal, and the ways to bring it level: from here, which has it replace itself
 * with the newest image behind its tag, or by hand on that host, as any other container manager would.
 */
export function RunnerBehind({ host, warning }: { host: HostView; warning?: string }) {
  const autoheal = useQuery(settingsQuery).data?.version;
  const admin = isAdmin(useSession().data);
  const runner = host.runnerVersion;
  const lastUpdate = host.runnerUpdate ?? null;
  if (autoheal === undefined || runner === null) {
    return null;
  }
  if (runner === autoheal) return <LevelRunnerUpdate update={lastUpdate} />;
  return (
    <div className="notice small stack" role="status">
      {warning !== undefined && <strong>{warning}</strong>}
      <p>{TEXT.ssh.runnerBehind(runner, autoheal)}</p>
      {lastUpdate !== null && <LastRunnerUpdate update={lastUpdate} />}
      {admin && (
        <div className="card-actions">
          <UpdateRunnerButton hostId={host.id} asked={TEXT.ssh.updateRunnerAsked} />
        </div>
      )}
      <p className="muted">{TEXT.ssh.orOnHost}</p>
      <CommandBlock command={RUNNER_UPDATE_COMMAND} />
    </div>
  );
}
