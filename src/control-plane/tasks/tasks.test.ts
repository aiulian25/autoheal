import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestClient, type TestControlPlane } from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import {
  API_ROUTES,
  apiPath,
  type AssignableView,
  type TaskDetailView,
  type TaskSummaryView,
} from "../../shared/api.js";

describe("tasks", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let adminId: string;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
    adminId = (await admin.get(API_ROUTES.assignees)).json<AssignableView>().users[0]!.id;
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  const create = async (payload: object) => {
    const response = await admin.post(API_ROUTES.tasks, payload);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<TaskDetailView>();
  };
  const change = (taskId: string, payload: object, client = admin) =>
    client.request({ method: "PATCH", url: apiPath(API_ROUTES.task, { taskId }), payload });
  const list = async (query = "") => (await admin.get(`${API_ROUTES.tasks}${query}`)).json<TaskSummaryView[]>();

  it("numbers new tasks, lists the open ones most urgent first, and records who did what", async () => {
    const first = await create({ title: "Renew the Pi-hole certificate", labels: ["pihole", "pihole"] });
    const second = await create({
      title: "Smoke alarm in the hallway beeps",
      priority: "urgent",
      description: "Since this morning.",
    });
    expect([first.number, second.number]).toEqual([1, 2]);
    expect(first).toMatchObject({
      status: "todo",
      priority: "medium",
      source: "manual",
      labels: ["pihole"],
      createdBy: "admin",
    });
    expect((await list()).map((task) => task.number)).toEqual([2, 1]);
    expect(first.activity.map((entry) => [entry.kind, entry.actor])).toEqual([["created", "admin"]]);
    const audit = controlPlane.stdout.join("");
    expect(audit).toContain('"action":"task.created"');
  });

  it("changes status, priority, assignee and labels, and keeps each change in the timeline", async () => {
    const task = await create({ title: "Move Paperless to the Mini" });
    const response = await change(task.id, {
      status: "in_progress",
      priority: "high",
      assignee: { kind: "user", id: adminId },
      labels: ["paperless"],
    });
    const changed = response.json<TaskDetailView>();
    expect(changed).toMatchObject({ status: "in_progress", priority: "high", labels: ["paperless"] });
    expect(changed.assignee).toEqual({ kind: "user", id: adminId, name: "admin" });
    expect(changed.activity.map((entry) => entry.kind)).toEqual([
      "created",
      "priority_changed",
      "labelled",
      "assigned",
      "status_changed",
    ]);
    const done = (await change(task.id, { status: "done" })).json<TaskDetailView>();
    expect(done.closedAt).toBe(controlPlane.clock.now);
    expect(await list()).toEqual([]);
    expect((await list("?status=closed")).map((entry) => entry.id)).toEqual([task.id]);
  });

  it("filters by assignee, priority, label and words in the title", async () => {
    await create({ title: "Mine", assignee: { kind: "user", id: adminId }, priority: "low" });
    await create({ title: "Nobody's", labels: ["zigbee"] });
    const titles = async (query: string) => (await list(query)).map((task) => task.title);
    expect(await titles("?assignee=me")).toEqual(["Mine"]);
    expect(await titles("?assignee=unassigned")).toEqual(["Nobody's"]);
    expect(await titles("?priority=low")).toEqual(["Mine"]);
    expect(await titles("?label=zigbee")).toEqual(["Nobody's"]);
    expect(await titles("?search=NOBODY")).toEqual(["Nobody's"]);
    expect(await titles("?search=%25")).toEqual([]);
    await create({ title: "Underscored", labels: ["a_b"] });
    await create({ title: "Lookalike", labels: ["axb"] });
    expect(await titles("?label=a_b")).toEqual(["Underscored"]);
    expect((await admin.get(`${API_ROUTES.tasks}?status=nonsense`)).statusCode).toBe(400);
  });

  it("nests sub-tasks, but never a task inside its own sub-task", async () => {
    const parent = await create({ title: "Zigbee network keeps dropping" });
    const child = await create({ title: "Check the coordinator's USB extension", parentId: parent.id });
    expect(
      (await admin.get(apiPath(API_ROUTES.task, { taskId: parent.id })))
        .json<TaskDetailView>()
        .subtasks.map((task) => task.id),
    ).toEqual([child.id]);
    expect((await change(parent.id, { parentId: child.id })).json()).toEqual({ error: "task_loop" });
    expect((await change(parent.id, { parentId: parent.id })).json()).toEqual({ error: "task_loop" });
  });

  it("links blockers both ways and refuses a circle", async () => {
    const first = await create({ title: "Replace the NAS disk" });
    const second = await create({ title: "Restore the photo library" });
    const blockers = apiPath(API_ROUTES.taskBlockers, { taskId: second.id });
    const blocked = (await admin.post(blockers, { blockedById: first.id })).json<TaskDetailView>();
    expect(blocked.blockedBy.map((task) => task.id)).toEqual([first.id]);
    const blocking = (await admin.get(apiPath(API_ROUTES.task, { taskId: first.id }))).json<TaskDetailView>();
    expect(blocking.blocking.map((task) => task.id)).toEqual([second.id]);
    const circle = await admin.post(apiPath(API_ROUTES.taskBlockers, { taskId: first.id }), { blockedById: second.id });
    expect(circle.json()).toEqual({ error: "task_loop" });
    const removed = await admin.request({
      method: "DELETE",
      url: apiPath(API_ROUTES.taskBlocker, { taskId: second.id, blockerId: first.id }),
    });
    expect(removed.json<TaskDetailView>().blockedBy).toEqual([]);
  });

  it("gives Autoheal only work it can do, and nobody a task who is not an active user", async () => {
    const task = await create({ title: "Tidy the cables" });
    expect((await change(task.id, { assignee: { kind: "agent", id: "autoheal" } })).json()).toEqual({
      error: "agent_cannot_take",
    });
    const stranger = await change(task.id, { assignee: { kind: "user", id: "00000000-0000-4000-8000-000000000000" } });
    expect(stranger.json()).toEqual({ error: "assignee_not_found" });
  });

  it("keeps a comment thread", async () => {
    const task = await create({ title: "Why is the Mini hot?" });
    const comments = apiPath(API_ROUTES.taskComments, { taskId: task.id });
    const detail = (await admin.post(comments, { body: "  The fan is full of dust.  " })).json<TaskDetailView>();
    expect(detail.comments.map(({ author, body, fromAgent }) => ({ author, body, fromAgent }))).toEqual([
      { author: "admin", body: "The fan is full of dust.", fromAgent: false },
    ]);
    expect((await admin.post(comments, { body: "   " })).statusCode).toBe(400);
  });

  it("lets viewers follow tasks but not change them", async () => {
    const task = await create({ title: "Read only" });
    const { client: viewer } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    expect((await viewer.get(API_ROUTES.tasks)).statusCode).toBe(200);
    expect((await viewer.get(apiPath(API_ROUTES.task, { taskId: task.id }))).statusCode).toBe(200);
    expect((await viewer.post(API_ROUTES.tasks, { title: "Nope" })).statusCode).toBe(403);
    expect((await change(task.id, { status: "done" }, viewer)).statusCode).toBe(403);
    expect((await controlPlane.client().get(API_ROUTES.tasks)).statusCode).toBe(401);
  });
});
