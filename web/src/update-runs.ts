import { createElement, useState, useRef } from "react";
import { OperationImpactReview } from "./components/dependency-map.js";
import { JOB_ACTION } from "../../src/shared/constants.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_ROUTES, apiPath, type UpdateRunView } from "../../src/shared/api.js";
import { UPDATE_RUN_STATUS } from "../../src/shared/constants.js";
import { api } from "./api-client.js";
import { INVENTORY_REFRESH_MILLISECONDS, JOB_REFRESH_MILLISECONDS, TEXT } from "./constants.js";
import { boardQuery } from "./queries.js";

export type RunState = keyof typeof TEXT.containerImages.states;

export const updateRunQuery = (hostId: string) => ({
  queryKey: ["update-run", hostId],
  queryFn: () => api<UpdateRunView | null>("GET", apiPath(API_ROUTES.containerUpdates, { hostId })),
});

/** Where one container stands in a run: null when the run does not name it. */
export function stateIn(run: UpdateRunView | null, name: string): RunState | null {
  if (run === null || !run.names.includes(name)) {
    return null;
  }
  if (run.done.includes(name)) {
    return "done";
  }
  if (run.failed === name) {
    return "failed";
  }
  if (run.current === name) {
    return "current";
  }
  return run.status === UPDATE_RUN_STATUS.stopped ? "waits" : "queued";
}

/** Why a container waits in a run, in a few words; null when it does not wait in one. */
export function waitInRun(run: UpdateRunView | null, name: string): string | null {
  const state = stateIn(run, name);
  return state === "queued" || state === "waits" ? TEXT.containerImages.states[state] : null;
}

/** The run in a line: which one is updating, how many were, or which one went wrong. */
export function runLine(run: UpdateRunView): string {
  const text = TEXT.containerImages;
  if (run.status === UPDATE_RUN_STATUS.finished) {
    return text.finished(run.done.length);
  }
  if (run.status === UPDATE_RUN_STATUS.stopped) {
    return text.stopped(run.failed ?? "", run.failedOutcome ?? null);
  }
  const current = run.current ?? run.names[run.done.length] ?? "";
  return text.running(current, run.done.length + 1, run.names.length);
}

/**
 * A host's latest run of updates, followed closely while it goes, and the way to start one: the
 * ticked containers one at a time, the rest waiting if one does not come back healthy.
 */
export function useUpdateRun(hostId: string) {
  const queryClient = useQueryClient();
  const [reviewing, setReviewing] = useState<readonly string[] | null>(null);
  const proofs = useRef<Record<string, string> | undefined>(undefined);
  const query = updateRunQuery(hostId);
  const run = useQuery({
    ...query,
    refetchInterval: (current) =>
      current.state.data?.status === UPDATE_RUN_STATUS.running
        ? JOB_REFRESH_MILLISECONDS
        : INVENTORY_REFRESH_MILLISECONDS,
  });
  const start = useMutation({
    mutationFn: (names: readonly string[]) => {
      const previews = proofs.current;
      proofs.current = undefined;
      return api<UpdateRunView>("POST", apiPath(API_ROUTES.containerUpdates, { hostId }), {
        names,
        ...(previews ? { previews } : {}),
      });
    },
    onSuccess: async (view) => {
      queryClient.setQueryData(query.queryKey, view);
      await queryClient.invalidateQueries({ queryKey: boardQuery.queryKey });
    },
  });
  const latest = run.data ?? null;
  const busy = latest?.status === UPDATE_RUN_STATUS.running || start.isPending;
  const review = (names: readonly string[]) => setReviewing(names);
  const impact = reviewing
    ? createElement(OperationImpactReview, {
        hostId,
        action: JOB_ACTION.update,
        names: reviewing,
        onCancel: () => setReviewing(null),
        onConfirm: (previews: Record<string, string>) => {
          proofs.current = previews;
          start.mutate(reviewing);
          setReviewing(null);
        },
      })
    : null;
  return { run: latest, start, review, impact, busy, error: run.error ?? start.error };
}
