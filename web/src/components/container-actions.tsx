import { OperationImpactReview } from "./dependency-map.js";
import { actionPermission } from "../../../src/shared/resource-permissions.js";
import { useResourcePermissions } from "../session.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useEffect, type ReactNode } from "react";
import {
  API_ROUTES,
  JOB_QUERY,
  apiPath,
  hasUpdate,
  updateVersions,
  type ContainerView,
  type JobView,
} from "../../../src/shared/api.js";
import {
  CONTAINER_STATE_PAUSED,
  CONTAINER_STATE_RUNNING,
  JOB_ACTION,
  JOB_STATUS,
  OLD_CONTAINER_SUFFIX,
  type ContainerAction as AnyContainerAction,
} from "../../../src/shared/constants.js";
import { api } from "../api-client.js";
import { askFirstQuestion } from "../ask-first.js";
import { useAskInPlace } from "./ask-in-place.js";
import { JOB_REFRESH_MILLISECONDS, TEXT } from "../constants.js";
import { releaseNotesLink } from "../release-links.js";
import { Badge, ErrorNotice, FollowedLog, PlainText, TimeAgo } from "./common.js";
import { Icon, type IconName } from "./icons.js";

type ContainerAction = Exclude<AnyContainerAction, typeof JOB_ACTION.checkUpdates>;

export const isWaiting = (job: JobView) => job.status === JOB_STATUS.pending || job.status === JOB_STATUS.delivered;

export const jobsQuery = (hostId: string, containerName: string) => ({
  queryKey: ["jobs", hostId, containerName],
  queryFn: () =>
    api<JobView[]>(
      "GET",
      `${API_ROUTES.jobs}?${new URLSearchParams({ [JOB_QUERY.hostId]: hostId, [JOB_QUERY.containerName]: containerName })}`,
    ),
});

const ACTION_ICONS: Partial<Record<ContainerAction, IconName>> = {
  [JOB_ACTION.restart]: "rotateCw",
  [JOB_ACTION.start]: "play",
  [JOB_ACTION.stop]: "square",
  [JOB_ACTION.pause]: "pause",
  [JOB_ACTION.unpause]: "play",
  [JOB_ACTION.update]: "circleArrowUp",
  [JOB_ACTION.remove]: "trash",
};

// Under a row, with room for all of them: what a person can ask of it there, its logs being a tab of their own.
function panelActionsFor(container: ContainerView, parked: boolean): ContainerAction[] {
  if (container.handsOff !== null) return [];
  if (container.recovery !== undefined)
    return actionsFor(container, parked).filter((action) => action !== JOB_ACTION.logs);
  const stopped = container.state !== CONTAINER_STATE_RUNNING && container.state !== CONTAINER_STATE_PAUSED;
  const paused = container.state === CONTAINER_STATE_PAUSED;
  return [
    JOB_ACTION.restart,
    stopped ? JOB_ACTION.start : JOB_ACTION.stop,
    ...(stopped ? [] : [paused ? JOB_ACTION.unpause : JOB_ACTION.pause]),
    JOB_ACTION.update,
    JOB_ACTION.recreate,
    ...(parked ? [JOB_ACTION.rollBack] : []),
    JOB_ACTION.remove,
  ];
}

function actionsFor(container: ContainerView, parked: boolean): ContainerAction[] {
  // Its host would refuse anything but reading.
  if (container.handsOff !== null) {
    return [JOB_ACTION.logs];
  }
  if (container.recovery !== undefined) {
    return container.recovery.owner === container.name ? [JOB_ACTION.rollBack, JOB_ACTION.logs] : [JOB_ACTION.logs];
  }
  const running = container.state === CONTAINER_STATE_RUNNING;
  const actions: ContainerAction[] = running
    ? [JOB_ACTION.restart, JOB_ACTION.stop, JOB_ACTION.logs]
    : [JOB_ACTION.start, JOB_ACTION.remove, JOB_ACTION.logs];
  if (hasUpdate(container)) {
    actions.push(JOB_ACTION.update);
  }
  if (parked) {
    actions.push(JOB_ACTION.rollBack);
  }
  return actions;
}

export function LatestJob({ job }: { job: JobView }) {
  return (
    <div className="stack small">
      <span className="row">
        <Badge value={job.status} />
        <span>{TEXT.actions.names[job.action]}</span>
        <span className="muted">
          {TEXT.actions.by(job.requestedBy)}
          {TEXT.separator}
          <TimeAgo timestamp={job.completedAt ?? job.createdAt} />
        </span>
      </span>
      {isWaiting(job) && <span className="muted">{TEXT.actions.waiting}</span>}
      {job.outcome !== null && <span>{job.outcome}</span>}
      {job.output !== null && (isWaiting(job) ? <FollowedLog text={job.output} /> : <PlainText text={job.output} />)}
    </div>
  );
}

/**
 * A container's actions where you see it: on its task, on its host's page. The host's runner
 * runs them within seconds and has the last word (protected containers, dry-run).
 */
export function ContainerActions({
  container,
  taskId,
  parked,
  canAct,
  tools,
}: {
  container: ContainerView;
  taskId?: string;
  // An update left the old container aside: it can be put back.
  parked: boolean;
  canAct: boolean;
  // Under its row: every action with its icon, and what else opens there, its logs being a tab of their own.
  tools?: ReactNode;
}) {
  const queryClient = useQueryClient();
  const asking = useAskInPlace();
  const permissions = useResourcePermissions();
  const allowed = (action: ContainerAction) => {
    const permission = actionPermission(action);
    return canAct || (permission !== null && permissions.allowed(permission, container));
  };
  const inPanel = tools !== undefined;
  const actions = (inPanel ? panelActionsFor(container, parked) : actionsFor(container, parked)).filter(allowed);
  const [reviewing, setReviewing] = useState<typeof JOB_ACTION.update | typeof JOB_ACTION.rollBack | null>(null);
  useEffect(() => {
    if (reviewing && !allowed(reviewing)) setReviewing(null);
  }, [reviewing, canAct, permissions.allowed]);
  const jobs = useQuery({
    ...jobsQuery(container.hostId, container.name),
    refetchInterval: (query) => (query.state.data?.some(isWaiting) ? JOB_REFRESH_MILLISECONDS : false),
  });
  const run = useMutation({
    mutationFn: ({ action, previewId }: { action: ContainerAction; previewId?: string }) =>
      api<JobView>(
        "POST",
        apiPath(API_ROUTES.containerActions, { hostId: container.hostId, containerName: container.name }),
        { action, ...(taskId === undefined ? {} : { taskId }), ...(previewId ? { previewId } : {}) },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["jobs", container.hostId, container.name] });
      void queryClient.invalidateQueries({ queryKey: ["task"] });
    },
  });
  const proceed = (action: ContainerAction) => {
    if (action === JOB_ACTION.update || action === JOB_ACTION.rollBack) setReviewing(action);
    else run.mutate({ action });
  };
  // Rolling back puts the container's data back as it was, and what changed since is lost: asked first. A stop or a
  // removal asks first where this browser chose that.
  const ask = (action: ContainerAction) => {
    const question =
      action === JOB_ACTION.rollBack
        ? TEXT.actions.confirmRollBack(container.name)
        : askFirstQuestion(action, [container.name]);
    if (question === null) {
      proceed(action);
      return;
    }
    asking.confirm(question, () => proceed(action));
  };
  const latest = inPanel ? jobs.data?.find((job) => job.action !== JOB_ACTION.logs) : jobs.data?.[0];
  return (
    <div className="stack">
      {container.recovery !== undefined && (
        <p className="notice warning small" role="status">
          {TEXT.actions.recovery(container.recovery.owner)}
        </p>
      )}
      {(actions.length > 0 || inPanel) && (
        <div
          className={inPanel ? "row panel-actions" : "row"}
          role="group"
          aria-label={TEXT.actions.label(container.name)}
        >
          {actions
            .filter((action) => !inPanel || action !== JOB_ACTION.remove)
            .map((action) => (
              <button
                key={action}
                type="button"
                className={action === JOB_ACTION.update && !inPanel ? "primary" : undefined}
                disabled={run.isPending || (action === JOB_ACTION.update && !hasUpdate(container))}
                onClick={() => ask(action)}
              >
                {inPanel && ACTION_ICONS[action] !== undefined && <Icon name={ACTION_ICONS[action]} />}
                {TEXT.actions.names[action]}
              </button>
            ))}
          {inPanel && <span className="panel-separator" aria-hidden="true" />}
          {tools}
          {inPanel && actions.includes(JOB_ACTION.remove) && (
            <button
              type="button"
              className="danger panel-remove"
              disabled={run.isPending}
              onClick={() => ask(JOB_ACTION.remove)}
            >
              <Icon name="trash" />
              {TEXT.actions.names[JOB_ACTION.remove]}
            </button>
          )}
        </div>
      )}
      {canAct && container.handsOff !== null && (
        <span className="muted small">{TEXT.actions.handsOff[container.handsOff](container.hostLabel)}</span>
      )}
      {latest !== undefined && <LatestJob job={latest} />}
      {reviewing && (
        <OperationImpactReview
          hostId={container.hostId}
          action={reviewing}
          names={[container.name]}
          onCancel={() => setReviewing(null)}
          onConfirm={(previews) => {
            run.mutate({ action: reviewing, previewId: previews[container.name] });
            setReviewing(null);
          }}
        />
      )}
      {asking.question}
      <ErrorNotice error={run.error ?? jobs.error} />
    </div>
  );
}

/** Whether an update left this container's old one aside, to roll back to. */
export const hasParked = (container: ContainerView, siblings: readonly ContainerView[]) =>
  container.recovery?.owner === container.name ||
  siblings.some((sibling) => sibling.name === `${container.name}${OLD_CONTAINER_SUFFIX}`);

// What the new version changed: its release notes where its project's host is known, else its source as it is. The
// newer image's labels say where its project is, or failing that the running image's.
function releaseNotesOf(container: ContainerView): { link: string; label: string } | null {
  const source = container.update.remote?.source ?? container.source;
  if (source === null) {
    return null;
  }
  const notes = releaseNotesLink(source, container.update.remote?.version ?? null);
  return notes === null
    ? { link: source, label: TEXT.updates.source }
    : { link: notes, label: TEXT.updates.releaseNotes };
}

/**
 * What a waiting update brings, as its images say: both versions, when the new one was built, and where to
 * read what changed. The fallback when they say none of it.
 */
export function ImageVersions({ container, fallback = null }: { container: ContainerView; fallback?: ReactNode }) {
  const versions = updateVersions(container);
  const notes = releaseNotesOf(container);
  const built = container.update.remote?.createdAt ?? null;
  if (versions === null && built === null && notes === null) {
    return fallback;
  }
  const parts = [
    versions === null ? null : <span key="versions">{TEXT.updates.versions(versions.from, versions.to)}</span>,
    built === null ? null : (
      <span key="built">
        {TEXT.updates.built} <TimeAgo timestamp={built} />
      </span>
    ),
    notes === null ? null : (
      <a key="notes" href={notes.link} target="_blank" rel="noopener noreferrer">
        {notes.label}
      </a>
    ),
  ].filter((part) => part !== null);
  return (
    <span className="small muted image-versions">
      {parts.flatMap((part, index) => (index === 0 ? [part] : [TEXT.separator, part]))}
    </span>
  );
}

// The app's own page, from its homepage.href label: one click away, in a new tab.
export function WebLink({ container }: { container: ContainerView }) {
  if (container.link === null) {
    return null;
  }
  return (
    <a
      className="small"
      href={container.link}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={TEXT.containers.openApp(container.name)}
    >
      {TEXT.updates.openLink}
    </a>
  );
}
