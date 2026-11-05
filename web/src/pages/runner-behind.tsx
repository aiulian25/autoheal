import { useMutation, useQuery } from "@tanstack/react-query";
import { API_ROUTES, apiPath, type HostView } from "../../../src/shared/api.js";
import { HOST_KIND, JOB_ACTION } from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { ErrorNotice } from "../components/common.js";
import { RUNNER_UPDATE_COMMAND, TEXT } from "../constants.js";
import { settingsQuery } from "../queries.js";
import { isAdmin, useSession } from "../session.js";
import { CommandBlock } from "./ssh-setup.js";

export const isRunnerHost = (host: HostView) => (host.kind ?? HOST_KIND.runner) === HOST_KIND.runner;

/**
 * A runner on another version than Autoheal, and the ways to bring it level: from here, which has it replace itself
 * with Autoheal's own release, or by hand on that host, as any other container manager would.
 */
export function RunnerBehind({ host, warning }: { host: HostView; warning?: string }) {
  const autoheal = useQuery(settingsQuery).data?.version;
  const admin = isAdmin(useSession().data);
  const update = useMutation({
    mutationFn: () =>
      api("POST", apiPath(API_ROUTES.hostActions, { hostId: host.id }), { action: JOB_ACTION.updateRunner }),
  });
  const runner = host.runnerVersion;
  if (autoheal === undefined || runner === null || runner === autoheal) {
    return null;
  }
  return (
    <div className="notice small stack" role="status">
      {warning !== undefined && <strong>{warning}</strong>}
      <p>{TEXT.ssh.runnerBehind(runner, autoheal)}</p>
      {admin && !update.isSuccess && (
        <div className="card-actions">
          <button type="button" disabled={update.isPending} onClick={() => update.mutate()}>
            {TEXT.ssh.updateRunner}
          </button>
        </div>
      )}
      {update.isSuccess && <p>{TEXT.ssh.updateRunnerAsked}</p>}
      <ErrorNotice error={update.error} />
      <p className="muted">{TEXT.ssh.orOnHost}</p>
      <CommandBlock command={RUNNER_UPDATE_COMMAND} />
    </div>
  );
}
