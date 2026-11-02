import { and, eq, ne } from "drizzle-orm";
import { TIMELINE_ENTRY, type ContainerTimelineEntry } from "../../shared/api.js";
import { CONTAINER_TIMELINE_ENTRIES, JOB_ACTION } from "../../shared/constants.js";
import type { DatabaseHandle } from "../database/connection.js";
import { jobs } from "../database/schema.js";
import type { IncidentsService } from "../incidents/incidents-service.js";
import { jobViews } from "../jobs/job-views.js";
import type { DeliveryService } from "../notifications/delivery-service.js";
import type { TasksService } from "../tasks/tasks-service.js";
import type { InventoryService } from "./inventory-service.js";

/**
 * One container's story, newest first, from the lists that each keep a part of it: its incidents, the jobs asked
 * of it, what its host's reports saw change (its host's own changes too), the steps on its tasks, and the alerts
 * about either. Reading its logs changes nothing, so those jobs stay out.
 */
export class ContainerTimeline {
  constructor(
    private readonly databaseHandle: DatabaseHandle,
    private readonly incidents: Pick<IncidentsService, "list">,
    private readonly inventory: Pick<InventoryService, "recentChanges">,
    private readonly tasks: Pick<TasksService, "containerActivity">,
    private readonly deliveries: Pick<DeliveryService, "aboutContainer">,
  ) {}

  of(hostId: string, containerName: string): ContainerTimelineEntry[] {
    const limit = CONTAINER_TIMELINE_ENTRIES;
    const asked = and(eq(jobs.hostId, hostId), eq(jobs.containerName, containerName), ne(jobs.action, JOB_ACTION.logs));
    // Each part brings its own newest `limit`, so the newest `limit` of them all are among these.
    const entries: ContainerTimelineEntry[] = [
      ...this.incidents
        .list({ hostId, containerName, limit }, limit)
        .map((incident) => ({ kind: TIMELINE_ENTRY.incident, at: incident.detectedAt, incident })),
      ...jobViews(this.databaseHandle, asked, limit).map((job) => ({
        kind: TIMELINE_ENTRY.job,
        at: job.completedAt ?? job.createdAt,
        job,
      })),
      ...this.inventory
        .recentChanges(hostId, new Set([containerName]), 0, limit)
        .map((change) => ({ kind: TIMELINE_ENTRY.change, at: change.at, change })),
      ...this.tasks
        .containerActivity(hostId, containerName, limit)
        .map(({ task, activity }) => ({ kind: TIMELINE_ENTRY.task, at: activity.createdAt, task, activity })),
      ...this.deliveries
        .aboutContainer(hostId, containerName, limit)
        .map((notification) => ({ kind: TIMELINE_ENTRY.notification, at: notification.createdAt, notification })),
    ];
    return entries.sort((first, second) => second.at - first.at).slice(0, limit);
  }
}
