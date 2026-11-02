import { useQuery } from "@tanstack/react-query";
import type { HostView } from "../../../src/shared/api.js";
import { HOST_KIND } from "../../../src/shared/constants.js";
import { RUNNER_UPDATE_COMMAND, TEXT } from "../constants.js";
import { settingsQuery } from "../queries.js";
import { CommandBlock } from "./ssh-setup.js";

export const isRunnerHost = (host: HostView) => (host.kind ?? HOST_KIND.runner) === HOST_KIND.runner;

/** A runner on another version than Autoheal, and the command that brings it level, run where its compose file is. */
export function RunnerBehind({ host, warning }: { host: HostView; warning?: string }) {
  const autoheal = useQuery(settingsQuery).data?.version;
  const runner = host.runnerVersion;
  if (autoheal === undefined || runner === null || runner === autoheal) {
    return null;
  }
  return (
    <div className="notice small stack" role="status">
      {warning !== undefined && <strong>{warning}</strong>}
      <p>{TEXT.ssh.runnerBehind(runner, autoheal)}</p>
      <CommandBlock command={RUNNER_UPDATE_COMMAND} />
    </div>
  );
}
