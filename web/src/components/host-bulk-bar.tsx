import type { ContainerView } from "../../../src/shared/api.js";
import { JOB_ACTION } from "../../../src/shared/constants.js";
import { TEXT } from "../constants.js";
import {
  type progressOf,
  type BulkAsked,
  type RowAction,
  type useBulkAction,
  targetsOf,
  BULK_ACTIONS,
} from "../container-bulk.js";
import { VolumesLeftOffer } from "../pages/host-volumes.js";
import { LeftBehindOffer } from "../pages/host-networks.js";
import { ErrorNotice } from "./common.js";

// --- the ticked containers, and what may be asked of them at once ---------------------------------------
export const BULK_TEXT = TEXT.hostContainers.bulk;
type Bulk = ReturnType<typeof useBulkAction>;
export type Ask = (action: RowAction, targets: ContainerView[]) => void;
export const toggled = (names: ReadonlySet<string>, name: string) =>
  names.has(name) ? new Set([...names].filter((other) => other !== name)) : new Set([...names, name]);
// How the last bulk action went: in a line while its jobs run, then with what failed and why.
function BulkProgress({ asked, progress }: { asked: BulkAsked; progress: ReturnType<typeof progressOf> }) {
  const label = TEXT.actions.names[asked.action];
  if (asked.action === JOB_ACTION.update) {
    return <span className="small muted">{BULK_TEXT.updating(asked.total)}</span>;
  }
  const line =
    progress.waiting > 0
      ? BULK_TEXT.going(label, asked.jobIds.length - progress.waiting, asked.jobIds.length)
      : BULK_TEXT.finished(label, progress.succeeded, asked.total);
  return (
    <span className="bulk-progress small" role="status">
      <span className="muted">{line}</span>
      {progress.failed.map((job) => (
        <span key={job.id} className="text-danger">
          {job.outcome ?? job.containerName}
        </span>
      ))}
      <ErrorNotice error={asked.refusal} />
    </span>
  );
}
/** Above the table: what the ticked containers can be asked, each action counting the ones it reaches. */
export function BulkBar({
  hostId,
  ticked,
  bulk,
  ask,
  onClear,
  onLookAtVolumes,
}: {
  hostId: string;
  ticked: ContainerView[];
  bulk: Bulk;
  ask: Ask;
  onClear: () => void;
  onLookAtVolumes: () => void;
}) {
  const { run, asked, progress } = bulk;
  return (
    <div className={ticked.length > 0 ? "bulk-bar action-bar" : "bulk-bar"} role="group" aria-label={BULK_TEXT.label}>
      {ticked.length === 0 ? (
        <span className="muted">{BULK_TEXT.hint}</span>
      ) : (
        <>
          <span>{BULK_TEXT.ticked(ticked.length)}</span>
          <button type="button" className="quiet" onClick={onClear}>
            {BULK_TEXT.clear}
          </button>
          {BULK_ACTIONS.map((action) => ({ action, targets: targetsOf(action, ticked) }))
            .filter(({ targets }) => targets.length > 0)
            .map(({ action, targets }) => (
              <button
                key={action}
                type="button"
                className={action === JOB_ACTION.remove ? "danger" : undefined}
                disabled={run.isPending}
                onClick={() => ask(action, targets)}
              >
                {BULK_TEXT.buttons[action](targets.length)}
              </button>
            ))}
        </>
      )}
      {asked !== null && <BulkProgress asked={asked} progress={progress} />}
      {asked?.action === JOB_ACTION.remove && progress.waiting === 0 && (
        <>
          <LeftBehindOffer key={asked.jobIds.join()} hostId={hostId} projects={asked.projects} />
          <VolumesLeftOffer
            key={`${asked.jobIds.join()}-volumes`}
            hostId={hostId}
            projects={asked.projects}
            names={asked.volumes}
            onLook={onLookAtVolumes}
          />
        </>
      )}
      <ErrorNotice error={run.error} />
    </div>
  );
}
