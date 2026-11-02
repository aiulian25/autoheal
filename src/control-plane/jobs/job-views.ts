import { desc, eq, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { JobView } from "../../shared/api.js";
import { AGENT_NAMES, FORMER_USER_LABEL, HOST_PACKAGE_LIMIT } from "../../shared/constants.js";
import { packageNameSchema } from "../../shared/protocol.js";
import type { DatabaseHandle } from "../database/connection.js";
import { hosts, jobs, users } from "../database/schema.js";

export type JobRow = typeof jobs.$inferSelect;

const storedPackages = z.array(packageNameSchema).max(HOST_PACKAGE_LIMIT);

/** The packages a job names, as stored with it; none for a job that names none. */
export const packagesOf = (json: string | null): string[] =>
  json === null ? [] : (storedPackages.safeParse(JSON.parse(json)).data ?? []);

/** Jobs as the dashboard shows them, newest first; shared by the jobs and the tasks they belong to. */
export function jobViews(databaseHandle: DatabaseHandle, condition: SQL | undefined, limit: number): JobView[] {
  return databaseHandle.database
    .select({ job: jobs, hostLabel: hosts.label, username: users.username })
    .from(jobs)
    .innerJoin(hosts, eq(hosts.id, jobs.hostId))
    .leftJoin(users, eq(users.id, jobs.requestedByUserId))
    .where(condition)
    .orderBy(desc(jobs.createdAt))
    .limit(limit)
    .all()
    .map(({ job, hostLabel, username }) => ({
      id: job.id,
      hostId: job.hostId,
      hostLabel,
      containerName: job.containerName,
      action: job.action,
      status: job.status,
      requestedBy: job.requestedByAgent === null ? (username ?? FORMER_USER_LABEL) : AGENT_NAMES[job.requestedByAgent],
      taskId: job.taskId,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      outcome: job.outcome,
      output: job.output,
      packages: packagesOf(job.packagesJson),
      recoveryBackupId: job.recoveryBackupId,
      // Kept in memory while it runs: the jobs service adds it.
      progress: null,
    }));
}
