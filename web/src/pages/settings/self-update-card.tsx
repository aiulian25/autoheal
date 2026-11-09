import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_ROUTES, type SelfUpdateView } from "../../../../src/shared/api.js";
import { SELF_UPDATE_FINAL, SELF_UPDATE_STATUS } from "../../../../src/shared/constants.js";
import { api } from "../../api-client.js";
import { ErrorNotice } from "../../components/common.js";
import { JOB_REFRESH_MILLISECONDS, TEXT } from "../../constants.js";
import { shortImageId, timeAgo } from "../../format.js";
import { selfUpdateQuery } from "../../queries.js";

const text = TEXT.settingsPage;

// While an update goes on, it is read again every few seconds; the dashboard may be away for a moment meanwhile.
function updating(view: SelfUpdateView | undefined): boolean {
  const last = view?.last ?? null;
  return last !== null && !SELF_UPDATE_FINAL.includes(last.status) && last.status !== SELF_UPDATE_STATUS.blocked;
}

/** Autoheal updating itself, on the machine it runs on: the image it would run, and how the last update went. */
export function SelfUpdateCard() {
  const queryClient = useQueryClient();
  const status = useQuery({
    ...selfUpdateQuery,
    refetchInterval: (query) => (updating(query.state.data) ? JOB_REFRESH_MILLISECONDS : false),
  });
  const start = useMutation({
    mutationFn: () => api<SelfUpdateView>("POST", API_ROUTES.selfUpdate),
    onSuccess: (view) => queryClient.setQueryData(selfUpdateQuery.queryKey, view),
  });
  const view = status.data;
  const words = text.selfUpdate;
  if (view === undefined) {
    return <ErrorNotice error={status.error} />;
  }
  const last = view.last;
  return (
    <section className="card stack" aria-labelledby="self-update-title">
      <h3 id="self-update-title">{words.title}</h3>
      {view.unavailable !== null && <p className="small muted">{view.unavailable}</p>}
      {view.recoveryBlocked !== null && (
        <p className="notice warning small" role="status">
          {view.recoveryBlocked}
        </p>
      )}
      {view.unavailable === null && (
        <>
          <p className="small muted">{words.explanation(view.reference)}</p>
          {view.runningImage !== null && (
            <p className="small mono">
              {words.runs(
                shortImageId(view.runningImage),
                view.runningSince === null ? null : timeAgo(view.runningSince),
              )}
            </p>
          )}
          <button
            type="button"
            className="primary"
            disabled={start.isPending || updating(view) || view.recoveryBlocked !== null}
            onClick={() => start.mutate()}
          >
            {words.update}
          </button>
        </>
      )}
      <ErrorNotice error={start.error} />
      {last !== null && (
        <p className="small" role="status">
          {words.last}
          {TEXT.separator}
          {timeAgo(last.finishedAt ?? last.startedAt)}
          {TEXT.separator}
          {last.message}
        </p>
      )}
    </section>
  );
}
