import { useState } from "react";
import { JOB_ACTION, JOB_STATUS } from "../../../src/shared/constants.js";
import { STACK_DRIFT_KIND, type StackDriftView } from "../../../src/shared/stacks.js";
import { TEXT } from "../constants.js";
import { ErrorNotice, TimeAgo } from "./common.js";
import { useStackJob } from "./compose-panel.js";

const text = TEXT.stacks.drift;
const RECREATED_KINDS: ReadonlySet<string> = new Set([
  STACK_DRIFT_KIND.source,
  STACK_DRIFT_KIND.runtime,
  STACK_DRIFT_KIND.missing,
]);

/**
 * How a stack differs from its files, by name alone: no value is ever here. Reading it changes nothing. Recreating
 * from the files is asked for and confirmed, and the host refuses it if what differs has changed since this was read.
 */
export function StackDriftPanel({
  hostId,
  drift,
  canChange,
}: {
  hostId: string;
  drift: StackDriftView;
  canChange: boolean;
}) {
  const [asked, setAsked] = useState(false);
  const stackJob = useStackJob(hostId);
  const job = stackJob.job;
  const recreated = drift.services.filter(({ kind }) => RECREATED_KINDS.has(kind)).map(({ service }) => service);
  return (
    <div className="compose-panel">
      <p className="small">
        <strong>{text.title(drift.project)}</strong>
      </p>
      <p className="small muted">
        {text.files(drift.files.join(", "))} {text.seen} <TimeAgo timestamp={drift.firstSeenAt} /> · {text.lastLooked}{" "}
        <TimeAgo timestamp={drift.lastObservedAt} />
      </p>
      {drift.unreadable && <p className="small text-warning">{text.unreadable}</p>}
      {drift.services.map(({ service, container, kind, fields }) => (
        <div key={`${service}/${container ?? ""}`} className="stack">
          <p className="small">
            <strong>{service}</strong> <span className="muted">{text.kind[kind]}</span>
          </p>
          {fields.map(({ field, names }) => (
            <p key={field} className="small muted">
              {text.field[field]}
              {names.length > 0 && <span className="mono"> {names.join(", ")}</span>}
            </p>
          ))}
        </div>
      ))}
      <p className="small muted">{text.valuesHidden}</p>
      <ErrorNotice error={stackJob.start.error} />
      {canChange && recreated.length > 0 && !asked && job === null && (
        <button type="button" onClick={() => setAsked(true)}>
          {text.reconcile}
        </button>
      )}
      {asked && job === null && (
        <div className="notice warning small">
          <p>{text.confirm(recreated.join(", "))}</p>
          <button
            type="button"
            disabled={stackJob.running}
            onClick={() =>
              stackJob.start.mutate({
                action: JOB_ACTION.stackUp,
                project: drift.project,
                reconcile: { revision: drift.revision },
              })
            }
          >
            {text.confirmRun}
          </button>
          <button type="button" onClick={() => setAsked(false)}>
            {text.cancel}
          </button>
        </div>
      )}
      {job !== null && job.outcome !== null && (
        <p className={job.status === JOB_STATUS.succeeded ? "small text-good" : "small text-danger"} role="status">
          {job.outcome}
        </p>
      )}
    </div>
  );
}
