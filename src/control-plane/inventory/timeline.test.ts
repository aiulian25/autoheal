import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestClient, type TestControlPlane } from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import {
  API_ROUTES,
  apiPath,
  TIMELINE_ENTRY,
  type ContainerTimelineEntry,
  type EnrolledHostView,
} from "../../shared/api.js";
import {
  ACTION_RESTART,
  AGENT_AUTOHEAL,
  CONTAINER_TIMELINE_ENTRIES,
  DECIDED_BY,
  HOST_CHANGE,
  HTTP_STATUS,
  INCIDENT_STATUS,
  JOB_ACTION,
  JOB_STATUS,
  ROLE_VIEWER,
  TASK_ACTIVITY,
  TASK_PRIORITY,
  TASK_RESOURCE,
  TASK_SOURCE,
  TASK_STATUS,
  TRIGGER_DIE,
  VERDICT_FIXED,
} from "../../shared/constants.js";
import { DELIVERY_RESOURCE } from "../../shared/notification-deliveries.js";

const MINUTE = 60_000;

describe("a container's timeline", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let hostId: string;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
    hostId = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>().host.id;
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  // Each record as its own list keeps it, at so many minutes after the start.
  const seed = () => {
    const run = (sql: string, ...values: unknown[]) =>
      controlPlane.services.databaseHandle.sqlite.prepare(sql).run(...values);
    const at = (minutes: number) => minutes * MINUTE;
    let tasks = 0;
    return {
      incident: (id: string, container: string, minutes: number) =>
        run(
          "INSERT INTO incidents (id, host_id, container_name, image, trigger_event, detected_at, status, decided_by, action, target, verdict, created_at, updated_at) VALUES (?, ?, ?, 'nginx', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          id,
          hostId,
          container,
          TRIGGER_DIE,
          at(minutes),
          INCIDENT_STATUS.resolved,
          DECIDED_BY.model,
          ACTION_RESTART,
          container,
          VERDICT_FIXED,
          at(minutes),
          at(minutes),
        ),
      job: (id: string, container: string, action: string, minutes: number, taskId: string | null = null) =>
        run(
          "INSERT INTO jobs (id, host_id, task_id, container_name, action, requested_by_agent, status, created_at, expires_at, completed_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Done.')",
          id,
          hostId,
          taskId,
          container,
          action,
          AGENT_AUTOHEAL,
          JOB_STATUS.succeeded,
          at(minutes) - MINUTE,
          at(minutes) + MINUTE,
          at(minutes),
        ),
      change: (container: string | null, kind: string, minutes: number) =>
        run(
          "INSERT INTO host_changes (host_id, at, kind, container_name, details_json) VALUES (?, ?, ?, ?, '{}')",
          hostId,
          at(minutes),
          kind,
          container,
        ),
      task: (id: string, container: string, minutes: number) => {
        tasks += 1;
        run(
          "INSERT INTO tasks (id, number, title, status, priority, source, host_id, resource_kind, resource_id, resource_label, created_at, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          id,
          tasks,
          `Look at ${container}`,
          TASK_STATUS.todo,
          TASK_PRIORITY.medium,
          TASK_SOURCE.detector,
          hostId,
          TASK_RESOURCE.container,
          container,
          container,
          at(minutes),
          at(minutes),
          at(minutes),
        );
        run(
          "INSERT INTO task_activity (task_id, kind, actor_label, created_at) VALUES (?, ?, 'Autoheal', ?)",
          id,
          TASK_ACTIVITY.created,
          at(minutes),
        );
      },
      notification: (id: string, resourceKind: string, resourceId: string, minutes: number) => {
        run(
          "INSERT INTO notification_events (id, dedupe_key, kind, host_id, resource_kind, resource_id, priority, message_json, created_at) VALUES (?, ?, 'incident_handled', ?, ?, ?, ?, '{}', ?)",
          id,
          id,
          hostId,
          resourceKind,
          resourceId,
          TASK_PRIORITY.high,
          at(minutes),
        );
        run(
          "INSERT INTO notification_deliveries (id, event_id, channel, status, attempts, accepted_at) VALUES (?, ?, 'gotify', 'accepted', 1, ?)",
          `delivery-${id}`,
          id,
          at(minutes),
        );
      },
    };
  };

  const timelineOf = (client: TestClient, containerName: string) =>
    client.get(apiPath(API_ROUTES.containerTimeline, { hostId, containerName }));
  // What an entry is about, by its own list's id: the order of these is the story.
  const named = (entry: ContainerTimelineEntry) => {
    if (entry.kind === TIMELINE_ENTRY.incident) return `incident ${entry.incident.id}`;
    if (entry.kind === TIMELINE_ENTRY.job) return `job ${entry.job.id}`;
    if (entry.kind === TIMELINE_ENTRY.change) return `change ${entry.change.kind} ${entry.change.containerName}`;
    if (entry.kind === TIMELINE_ENTRY.task) return `task ${entry.task.id} ${entry.activity.kind}`;
    return `notification ${entry.notification.id}`;
  };

  it("tells one container's story newest first, from every list that keeps a part of it", async () => {
    const records = seed();
    records.incident("crash", "paperless", 1);
    records.change("paperless", HOST_CHANGE.stopped, 1);
    records.notification("crash-alert", DELIVERY_RESOURCE.incident, "crash", 2);
    records.task("look", "paperless", 3);
    records.job("stop", "paperless", JOB_ACTION.stop, 4, "look");
    // Reading its logs changes nothing: not part of its story.
    records.job("logs", "paperless", JOB_ACTION.logs, 5);
    records.change(null, HOST_CHANGE.rebooted, 6);
    records.notification("look-alert", DELIVERY_RESOURCE.task, "look", 7);
    // Another container's, on the same host: none of it shows.
    records.incident("other-crash", "redis", 8);
    records.change("redis", HOST_CHANGE.stopped, 8);
    records.task("other-look", "redis", 8);
    records.job("other-stop", "redis", JOB_ACTION.stop, 8);
    records.notification("other-alert", DELIVERY_RESOURCE.incident, "other-crash", 8);

    const response = await timelineOf(admin, "paperless");
    expect(response.statusCode).toBe(HTTP_STATUS.ok);
    const entries = response.json<ContainerTimelineEntry[]>();
    expect(entries.map(named)).toEqual([
      "notification look-alert",
      "change rebooted null",
      "job stop",
      "task look created",
      "notification crash-alert",
      "incident crash",
      "change stopped paperless",
    ]);
    // Each carries what its own list shows, with what leads to it.
    expect(entries.map((entry) => entry.at)).toEqual([7, 6, 4, 3, 2, 1, 1].map((minutes) => minutes * MINUTE));
    expect(entries[0]).toMatchObject({ notification: { resourceKind: DELIVERY_RESOURCE.task, resourceId: "look" } });
    expect(entries[0]).toMatchObject({ notification: { deliveries: [{ channel: "gotify", status: "accepted" }] } });
    expect(entries[2]).toMatchObject({ job: { action: JOB_ACTION.stop, taskId: "look", requestedBy: "Autoheal" } });
    expect(entries[3]).toMatchObject({ task: { id: "look", number: 1, title: "Look at paperless" } });
    expect(entries[5]).toMatchObject({
      incident: { trigger: TRIGGER_DIE, action: ACTION_RESTART, verdict: VERDICT_FIXED },
    });
  });

  it("keeps the newest 200 of them all, however far one list outnumbers the others", async () => {
    const records = seed();
    const incidents = 150;
    const changes = 60;
    for (let minute = 1; minute <= incidents; minute += 1) records.incident(`crash-${minute}`, "paperless", minute);
    for (let minute = incidents + 1; minute <= incidents + changes; minute += 1)
      records.change("paperless", HOST_CHANGE.restarted, minute);

    const entries = (await timelineOf(admin, "paperless")).json<ContainerTimelineEntry[]>();
    expect(entries).toHaveLength(CONTAINER_TIMELINE_ENTRIES);
    expect(entries.slice(0, changes).every((entry) => entry.kind === TIMELINE_ENTRY.change)).toBe(true);
    // The 140 newest incidents follow, down to the one at minute 11: the ten oldest are past the end.
    expect(named(entries[changes]!)).toBe(`incident crash-${incidents}`);
    expect(named(entries.at(-1)!)).toBe(`incident crash-${incidents + changes - CONTAINER_TIMELINE_ENTRIES + 1}`);
  });

  it("is there for anyone fully signed in, and refuses an address that names no host", async () => {
    seed().incident("crash", "paperless", 1);
    const viewer = (await fullySignedInUser(controlPlane, admin, "viewer", ROLE_VIEWER)).client;
    expect((await timelineOf(viewer, "paperless")).json<ContainerTimelineEntry[]>()).toHaveLength(1);
    expect((await timelineOf(admin, "nothing-here")).json<ContainerTimelineEntry[]>()).toEqual([]);

    expect((await timelineOf(controlPlane.client(), "paperless")).statusCode).toBe(HTTP_STATUS.unauthorized);
    const notAHost = apiPath(API_ROUTES.containerTimeline, { hostId: "alder", containerName: "paperless" });
    expect((await admin.get(notAHost)).statusCode).toBe(HTTP_STATUS.badRequest);
  });
});
