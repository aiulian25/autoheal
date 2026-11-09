import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { API_ROUTES, apiPath, type HostPackagesView, type HostView, type JobView } from "../../../src/shared/api.js";
import { HOST_PACKAGES, HOST_STATE, JOB_ACTION } from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { ErrorNotice } from "../components/common.js";
import { Icon } from "../components/icons.js";
import { isWaiting } from "../components/container-actions.js";
import { JOB_REFRESH_MILLISECONDS, TEXT } from "../constants.js";
import { hostPackagesQuery } from "../queries.js";
import { hostPackageJobKey, useHostPackageBusy } from "./host-packages.js";

// The host's .env lets its packages be listed: a check can be asked for.
const packagesCheckable = (view: HostPackagesView | undefined) =>
  view?.facts !== null &&
  view?.facts !== undefined &&
  view.facts.unsupported === null &&
  view.facts.setting !== HOST_PACKAGES.off;

type CheckAction = typeof JOB_ACTION.checkUpdates | typeof JOB_ACTION.checkPackages;

/** Why no shell can open on the host now; null when one can. */
function terminalUnavailable(host: HostView): string | null {
  const reasons = TEXT.hostTerminal.unavailable;
  if (host.state !== HOST_STATE.online) return reasons.silent(host.label);
  const allowed = host.hostTerminal ?? null;
  if (allowed === null) return reasons.runner(host.label);
  return allowed ? null : reasons.off(host.label);
}

export function TerminalButton({ host, open, onToggle }: { host: HostView; open: boolean; onToggle: () => void }) {
  const unavailable = terminalUnavailable(host);
  return (
    <button
      type="button"
      disabled={unavailable !== null}
      title={unavailable ?? undefined}
      aria-pressed={open}
      onClick={onToggle}
    >
      <Icon name="terminal" />
      {TEXT.hostTerminal.button}
    </button>
  );
}

/**
 * Asks the host's runner to check now, instead of at its next scheduled check: its containers' images, or its own
 * packages. Each button follows its own job, by its id: the host's bounded recent-jobs list may no longer hold it.
 */
function CheckButton({
  hostId,
  action,
  disabled = false,
}: {
  hostId: string;
  action: CheckAction;
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const [accepted, setAccepted] = useState<JobView | null>(null);
  const forPackages = action === JOB_ACTION.checkPackages;
  const result = useQuery({
    queryKey: ["job", accepted?.id],
    queryFn: () => api<JobView>("GET", apiPath(API_ROUTES.job, { jobId: accepted!.id })),
    enabled: accepted !== null,
    initialData: accepted ?? undefined,
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data === undefined || isWaiting(query.state.data) ? JOB_REFRESH_MILLISECONDS : false,
  });
  const check = useMutation({
    // A package check is one of the host's package jobs, which hold one another back.
    mutationKey: forPackages ? hostPackageJobKey(hostId) : undefined,
    mutationFn: () => api<JobView>("POST", apiPath(API_ROUTES.hostActions, { hostId }), { action }),
    onSuccess: setAccepted,
    onSettled: () =>
      forPackages ? queryClient.invalidateQueries({ queryKey: hostPackagesQuery(hostId).queryKey }) : undefined,
  });
  const job = accepted === null ? null : (result.data ?? accepted);
  const busy = job !== null && isWaiting(job);
  const words = TEXT.actions.hostCheck;
  return (
    <div className="header-action stack">
      {job !== null && (
        <span className="small muted" role="status">
          {forPackages ? words.packages : words.images}: {words.states[job.status]}
        </span>
      )}
      <button type="button" disabled={disabled || check.isPending || busy} onClick={() => check.mutate()}>
        {forPackages ? TEXT.actions.checkPackages : TEXT.actions.checkImages}
      </button>
      <ErrorNotice error={check.error} />
      {busy && result.isError && (
        <>
          <p className="notice error small" role="alert">
            {words.unavailable}
          </p>
          <button type="button" disabled={result.isFetching} onClick={() => void result.refetch()}>
            {words.refresh}
          </button>
        </>
      )}
    </div>
  );
}

// Its images are checked only where it runs Docker, and its packages only where its .env lets them be listed.
export function CheckUpdates({ hostId, docker }: { hostId: string; docker: boolean }) {
  const packages = useQuery(hostPackagesQuery(hostId));
  const packagesBusy = useHostPackageBusy(hostId, packages.data, packages.isError);
  return (
    <>
      {docker && <CheckButton hostId={hostId} action={JOB_ACTION.checkUpdates} />}
      {packagesCheckable(packages.data) && (
        <CheckButton hostId={hostId} action={JOB_ACTION.checkPackages} disabled={packagesBusy} />
      )}
    </>
  );
}
