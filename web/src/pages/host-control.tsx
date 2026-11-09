import { MaintenanceDialog } from "../components/maintenance-dialog.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import {
  API_ROUTES,
  apiPath,
  type HostControlChange,
  type HostControlView,
  type HostView,
  type JobView,
} from "../../../src/shared/api.js";
import {
  HOST_RESTART_CHOICES,
  HOST_UPDATE_CHOICES,
  IMAGE_CLEANUP,
  IMAGE_CLEANUPS,
  type ImageCleanup,
} from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { ChoiceCard, choicesOf } from "../components/choice-card.js";
import { ErrorNotice, Loading, TimeAgo } from "../components/common.js";
import { isWaiting } from "../components/container-actions.js";
import { PATHS, TEXT } from "../constants.js";
import { dayIn } from "../format.js";
import { SavedNote, useSavedNote } from "../components/saved-note.js";

const hostControlQuery = (hostId: string) => ({
  queryKey: ["host-control", hostId],
  queryFn: () => api<HostControlView>("GET", apiPath(API_ROUTES.hostControl, { hostId })),
});

// When the next clean-up runs, or why none comes.
function cleanupLine(view: HostControlView, host: HostView): string {
  const text = TEXT.hostControl;
  if (view.imageCleanup === IMAGE_CLEANUP.off) {
    return text.never;
  }
  if (host.dryRun !== false) {
    return text.watchOnly;
  }
  return view.nextCleanupAt === null
    ? text.keeps
    : `${text.nextRun(dayIn(view.nextCleanupAt, view.timeZone))} ${text.keeps}`;
}

function LastCleanup({ job }: { job: JobView | null }) {
  if (job === null) {
    return null;
  }
  return (
    <p className="muted small">
      {TEXT.hostControl.last} <TimeAgo timestamp={job.completedAt ?? job.createdAt} />
      {TEXT.separator}
      {isWaiting(job) ? TEXT.actions.waiting : job.outcome}
    </p>
  );
}

/**
 * What Autoheal may do on a host besides what a container is set to on its own: when one dies, when a
 * new image is out, and when the images no container uses are removed. The host's .env has the last word.
 */
export function HostControl({ host, admin }: { host: HostView; admin: boolean }) {
  const queryClient = useQueryClient();
  const control = useQuery(hostControlQuery(host.id));
  const saved = useSavedNote();
  const save = useMutation({
    mutationFn: (change: HostControlChange) =>
      api<HostControlView>("PUT", apiPath(API_ROUTES.hostControl, { hostId: host.id }), change),
    onSuccess: (view) => {
      queryClient.setQueryData(hostControlQuery(host.id).queryKey, view);
      // A container without its own choice follows the host's.
      void queryClient.invalidateQueries({ queryKey: ["containers"] });
      saved.show();
    },
  });
  const view = control.data;
  const text = TEXT.hostControl;
  if (view === undefined) {
    return control.error ? <ErrorNotice error={control.error} /> : <Loading />;
  }
  return (
    <section className="host-control" aria-labelledby="host-control-title">
      <header className="section-head">
        <h2 id="host-control-title">{text.title(host.label)}</h2>
        <SavedNote shown={saved.shown} />
      </header>
      {host.dryRun !== false && <p className="notice warning">{host.dryRun === null ? text.unknown : text.watching}</p>}
      {admin && (
        <p>
          <Link to={`${PATHS.replays}?hostId=${encodeURIComponent(host.id)}#policy-rehearsal`}>
            Rehearse recovery policy
          </Link>
        </p>
      )}
      <MaintenanceDialog hostId={host.id} admin={admin} />
      <div className="choice-cards">
        <ChoiceCard
          title={text.restartTitle}
          name={`restart-${host.id}`}
          choices={choicesOf(HOST_RESTART_CHOICES, text.restartChoices)}
          chosen={view.restartDefault}
          disabled={!admin}
          onChoose={(restartDefault) => save.mutate({ restartDefault })}
        />
        <ChoiceCard
          title={text.updateTitle}
          name={`update-${host.id}`}
          choices={choicesOf(HOST_UPDATE_CHOICES, text.updateChoices)}
          chosen={view.updateDefault}
          disabled={!admin}
          onChoose={(updateDefault) => save.mutate({ updateDefault })}
        />
        <section className="card choice-card">
          <h3>{text.cleanupTitle}</h3>
          <label className="cleanup-often">
            {text.howOften}
            <select
              value={view.imageCleanup}
              disabled={!admin}
              onChange={(event) => save.mutate({ imageCleanup: event.target.value as ImageCleanup })}
            >
              {IMAGE_CLEANUPS.map((choice) => (
                <option key={choice} value={choice}>
                  {text.cleanups[choice]}
                </option>
              ))}
            </select>
          </label>
          {view.imageCleanup !== IMAGE_CLEANUP.off && (
            <label className="choice-option build-cache">
              <input
                type="checkbox"
                checked={view.clearBuildCache}
                disabled={!admin}
                onChange={(event) => save.mutate({ clearBuildCache: event.target.checked })}
              />
              <span className="choice-words">{text.buildCache}</span>
            </label>
          )}
          {view.imageCleanup !== IMAGE_CLEANUP.off && (
            <label className="choice-option build-cache" title={text.leftNetworksNote}>
              <input
                type="checkbox"
                checked={view.clearLeftNetworks}
                disabled={!admin}
                onChange={(event) => save.mutate({ clearLeftNetworks: event.target.checked })}
              />
              <span className="choice-words">{text.leftNetworks}</span>
            </label>
          )}
          <p className="small faint cleanup-line">{cleanupLine(view, host)}</p>
          <LastCleanup job={view.lastCleanup} />
        </section>
      </div>
      <ErrorNotice error={save.error} />
    </section>
  );
}
