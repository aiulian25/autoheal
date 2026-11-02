import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { API_ROUTES, apiPath, type JobView } from "../../../src/shared/api.js";
import { api } from "../api-client.js";
import { JOB_REFRESH_MILLISECONDS, TEXT } from "../constants.js";
import { ErrorNotice, Loading } from "./common.js";
import { isWaiting, jobsQuery } from "./container-actions.js";

const text = TEXT.addContainer;

/** A job on a container that may not be there yet, followed until it ends. */
export function useInstallJob(hostId: string, job: JobView | null) {
  const query = useQuery({
    ...jobsQuery(hostId, job?.containerName ?? ""),
    enabled: job !== null,
    refetchInterval: (latest) => {
      const current = latest.state.data?.find((each) => each.id === job?.id);
      return current === undefined || isWaiting(current) ? JOB_REFRESH_MILLISECONDS : false;
    },
  });
  return query.data?.find((each) => each.id === job?.id) ?? job;
}

/** Takes back what Autoheal installed, asking about its data first: straight after installing, or any time later. */
export function TakeAway({
  hostId,
  name,
  folder,
  onDone,
  label = text.undo,
}: {
  hostId: string;
  name: string;
  folder: string;
  onDone?: () => void;
  label?: string;
}) {
  const queryClient = useQueryClient();
  const [asked, setAsked] = useState(false);
  const undo = useMutation({
    mutationFn: (removeData: boolean) =>
      api<JobView>("POST", apiPath(API_ROUTES.hostInstallUndo, { hostId }), { name, removeData }),
  });
  const job = useInstallJob(hostId, undo.data ?? null);
  useEffect(() => {
    if (job !== null && !isWaiting(job)) void queryClient.invalidateQueries();
  }, [job?.status]);
  if (job !== null) {
    return (
      <div className="stack small">
        {isWaiting(job) ? <Loading /> : <p>{job.outcome}</p>}
        {!isWaiting(job) && onDone !== undefined && (
          <button type="button" onClick={onDone}>
            {text.close}
          </button>
        )}
      </div>
    );
  }
  if (!asked) {
    return (
      <button type="button" onClick={() => setAsked(true)}>
        {label}
      </button>
    );
  }
  return (
    <div className="stack small">
      <p>{text.undoAsk(folder)}</p>
      <div className="row">
        <button type="button" disabled={undo.isPending} onClick={() => undo.mutate(false)}>
          {text.undoKeep}
        </button>
        <button type="button" className="danger" disabled={undo.isPending} onClick={() => undo.mutate(true)}>
          {text.undoAll}
        </button>
      </div>
      <ErrorNotice error={undo.error} />
    </div>
  );
}
