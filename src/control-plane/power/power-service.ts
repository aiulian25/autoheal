import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { HostPowerView, SshConnectionView } from "../../shared/api.js";
import {
  HOST_KIND,
  POWER,
  POWER_ACTIONS,
  SSH_STATE,
  SYSTEM_ACTOR_LABEL,
  type PowerAction,
} from "../../shared/constants.js";
import type { DatabaseHandle } from "../database/connection.js";
import { hosts, jobs, users } from "../database/schema.js";
import type { HostRow } from "../hosts/hosts-service.js";
import type { MetricsStore } from "../inventory/metrics-store.js";
import { bootIdOf, type JobsService } from "../jobs/jobs-service.js";
import { powerPhase, rebootProgress, type PowerProgressJob } from "./power-phase.js";

export interface PowerDependencies {
  databaseHandle: DatabaseHandle;
  metricsStore: Pick<MetricsStore, "reportedAt">;
  jobs: Pick<JobsService, "finishShutdowns">;
  // An SSH host's session, and the way to have it dialled again soon rather than after a growing pause.
  sshConnectionOf: (hostId: string) => SshConnectionView | null;
  redialSoon: (hostId: string, until: number) => void;
  clock: () => number;
}

/** Reboots and shutdowns a person asked for, followed from what each host shows: see powerPhase. */
export class PowerService {
  constructor(private readonly dependencies: PowerDependencies) {}

  /** Where the host's latest reboot or shutdown stands; null when there is nothing to follow. */
  powerOf(host: HostRow): HostPowerView | null {
    const job = this.dependencies.databaseHandle.database
      .select({ job: jobs, requestedBy: users.username })
      .from(jobs)
      .leftJoin(users, eq(users.id, jobs.requestedByUserId))
      .where(and(eq(jobs.hostId, host.id), inArray(jobs.action, [...POWER_ACTIONS])))
      .orderBy(desc(jobs.createdAt))
      .limit(1)
      .get();
    if (job === undefined) return null;
    const session = this.dependencies.sshConnectionOf(host.id);
    return powerPhase(
      {
        ...job.job,
        action: job.job.action as PowerAction,
        requestedBy: job.requestedBy ?? job.job.requestedByAgent ?? SYSTEM_ACTOR_LABEL,
      },
      {
        bootId: bootIdOf(host),
        lastSeenAt: this.lastSeenOf(host),
        docker: host.docker,
        eventStreamConnected: host.eventStreamConnected ?? false,
        connectedSince: session?.state === SSH_STATE.connected ? session.since : null,
      },
      this.dependencies.clock(),
    );
  }

  /**
   * Shutdowns whose hosts went quiet are done; SSH hosts being rebooted are dialled again every few seconds, so that
   * they are seen back as soon as they answer.
   */
  tick() {
    const { databaseHandle, jobs: jobsService, redialSoon, clock } = this.dependencies;
    const hostsById = (hostId: string) =>
      databaseHandle.database.select().from(hosts).where(eq(hosts.id, hostId)).get();
    jobsService.finishShutdowns((hostId) => {
      const host = hostsById(hostId);
      return host === undefined ? null : this.lastSeenOf(host);
    });
    // Its runner may say "rebooting" before the host goes down: it is the delivery that counts, not the job's end.
    const now = clock();
    const recent = databaseHandle.database
      .select({ hostId: jobs.hostId, deliveredAt: jobs.deliveredAt })
      .from(jobs)
      .where(and(inArray(jobs.action, [...POWER_ACTIONS]), gte(jobs.deliveredAt, now - POWER.quickRedialMilliseconds)))
      .all();
    for (const { hostId, deliveredAt } of recent) {
      if (hostsById(hostId)?.kind === HOST_KIND.ssh)
        redialSoon(hostId, (deliveredAt ?? now) + POWER.quickRedialMilliseconds);
    }
  }

  /** Whether a reboot job's host came back or refused it, for whoever is following that very job. */
  rebootProgress(
    job: Pick<typeof jobs.$inferSelect, "status" | "deliveredAt" | "deliveredBootId">,
    host: HostRow,
    now: number,
  ) {
    return rebootProgress(job as PowerProgressJob, { bootId: bootIdOf(host), lastSeenAt: this.lastSeenOf(host) }, now);
  }

  lastSeenOf(host: HostRow): number | null {
    const reported = [host.lastHeartbeatAt, this.dependencies.metricsStore.reportedAt(host.id)].filter(
      (at): at is number => at !== null,
    );
    return reported.length === 0 ? null : Math.max(...reported);
  }
}
