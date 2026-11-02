import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { hasUpdate, type ContainerView } from "../../../src/shared/api.js";
import { BYTES_PER_KILOBYTE, CONTROL_LOCK, JOB_ACTION } from "../../../src/shared/constants.js";
import { STACK_ASK } from "../../../src/shared/stacks.js";
import { TEXT } from "../constants.js";
import { bytes } from "../format.js";
import { useUpdateRun } from "../update-runs.js";
import { ErrorNotice } from "./common.js";
import { askStack, useStackJob } from "./compose-panel.js";

const text = TEXT.stacks;

/** What is new in a stack: databases stay unticked, as everywhere else, and each goes one at a time. */
export function StackUpdatePanel({
  hostId,
  stack,
  members,
  overSsh,
  onClose,
}: {
  hostId: string;
  stack: string;
  members: readonly ContainerView[];
  overSsh: boolean;
  onClose: () => void;
}) {
  const { review, impact, busy, error } = useUpdateRun(hostId);
  const isDatabase = (container: ContainerView) => container.byItself.updateLock === CONTROL_LOCK.database;
  const waiting = members.filter(hasUpdate);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(
    new Set(waiting.filter((container) => !isDatabase(container)).map(({ name }) => name)),
  );
  const toggle = (name: string) =>
    setTicked(ticked.has(name) ? new Set([...ticked].filter((other) => other !== name)) : new Set([...ticked, name]));
  return (
    <div className="compose-panel">
      <p className="small">
        <strong>{text.update.title(stack)}</strong>
      </p>
      {waiting.length === 0 && <p className="small muted">{text.update.none}</p>}
      {members.map((container) => {
        const isNew = waiting.includes(container);
        const line = isNew && isDatabase(container) ? text.update.database : text.update.willUpdate;
        return (
          <div key={container.name} className="network-panel-row">
            <span>
              {isNew && (
                <input
                  type="checkbox"
                  checked={ticked.has(container.name)}
                  aria-label={text.update.tick(container.name)}
                  onChange={() => toggle(container.name)}
                />
              )}{" "}
              <span className="mono">{container.name}</span>
            </span>
            <span className="mono muted">{container.image}</span>
            <span className={isNew ? "text-good" : "muted"}>{isNew ? line : text.update.upToDate}</span>
          </div>
        );
      })}
      {waiting.length > 0 && overSsh && <p className="small text-warning">{text.update.noCopy}</p>}
      <ErrorNotice error={error} />
      {impact}
      <div className="compose-foot">
        <button type="button" className="quiet" onClick={onClose}>
          {text.update.cancel}
        </button>
        <span className="compose-grow" />
        {waiting.length > 0 && (
          <button
            type="button"
            className="primary"
            disabled={ticked.size === 0 || busy}
            onClick={() => review([...ticked])}
          >
            {text.update.go(ticked.size)}
          </button>
        )}
      </div>
    </div>
  );
}

/** Every container's last lines together: a stack fails between its containers. */
export function StackLogsPanel({ hostId, stack }: { hostId: string; stack: string }) {
  const logs = useQuery({
    queryKey: ["stack-logs", hostId, stack],
    queryFn: () => askStack(hostId, stack, { kind: STACK_ASK.logs }),
    staleTime: 0,
    gcTime: 0,
  });
  return (
    <div className="compose-panel">
      <p className="small">
        <strong>{text.logs.title(stack)}</strong> <span className="muted">· {text.logs.all}</span>{" "}
        <button type="button" className="link small" onClick={() => void logs.refetch()}>
          {text.logs.refresh}
        </button>
      </p>
      {logs.isPending && <p className="small muted">{text.logs.loading}</p>}
      <ErrorNotice error={logs.error} />
      {logs.data?.error != null && <p className="small text-danger">{logs.data.error}</p>}
      {logs.data?.logs != null && <pre className="mono compose-logs">{logs.data.logs || text.logs.none}</pre>}
    </div>
  );
}

/** Says what goes and what stays. Keeping its data is already picked, and nothing outside its folder ever goes. */
export function StackRemovePanel({ hostId, stack, onClose }: { hostId: string; stack: string; onClose: () => void }) {
  const facts = useQuery({
    queryKey: ["stack-removal", hostId, stack],
    queryFn: () => askStack(hostId, stack, { kind: STACK_ASK.removal }),
    staleTime: 0,
    gcTime: 0,
  });
  const [removeData, setRemoveData] = useState(false);
  const stackJob = useStackJob(hostId);
  const removal = facts.data?.removal ?? null;
  const never = [...(removal?.sharedNetworks ?? []), ...(removal?.outside ?? []), text.remove.composeFile];
  const job = stackJob.job;
  return (
    <div className="compose-panel">
      <p className="small">
        <strong>{text.remove.title(stack)}</strong>
      </p>
      {facts.isPending && <p className="small muted">{text.remove.loading}</p>}
      <ErrorNotice error={facts.error ?? stackJob.start.error} />
      {facts.data?.error != null && <p className="small text-danger">{facts.data.error}</p>}
      {removal !== null && (
        <>
          <div className="stack-remove-row">
            <span className="muted">{text.remove.goes}</span>
            <span>{text.remove.containers(removal.containers.length, removal.networks)}</span>
          </div>
          <div className="stack-remove-row">
            <span className="muted">{text.remove.choice}</span>
            <span className="install-choices" role="group" aria-label={text.remove.choice}>
              <button
                type="button"
                className="install-choice"
                aria-pressed={!removeData}
                onClick={() => setRemoveData(false)}
              >
                {text.remove.keepData}
              </button>
              <button
                type="button"
                className="install-choice"
                aria-pressed={removeData}
                onClick={() => setRemoveData(true)}
              >
                {text.remove.removeData}
              </button>
            </span>
          </div>
          <div className="stack-remove-row">
            <span className="muted">{text.remove.data}</span>
            <span>
              {removal.data.length === 0 && text.remove.noData}
              {removal.data.map(({ path, sizeBytes }) => (
                <span key={path} className="mono stack-remove-path">
                  {path}
                  {sizeBytes !== null && ` · ${bytes(sizeBytes, BYTES_PER_KILOBYTE)}`}
                </span>
              ))}
            </span>
          </div>
          {removal.kept.length > 0 && (
            <div className="stack-remove-row">
              <span className="muted">{text.remove.kept}</span>
              <span>
                {removal.kept.map(({ path, why, usedBy }) => (
                  <span key={path} className="mono stack-remove-path">
                    {path}
                    {` · ${text.remove.keptWhy[why](usedBy.join(", "))}`}
                  </span>
                ))}
              </span>
            </div>
          )}
          <div className="stack-remove-row">
            <span className="muted">{text.remove.never}</span>
            <span className="mono">{never.join(" · ")}</span>
          </div>
        </>
      )}
      {job !== null && (
        <p className={job.status === "failed" ? "small text-danger" : "small"} role="status">
          {job.outcome ?? text.working.stack_remove(stack)}
        </p>
      )}
      <div className="compose-foot">
        <button type="button" className="quiet" onClick={onClose}>
          {text.remove.cancel}
        </button>
        <span className="compose-grow" />
        <button
          type="button"
          className="danger"
          disabled={removal === null || stackJob.running}
          onClick={() => stackJob.start.mutate({ action: JOB_ACTION.stackRemove, project: stack, removeData })}
        >
          {removeData ? text.remove.dataGo : text.remove.keepGo}
        </button>
      </div>
    </div>
  );
}
