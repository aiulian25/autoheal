import type { HostPowerView } from "../../shared/api.js";
import {
  HOST_PACKAGE_ANSWER_MILLISECONDS,
  JOB_ACTION,
  JOB_STATUS,
  POWER,
  POWER_PHASE,
  type JobStatus,
  type PowerAction,
  type PowerPhase,
} from "../../shared/constants.js";

export interface PowerJob {
  id: string;
  action: PowerAction;
  status: JobStatus;
  requestedBy: string;
  createdAt: number;
  deliveredAt: number | null;
  completedAt: number | null;
  outcome: string | null;
  // The host's boot when the job was delivered: a different one means it went down and came back.
  deliveredBootId: string | null;
}

export interface PowerHost {
  bootId: string | null;
  // Its last report or its live stats, whichever came last.
  lastSeenAt: number | null;
  docker: boolean;
  eventStreamConnected: boolean;
  // An SSH host's session, when it is connected: since when. Null otherwise, and for other hosts.
  connectedSince: number | null;
}

const ENDED: readonly JobStatus[] = [JOB_STATUS.failed, JOB_STATUS.expired];

export type PowerProgressJob = Pick<PowerJob, "status" | "deliveredAt" | "deliveredBootId">;

/** What a host shows of a reboot asked of it: a new boot means it came back; refused means it never went. */
export function rebootProgress(job: PowerProgressJob, host: Pick<PowerHost, "bootId" | "lastSeenAt">, now: number) {
  const cameBack = job.deliveredBootId !== null && host.bootId !== null && host.bootId !== job.deliveredBootId;
  const heard = host.lastSeenAt !== null && now - host.lastSeenAt < POWER.silentAfterMilliseconds;
  // Refused, or never taken: the host is still up and said why, or never got it.
  const refused = ENDED.includes(job.status) && !cameBack && (heard || job.deliveredAt === null);
  return { cameBack, heard, refused };
}

/**
 * Where a reboot or a shutdown stands, from what the host shows rather than from what its runner could say: a new
 * boot is a reboot done (or a shutdown's host powered on again), a host gone quiet has gone down. Null once there is
 * nothing to follow: back and settled for a while, powered on again, or a refusal already shown.
 */
export function powerPhase(job: PowerJob, host: PowerHost, now: number): HostPowerView | null {
  const view = (phase: PowerPhase, finishedAt: number | null = job.completedAt): HostPowerView => ({
    action: job.action,
    jobId: job.id,
    phase,
    requestedAt: job.createdAt,
    requestedBy: job.requestedBy,
    lastSeenAt: host.lastSeenAt,
    finishedAt,
    outcome: phase === POWER_PHASE.failed ? job.outcome : null,
  });
  const recently = (at: number | null) => at !== null && now - at < POWER.shownMilliseconds;
  if (job.status === JOB_STATUS.pending) return view(POWER_PHASE.asked);
  const askedAt = job.deliveredAt ?? job.createdAt;
  const { cameBack, heard, refused } = rebootProgress(job, host, now);
  if (refused) return recently(job.completedAt) ? view(POWER_PHASE.failed) : null;
  if (job.action === JOB_ACTION.shutdown) {
    if (cameBack) return null;
    return heard ? view(POWER_PHASE.goingDown) : view(POWER_PHASE.off, job.completedAt ?? host.lastSeenAt);
  }
  if (cameBack) {
    const settled = !host.docker || host.eventStreamConnected;
    if (!settled) return view(POWER_PHASE.starting, null);
    const backAt = job.completedAt ?? host.lastSeenAt;
    return recently(backAt) ? view(POWER_PHASE.ready, backAt) : null;
  }
  // Its session answers again: it is up, its first report on the new boot yet to come.
  const answering = host.connectedSince !== null && host.connectedSince > askedAt;
  if (answering) return view(POWER_PHASE.starting, null);
  if (now - askedAt > HOST_PACKAGE_ANSWER_MILLISECONDS) return null;
  return heard ? view(POWER_PHASE.goingDown) : view(POWER_PHASE.offline);
}
