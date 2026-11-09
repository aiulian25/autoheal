import { OperationImpactReview } from "./components/dependency-map.js";
import type { PreviewAction } from "../../src/shared/topology.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createElement, useEffect, useState } from "react";
import {
  API_ROUTES,
  apiPath,
  hasUpdate,
  type ContainerView,
  type HostVolumesView,
  type JobView,
} from "../../src/shared/api.js";
import {
  CONTAINER_STATE_PAUSED,
  CONTAINER_STATE_RESTARTING,
  CONTAINER_STATE_RUNNING,
  JOB_ACTION,
  JOB_STATUS,
} from "../../src/shared/constants.js";
import { api } from "./api-client.js";
import { isWaiting } from "./components/container-actions.js";
import { BULK_REFRESH_MILLISECONDS } from "./constants.js";
import { hostJobsQuery } from "./queries.js";

/** What the ticked containers can be asked at once, in the order the bar offers it. */
export const BULK_ACTIONS = [
  JOB_ACTION.restart,
  JOB_ACTION.start,
  JOB_ACTION.stop,
  JOB_ACTION.pause,
  JOB_ACTION.unpause,
  JOB_ACTION.update,
  JOB_ACTION.checkUpdates,
  JOB_ACTION.remove,
] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];
// What one row can ask besides: its recent logs, which only read.
export type RowAction = BulkAction | typeof JOB_ACTION.logs | typeof JOB_ACTION.rollBack;

const isRunning = (container: ContainerView) => container.state === CONTAINER_STATE_RUNNING;
const isPaused = (container: ContainerView) => container.state === CONTAINER_STATE_PAUSED;
// Neither running nor between the two (paused, restarting): what starting is for.
export const isStopped = (container: ContainerView) =>
  !isRunning(container) && container.state !== CONTAINER_STATE_PAUSED && container.state !== CONTAINER_STATE_RESTARTING;

const FITS: Record<BulkAction, (container: ContainerView) => boolean> = {
  [JOB_ACTION.restart]: isRunning,
  [JOB_ACTION.start]: isStopped,
  [JOB_ACTION.stop]: isRunning,
  [JOB_ACTION.pause]: isRunning,
  [JOB_ACTION.unpause]: isPaused,
  [JOB_ACTION.update]: hasUpdate,
  // The host's check covers every image on it, the ticked ones among them.
  [JOB_ACTION.checkUpdates]: () => true,
  // A running one is stopped first.
  [JOB_ACTION.remove]: () => true,
};

/** The ticked containers an action reaches: those the host lets Autoheal change, and of those the ones it fits. */
export const targetsOf = (action: BulkAction, ticked: readonly ContainerView[]) =>
  ticked.filter(
    (container) => container.handsOff === null && container.recovery === undefined && FITS[action](container),
  );

/** How the jobs one bulk action asked for are going, from the host's latest jobs. */
export function progressOf(jobIds: readonly string[], jobs: readonly JobView[]) {
  const ended = jobs.filter((job) => jobIds.includes(job.id) && !isWaiting(job));
  const failed = ended.filter((job) => job.status !== JOB_STATUS.succeeded);
  return { waiting: jobIds.length - ended.length, succeeded: ended.length - failed.length, failed };
}

/** One bulk action asked: the jobs it made, how many containers it was for, and why any could not be asked. */
export interface BulkAsked {
  // The Compose projects those containers belonged to, for what removing them leaves behind.
  projects: readonly string[];
  // The volumes those containers used: Docker keeps them, nameless ones too.
  volumes: readonly string[];
  action: RowAction;
  jobIds: string[];
  total: number;
  refusal: unknown;
}

async function askHost(
  hostId: string,
  action: RowAction,
  targets: readonly ContainerView[],
  previews?: Readonly<Record<string, string>>,
) {
  const names = targets.map((container) => container.name);
  if (action === JOB_ACTION.update) {
    // An update run: one at a time, and the first that does not come back healthy stops it.
    await api("POST", apiPath(API_ROUTES.containerUpdates, { hostId }), { names, ...(previews ? { previews } : {}) });
    return { jobIds: [], refusal: null };
  }
  if (action === JOB_ACTION.checkUpdates) {
    const job = await api<JobView>("POST", apiPath(API_ROUTES.hostActions, { hostId }), { action });
    return { jobIds: [job.id], refusal: null };
  }
  const answers = await Promise.allSettled(
    names.map((containerName) =>
      api<JobView>("POST", apiPath(API_ROUTES.containerActions, { hostId, containerName }), {
        action,
        ...(previews?.[containerName] ? { previewId: previews[containerName] } : {}),
      }),
    ),
  );
  const refused = answers.find((answer) => answer.status === "rejected");
  return {
    jobIds: answers.flatMap((answer) => (answer.status === "fulfilled" ? [answer.value.id] : [])),
    refusal: refused === undefined ? null : refused.reason,
  };
}

/**
 * Asks a host's runner to act on the ticked containers, each as its own job, which the runner takes within
 * a second and runs three at a time; follows them every second, and has the rows read again once all ended.
 */
export function useBulkAction(hostId: string, onAsked: () => void = () => undefined) {
  const queryClient = useQueryClient();
  const [asked, setAsked] = useState<BulkAsked | null>(null);
  const [reviewing, setReviewing] = useState<{
    action: Extract<PreviewAction, RowAction>;
    targets: readonly ContainerView[];
  } | null>(null);
  const jobIds = asked?.jobIds ?? [];
  const jobs = useQuery({
    ...hostJobsQuery(hostId),
    enabled: jobIds.length > 0,
    refetchInterval: (query) =>
      progressOf(jobIds, query.state.data ?? []).waiting > 0 ? BULK_REFRESH_MILLISECONDS : false,
  });
  const progress = progressOf(jobIds, jobs.data ?? []);
  const ended = jobIds.length > 0 && progress.waiting === 0;
  useEffect(() => {
    if (ended) {
      void queryClient.invalidateQueries({ queryKey: ["containers"] });
    }
  }, [ended, queryClient]);
  const run = useMutation({
    mutationFn: ({
      action,
      targets,
      previews,
    }: {
      action: RowAction;
      targets: readonly ContainerView[];
      previews?: Readonly<Record<string, string>>;
    }) => askHost(hostId, action, targets, previews),
    onSuccess: (answer, { action, targets }) => {
      const projects = targets.flatMap(({ composeProject }) => (composeProject === null ? [] : [composeProject]));
      const removing = new Set(targets.map(({ name }) => name));
      const volumes = (queryClient.getQueryData<HostVolumesView>(["host-volumes", hostId])?.volumes ?? [])
        .filter(({ members }) => members.some(({ name }) => removing.has(name)))
        .map(({ name }) => name);
      setAsked({ action, total: targets.length, projects, volumes, ...answer });
      onAsked();
      void queryClient.invalidateQueries({ queryKey: ["jobs", hostId] });
    },
  });
  const review = (action: Extract<PreviewAction, RowAction>, targets: readonly ContainerView[]) =>
    setReviewing({ action, targets });
  const impact = reviewing
    ? createElement(OperationImpactReview, {
        key: JSON.stringify([reviewing.action, reviewing.targets.map((item) => item.name)]),
        hostId,
        action: reviewing.action,
        names: reviewing.targets.map((item) => item.name),
        onCancel: () => setReviewing(null),
        onConfirm: (previews: Record<string, string>) => {
          run.mutate({ ...reviewing, previews });
          setReviewing(null);
        },
      })
    : null;
  return { run, asked, progress, review, impact };
}
