import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestClient, type TestControlPlane } from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import {
  API_ROUTES,
  apiPath,
  type AssignableView,
  type BoardCardView,
  type BoardView,
  type TaskDetailView,
} from "../../shared/api.js";
import {
  AGENT_AUTOHEAL,
  BOARD_DONE_WINDOW_MILLISECONDS,
  TASK_SNOOZE,
  TASK_SNOOZE_MILLISECONDS,
  type IncidentStatus,
} from "../../shared/constants.js";
import type { IncidentSubmission } from "../../shared/protocol.js";
import { hosts, incidents } from "../database/schema.js";

const submission = (containerName: string): IncidentSubmission => ({
  detectedAt: Date.UTC(2026, 9, 20, 11, 59),
  report: {
    containerName,
    image: `${containerName}:1`,
    trigger: "die",
    stateSummary: "status=exited",
    healthOutputs: [],
    knownContainers: [containerName],
    protectedContainers: [],
    logs: "error",
  },
});

const nameOf = (card: BoardCardView) => (card.kind === "incident" ? card.incident.containerName : card.task.title);

describe("the board", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let adminId: string;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
    adminId = (await admin.get(API_ROUTES.assignees)).json<AssignableView>().users[0]!.id;
    await admin.post(API_ROUTES.hosts, { label: "Alder" });
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  const host = () => controlPlane.services.databaseHandle.database.select().from(hosts).get()!;
  const incident = (containerName: string, status: IncidentStatus) =>
    controlPlane.services.incidentsService.create(host(), submission(containerName), status);
  const task = async (payload: object) => (await admin.post(API_ROUTES.tasks, payload)).json<{ id: string }>();
  const board = async (client = admin) => (await client.get(API_ROUTES.board)).json<BoardView>();
  const columns = async (client = admin) => {
    const view = await board(client);
    return {
      needsYou: view.needsYou.map(nameOf),
      autoheal: view.autoheal.map(nameOf),
      noticed: view.noticed.map(nameOf),
      done: view.done.map(nameOf),
    };
  };

  it("puts a medium anomaly review with its human owner while leaving ordinary medium observations noticed", async () => {
    const review = await task({
      title: "Review an unusual CPU trend",
      priority: "medium",
      labels: ["anomaly"],
      assignee: { kind: "user", id: adminId },
    });
    expect(review.id).toBeTruthy();
    await task({ title: "Ordinary medium observation", priority: "medium", assignee: { kind: "user", id: adminId } });
    expect(await columns()).toMatchObject({
      needsYou: ["Review an unusual CPU trend"],
      noticed: ["Ordinary medium observation"],
      autoheal: [],
    });
  });

  it("puts each problem in the column of who has it now", async () => {
    incident("tika", "awaiting_approval");
    incident("immich-ml", "deciding");
    await task({
      title: "The runner on HP stopped reporting",
      priority: "high",
      assignee: { kind: "user", id: adminId },
    });
    await task({ title: "Kitchen Temp battery at 9%", priority: "medium", assignee: { kind: "user", id: adminId } });
    await task({
      title: "Update newt on Rowan",
      priority: "low",
      labels: ["update"],
      assignee: { kind: "user", id: adminId },
    });
    controlPlane.services.tasksService.openOrJoin({
      key: "update/whoami",
      title: "Update whoami on Alder",
      description: "",
      priority: "low",
      labels: ["update"],
      hostId: host().id,
      resource: { kind: "container", id: "whoami", label: "whoami" },
      assignee: { kind: "agent", id: AGENT_AUTOHEAL },
      source: "detector",
    });
    controlPlane.services.tasksService.openOrJoin({
      key: `os-updates/${host().id}`,
      title: "OS updates on Alder: 3",
      description: "",
      priority: "low",
      labels: ["packages"],
      hostId: host().id,
      resource: { kind: "host", id: host().id, label: "Alder" },
      assignee: { kind: "user", id: adminId },
      source: "detector",
    });

    expect(await columns()).toEqual({
      needsYou: ["tika", "The runner on HP stopped reporting", "Update newt on Rowan", "OS updates on Alder: 3"],
      autoheal: ["immich-ml", "Update whoami on Alder"],
      noticed: ["Kitchen Temp battery at 9%"],
      done: [],
    });
  });

  it("shows an incident's own task once: as the incident while it is on, as the task after", async () => {
    const tika = incident("tika", "awaiting_approval");
    expect((await columns()).noticed).toEqual([]);
    controlPlane.services.incidentsService.update(tika.id, { status: "resolved" });
    const view = await columns();
    expect(view.done).toEqual(["tika"]);
    expect(view.noticed).toEqual(["tika stopped on Alder"]);
  });

  it("keeps what was settled for a day, newest first", async () => {
    const old = incident("vaultwarden", "resolved");
    const dayAndAMomentAgo = controlPlane.clock.now - BOARD_DONE_WINDOW_MILLISECONDS - 1;
    const database = controlPlane.services.databaseHandle.database;
    database.update(incidents).set({ updatedAt: dayAndAMomentAgo }).where(eq(incidents.id, old.id)).run();
    incident("paperless", "resolved");
    const cables = await task({ title: "Tidy the cables", priority: "low" });
    controlPlane.clock.now += 1_000;
    await admin.request({
      method: "PATCH",
      url: apiPath(API_ROUTES.task, { taskId: cables.id }),
      payload: { status: "done" },
    });
    expect((await columns()).done).toEqual(["Tidy the cables", "paperless"]);
  });

  it("leaves someone else's pressing task with them", async () => {
    const { client: partner, userId: partnerId } = await fullySignedInUser(controlPlane, admin, "partner", "admin");
    await task({ title: "Replace the NAS disk", priority: "urgent", assignee: { kind: "user", id: partnerId } });
    expect((await columns()).needsYou).toEqual([]);
    expect((await columns()).noticed).toEqual(["Replace the NAS disk"]);
    expect((await columns(partner)).needsYou).toEqual(["Replace the NAS disk"]);
  });

  it("puts off a task its person snoozes for a day: noticed until then, then theirs again", async () => {
    const dayLater = TASK_SNOOZE_MILLISECONDS[TASK_SNOOZE.day];
    const { id } = await task({
      title: "/mnt/storage/disk1 is 99% full",
      priority: "high",
      assignee: { kind: "user", id: adminId },
    });
    expect((await columns()).needsYou).toEqual(["/mnt/storage/disk1 is 99% full"]);

    const snoozed = await admin.request({
      method: "PATCH",
      url: apiPath(API_ROUTES.task, { taskId: id }),
      payload: { snoozed: TASK_SNOOZE.day },
    });
    expect(snoozed.json<TaskDetailView>().snoozedUntil).toBe(controlPlane.clock.now + dayLater);
    expect(await columns()).toMatchObject({ needsYou: [], noticed: ["/mnt/storage/disk1 is 99% full"] });

    // A day later the admin's session has long expired: read what the page would show directly.
    controlPlane.clock.now += dayLater + 1;
    expect(controlPlane.services.boardService.board(adminId).needsYou.map(nameOf)).toEqual([
      "/mnt/storage/disk1 is 99% full",
    ]);
    const view = controlPlane.services.tasksService.detail(id);
    expect(view.snoozedUntil).toBeNull();
    expect(view.activity.map((entry) => entry.kind)).toContain("snoozed");
  });

  it("snoozes a task for months and refuses a length not on offer", async () => {
    const { id } = await task({ title: "/mnt/storage/disk2 is 96% full", priority: "high" });
    const url = apiPath(API_ROUTES.task, { taskId: id });
    const months = await admin.request({ method: "PATCH", url, payload: { snoozed: TASK_SNOOZE.sixMonths } });
    expect(months.json<TaskDetailView>().snoozedUntil).toBe(
      controlPlane.clock.now + TASK_SNOOZE_MILLISECONDS[TASK_SNOOZE.sixMonths],
    );
    const refused = await admin.request({ method: "PATCH", url, payload: { snoozed: "forever" } });
    expect(refused.statusCode).toBe(400);

    controlPlane.clock.now += TASK_SNOOZE_MILLISECONDS[TASK_SNOOZE.threeMonths];
    expect(controlPlane.services.tasksService.detail(id).snoozedUntil).not.toBeNull();
  });
});
