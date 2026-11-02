import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
  runnerTokenOf,
} from "../../../test/support/control-plane.js";
import { containerSnapshot, heartbeatWith, hostHealth } from "../../../test/support/inventory.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import {
  API_ROUTES,
  JOB_QUERY,
  apiPath,
  type EnrolledHostView,
  type JobView,
  type TaskDetailView,
  type TaskSummaryView,
} from "../../shared/api.js";
import {
  BYTES_PER_GIBIBYTE,
  HEARTBEAT_INTERVAL_MILLISECONDS,
  JOB_ANSWER_MILLISECONDS,
  JOB_EXPIRY_MILLISECONDS,
} from "../../shared/constants.js";
import {
  RUNNER_ROUTES,
  type ContainerSnapshot,
  type Heartbeat,
  type UpdateProgress,
  type WorkResponse,
} from "../../shared/protocol.js";
import { AutohealWorker } from "../tasks/autoheal-worker.js";
import type { LiveEvent } from "../live/live-events.js";
import type { Assessment } from "../tasks/update-assessor.js";

const update = { status: "available" as const, checkedAt: 1, remoteDigest: `sha256:${"c".repeat(64)}` };

describe("container actions", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let token: string;
  let hostId: string;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    token = runnerTokenOf(enrolled);
    hostId = enrolled.host.id;
    await report([
      containerSnapshot({ name: "paperless" }),
      containerSnapshot({ name: "whoami", update, updatePolicy: "auto" }),
      containerSnapshot({ name: "postgres", update, updatePolicy: "off" }),
    ]);
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  // A live host: one in dry-run lets nothing be changed from here.
  async function report(containers: ContainerSnapshot[], hostRules: Partial<Heartbeat> = {}) {
    const response = await controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      payload: heartbeatWith({ containers, dryRun: false, ...hostRules }),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
  }
  const ask = (containerName: string, payload: object, client = admin) =>
    client.post(apiPath(API_ROUTES.containerActions, { hostId, containerName }), payload);
  const takeWork = async () =>
    (
      await controlPlane.runnerApp.inject({
        method: "GET",
        url: RUNNER_ROUTES.work,
        headers: { authorization: `Bearer ${token}` },
      })
    ).json<WorkResponse>();
  const answer = (jobId: string, result: object) =>
    controlPlane.runnerApp.inject({
      method: "POST",
      url: apiPath(RUNNER_ROUTES.jobResult, { jobId }),
      payload: result,
      headers: { authorization: `Bearer ${token}` },
    });
  const detail = async (taskId: string) =>
    (await admin.get(apiPath(API_ROUTES.task, { taskId }))).json<TaskDetailView>();
  const openTasks = async () => (await admin.get(API_ROUTES.tasks)).json<TaskSummaryView[]>();

  it("grants no-checkpoint permission only to an update explicitly requested by an admin", async () => {
    expect((await ask("whoami", { action: "update" })).statusCode).toBe(200);
    const [work] = (await takeWork()).jobs;
    expect(work).toMatchObject({ action: "update", allowWithoutCheckpoint: true });
  });

  it("delivers an action to the host's runner once, and records what it did", async () => {
    const asked = await ask("paperless", { action: "restart" });
    expect(asked.statusCode, asked.body).toBe(200);
    const job = asked.json<JobView>();
    expect(job).toMatchObject({
      action: "restart",
      status: "pending",
      requestedBy: "admin",
      containerName: "paperless",
    });
    expect((await ask("paperless", { action: "restart" })).json<JobView>().id).toBe(job.id);

    const work = await takeWork();
    expect(work.jobs).toEqual([
      {
        id: job.id,
        containerName: "paperless",
        action: "restart",
        requestedBy: "admin",
        expiresAt: expect.any(Number),
      },
    ]);
    expect((await takeWork()).jobs).toEqual([]);

    const answered = await answer(job.id, { succeeded: true, outcome: "Restarted paperless.", output: null });
    expect(answered.statusCode).toBe(204);
    const [listed] = (await admin.get(`${API_ROUTES.jobs}?hostId=${hostId}&containerName=paperless`)).json<JobView[]>();
    expect(listed).toMatchObject({ id: job.id, status: "succeeded", outcome: "Restarted paperless." });
    expect((await answer(job.id, { succeeded: true, outcome: "Restarted paperless.", output: null })).statusCode).toBe(
      204,
    );
    expect((await answer(job.id, { succeeded: true, outcome: "again", output: null })).statusCode).toBe(409);
    expect(controlPlane.stdout.join("")).toContain('"action":"container.action_requested"');
  });

  describe("the copy a restore can go back to", () => {
    const COPY = "20261102T000000Z";
    const viewOf = async (jobId: string) => (await admin.get(apiPath(API_ROUTES.job, { jobId }))).json<JobView>();
    const restoreJob = () => {
      const job = controlPlane.services.jobsService.request(
        { kind: "user", actor: { userId: adminId(), username: "admin", ip: "127.0.0.1", requestId: "r" } },
        hostId,
        "paperless",
        "restore_container",
        null,
        {
          backup: {
            target: { container: "paperless", stack: null },
            directory: "/backups",
            key: "k".repeat(40),
            id: COPY,
          },
        } as never,
      );
      return job.id;
    };
    const adminId = () =>
      (controlPlane.services.databaseHandle.sqlite.prepare("SELECT id FROM users").get() as { id: string }).id;

    it("is kept with the restore's result, so it survives a reload", async () => {
      const jobId = restoreJob();
      await takeWork();
      const answered = await answer(jobId, {
        succeeded: true,
        outcome: "Restored.",
        output: null,
        recoveryBackupId: COPY,
      });
      expect(answered.statusCode).toBe(204);
      expect(await viewOf(jobId)).toMatchObject({ status: "succeeded", recoveryBackupId: COPY });
    });

    it("is none for a runner that does not say, or for anything but a restore", async () => {
      const jobId = restoreJob();
      await takeWork();
      await answer(jobId, { succeeded: true, outcome: "Restored.", output: null });
      expect(await viewOf(jobId)).toMatchObject({ recoveryBackupId: null });

      const other = (await ask("paperless", { action: "restart" })).json<JobView>();
      await takeWork();
      await answer(other.id, { succeeded: true, outcome: "Restarted.", output: null, recoveryBackupId: COPY });
      expect(await viewOf(other.id)).toMatchObject({ recoveryBackupId: null });
    });

    it("refuses what is not a backup's name", async () => {
      const jobId = restoreJob();
      await takeWork();
      const answered = await answer(jobId, {
        succeeded: true,
        outcome: "x",
        output: null,
        recoveryBackupId: "../other",
      });
      expect(answered.statusCode).toBe(400);
    });
  });

  it("keeps partial-stop recovery details in failed job history", async () => {
    const requested = (await ask("whoami", { action: "update" })).json<JobView>();
    await takeWork();
    const output = JSON.stringify({
      phase: "dependent-stop-failed",
      provider: { name: "whoami", id: "provider-id", changed: false },
      originallyRunning: [{ name: "client", id: "client-id" }],
      stopped: [{ name: "client", id: "client-id" }],
      restarted: [],
      restartFailures: [{ name: "client", id: "client-id", error: "synthetic failure" }],
    });
    expect(
      (
        await answer(requested.id, {
          succeeded: false,
          outcome: "Could not update whoami: stopping second failed. Could not restart client.",
          output,
        })
      ).statusCode,
    ).toBe(204);
    const history = (await admin.get(`${API_ROUTES.jobs}?hostId=${hostId}&containerName=whoami`)).json<JobView[]>();
    expect(history.find(({ id }) => id === requested.id)).toMatchObject({ status: "failed", output });
  });

  it("shows an update's progress on its job while it runs, and tells the dashboards each move", async () => {
    const heard: LiveEvent[] = [];
    controlPlane.services.live.subscribe((event) => heard.push(event));
    const job = (await ask("whoami", { action: "update" })).json<JobView>();
    await takeWork();
    const progress: UpdateProgress = {
      phase: "pulling",
      layers: [{ id: "4f4fb700ef54", state: "downloading", current: 512, total: 1024 }],
      downloaded: 512,
      total: 1024,
      bytesPerSecond: 256,
      log: ["4f4fb700ef54: Downloading"],
    };
    const sent = await controlPlane.runnerApp.inject({
      method: "POST",
      url: apiPath(RUNNER_ROUTES.jobProgress, { jobId: job.id }),
      payload: { update: progress },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(sent.statusCode, sent.body).toBe(204);
    const latest = async () => (await admin.get(`${API_ROUTES.jobs}?hostId=${hostId}`)).json<JobView[]>()[0]!;
    expect(await latest()).toMatchObject({ id: job.id, status: "delivered", progress });

    await answer(job.id, { succeeded: true, outcome: "Updated whoami.", output: null });
    expect((await latest()).progress).toBeNull();
    expect(heard).toEqual([
      { kind: "job", hostId, jobId: job.id },
      { kind: "job", hostId, jobId: job.id },
      { kind: "progress", hostId, jobId: job.id, progress },
      { kind: "job", hostId, jobId: job.id },
    ]);
  });

  it("refuses to change what the host keeps Autoheal's hands off, but still reads its logs", async () => {
    await report([containerSnapshot({ name: "paperless" }), containerSnapshot({ name: "newt" })], {
      protectedContainers: ["newt"],
    });
    const refused = await ask("newt", { action: "restart" });
    expect(refused.statusCode).toBe(422);
    expect(refused.json<{ error: string }>().error).toBe("hands_off");
    expect((await ask("newt", { action: "logs" })).statusCode).toBe(200);

    await report([containerSnapshot({ name: "paperless" })], { dryRun: true });
    expect((await ask("paperless", { action: "stop" })).statusCode).toBe(422);
    expect((await takeWork()).jobs.map((job) => job.action)).toEqual(["logs"]);
  });

  it("checks a whole host for updates", async () => {
    const asked = await admin.post(apiPath(API_ROUTES.hostActions, { hostId }), { action: "check_updates" });
    expect(asked.json<JobView>()).toMatchObject({ action: "check_updates", containerName: "" });
    expect((await takeWork()).jobs.map((job) => job.action)).toEqual(["check_updates"]);
  });

  it("refuses viewers, containers the host does not have, and updates a label turned off", async () => {
    const { client: viewer } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    expect((await ask("paperless", { action: "restart" }, viewer)).statusCode).toBe(403);
    expect((await ask("ghost", { action: "restart" })).json()).toEqual({ error: "container_not_found" });
    expect((await ask("postgres", { action: "update" })).json()).toEqual({ error: "job_unavailable" });
    expect((await ask("paperless", { action: "check_updates" })).statusCode).toBe(400);
    await admin.post(apiPath(API_ROUTES.hostRevoke, { hostId }));
    expect((await ask("paperless", { action: "restart" })).json()).toEqual({ error: "host_revoked" });
  });

  it("works an update task: in progress while it runs, closed when the update succeeds", async () => {
    await controlPlane.services.detectorService.run();
    const task = (await openTasks()).find((candidate) => candidate.title === "Update paperless on Alder");
    expect(task).toBeUndefined();
    await report([containerSnapshot({ name: "paperless", update })]);
    await controlPlane.services.detectorService.run();
    const updateTask = (await openTasks()).find((candidate) => candidate.title === "Update paperless on Alder")!;

    const job = (await ask("paperless", { action: "update", taskId: updateTask.id })).json<JobView>();
    expect((await detail(updateTask.id)).status).toBe("in_progress");
    await takeWork();
    await answer(job.id, {
      succeeded: true,
      outcome: "Updated paperless to the newest image, and it is running.",
      output: null,
    });
    const done = await detail(updateTask.id);
    expect(done.status).toBe("done");
    expect(done.jobs.map((entry) => entry.status)).toEqual(["succeeded"]);
    expect(done.activity.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["job_requested", "status_changed", "job_finished"]),
    );
  });

  it("refuses to work a task by acting on a container it is not about", async () => {
    await report([containerSnapshot({ name: "paperless", update }), containerSnapshot({ name: "whoami" })]);
    await controlPlane.services.detectorService.run();
    const updateTask = (await openTasks()).find((candidate) => candidate.title === "Update paperless on Alder")!;
    const elsewhere = await ask("whoami", { action: "update", taskId: updateTask.id });
    expect(elsewhere.json()).toEqual({ error: "invalid_target" });
  });

  it("expires an action nobody collected, and fails one the runner never answered", async () => {
    const forgotten = (await ask("paperless", { action: "restart" })).json<JobView>();
    controlPlane.clock.now += JOB_EXPIRY_MILLISECONDS + 1;
    expect((await takeWork()).jobs).toEqual([]);
    const expired = (await admin.get(apiPath(API_ROUTES.job, { jobId: forgotten.id }))).json<JobView>();
    expect(expired.status).toBe("expired");

    const silent = (await ask("paperless", { action: "stop" })).json<JobView>();
    await takeWork();
    controlPlane.clock.now += JOB_ANSWER_MILLISECONDS + 1;
    // Its runner is gone and collects nothing: the host's list says so all the same.
    await admin.get(`${API_ROUTES.jobs}?${new URLSearchParams({ [JOB_QUERY.hostId]: silent.hostId })}`);
    const failed = (await admin.get(apiPath(API_ROUTES.job, { jobId: silent.id }))).json<JobView>();
    expect(failed).toMatchObject({ status: "failed", outcome: expect.stringContaining("never said how it went") });
  });

  it("leaves a person's task waiting again when their update fails, and closes it once the update is gone", async () => {
    await controlPlane.services.detectorService.run();
    const task = (await openTasks()).find((candidate) => candidate.title === "Update whoami on Alder")!;
    await admin.request({
      method: "PATCH",
      url: apiPath(API_ROUTES.task, { taskId: task.id }),
      payload: { assignee: { kind: "user", id: (await detail(task.id)).assignee!.id } },
    });
    const job = (await ask("whoami", { action: "update", taskId: task.id })).json<JobView>();
    expect((await detail(task.id)).status).toBe("in_progress");
    await takeWork();
    await answer(job.id, {
      succeeded: false,
      outcome: "Could not update whoami (Docker answered HTTP 400).",
      output: null,
    });
    expect((await detail(task.id)).status).toBe("todo");

    // Updated by hand meanwhile: the next check finds it current, and the task closes by itself.
    await report([
      containerSnapshot({ name: "paperless" }),
      containerSnapshot({ name: "whoami", update: { ...update, status: "current" }, updatePolicy: "auto" }),
      containerSnapshot({ name: "postgres", update, updatePolicy: "off" }),
    ]);
    await controlPlane.services.detectorService.run();
    expect((await detail(task.id)).status).toBe("done");
  });

  describe("Autoheal's own updates", () => {
    const workerWith = (assessment: Assessment) =>
      new AutohealWorker({
        tasks: controlPlane.services.tasksService,
        jobs: controlPlane.services.jobsService,
        inventory: controlPlane.services.inventoryService,
        assessor: { assess: async () => assessment },
        notifier: controlPlane.services.notifier,
      });
    const whoamiTask = async () => {
      await controlPlane.services.detectorService.run();
      return (await openTasks()).find((candidate) => candidate.title === "Update whoami on Alder")!;
    };

    it("updates when nothing says to wait, and holds on to the task until the runner answers", async () => {
      const task = await whoamiTask();
      await workerWith({ decision: "update", reason: "A web demo with no data." }).run();
      const working = await detail(task.id);
      expect(working).toMatchObject({ status: "in_progress", checkedOut: true });
      expect(working.comments.map((comment) => [comment.author, comment.body])).toEqual([
        ["Autoheal", "Going ahead: A web demo with no data."],
      ]);
      const [job] = (await takeWork()).jobs;
      expect(job).toMatchObject({ action: "update", containerName: "whoami", requestedBy: "Autoheal" });
      expect(job).not.toHaveProperty("allowWithoutCheckpoint");
      await answer(job!.id, { succeeded: false, outcome: "Could not pull whoami: manifest unknown", output: null });
      const handedOver = await detail(task.id);
      expect(handedOver).toMatchObject({ status: "todo", checkedOut: false });
      expect(handedOver.assignee).toMatchObject({ kind: "user", name: "admin" });
    });

    it("gives the task back, saying why, once the host protects the container", async () => {
      const task = await whoamiTask();
      await report([containerSnapshot({ name: "whoami", update, updatePolicy: "auto" })], {
        protectedContainers: ["whoami"],
      });
      await workerWith({ decision: "update", reason: "A web demo with no data." }).run();
      const returned = await detail(task.id);
      expect(returned).toMatchObject({ status: "todo", checkedOut: false });
      expect(returned.assignee).toMatchObject({ kind: "user", name: "admin" });
      expect(returned.comments.at(-1)?.body).toBe(
        "Giving this back: whoami is protected on Alder, so Autoheal never changes it.",
      );
      expect((await takeWork()).jobs).toEqual([]);
    });

    it("hands the task to a person when the assessment holds it, and updates when the person gives it back", async () => {
      const task = await whoamiTask();
      await workerWith({ decision: "hold", reason: "A database on a moving tag." }).run();
      const held = await detail(task.id);
      expect(held.assignee).toMatchObject({ kind: "user", name: "admin" });
      expect(held.comments.at(-1)?.body).toBe("Holding this update for you: A database on a moving tag.");
      expect((await takeWork()).jobs).toEqual([]);

      await admin.request({
        method: "PATCH",
        url: apiPath(API_ROUTES.task, { taskId: task.id }),
        payload: { assignee: { kind: "agent", id: "autoheal" } },
      });
      await workerWith({ decision: "hold", reason: "Still a database." }).run();
      expect((await takeWork()).jobs.map((job) => job.action)).toEqual(["update"]);
      expect((await detail(task.id)).comments.at(-1)?.body).toContain("Updating as asked");
    });

    it("applies each new image of a container that always takes them, without asking Ollama", async () => {
      const chosen = await admin.put(apiPath(API_ROUTES.containerControls, { hostId }), {
        names: ["whoami"],
        update: "always",
      });
      expect(chosen.statusCode).toBe(204);
      const task = await whoamiTask();
      await workerWith({ decision: "hold", reason: "Would have held it." }).run();
      expect((await detail(task.id)).comments.map((comment) => comment.body)).toEqual([
        "Applying it: this container takes each new image, undone at once if it does not come back healthy.",
      ]);
      expect((await takeWork()).jobs).toEqual([expect.objectContaining({ action: "update", containerName: "whoami" })]);
    });

    it("gives Ollama's view on an update a person holds, once, and changes nothing", async () => {
      await report([containerSnapshot({ name: "paperless", update })]);
      await controlPlane.services.detectorService.run();
      const held = (await openTasks()).find((candidate) => candidate.title === "Update paperless on Alder")!;
      expect(held.advice).toBeNull();

      await workerWith({ decision: null, reason: "connection refused" }).adviseUpdates();
      expect((await detail(held.id)).advice).toBeNull();

      await workerWith({ decision: "update", reason: "A document app; the update looks routine." }).adviseUpdates();
      await workerWith({ decision: "hold", reason: "Asked twice." }).adviseUpdates();
      const advised = await detail(held.id);
      expect(advised).toMatchObject({ advice: "update", status: "todo", checkedOut: false });
      expect(advised.assignee).toMatchObject({ kind: "user", name: "admin" });
      expect(advised.comments.map((comment) => comment.body)).toEqual([
        "Ollama calls it safe to apply: A document app; the update looks routine.",
      ]);
      expect((await takeWork()).jobs).toEqual([]);
    });

    it("goes ahead as the label allows when Ollama cannot be asked", async () => {
      const task = await whoamiTask();
      await controlPlane.services.autohealWorker.run();
      expect((await detail(task.id)).comments.at(-1)?.body).toContain("Ollama could not be asked");
      expect((await takeWork()).jobs.map((job) => job.containerName)).toEqual(["whoami"]);
    });
  });

  describe("Autoheal freeing a full disk", () => {
    const worker = () => controlPlane.services.autohealWorker;
    const unused = {
      id: `sha256:${"a".repeat(64)}`,
      tags: [],
      repository: "ghcr.io/paperless-ngx/paperless-ngx",
      sizeBytes: 22 * BYTES_PER_GIBIBYTE,
      createdAt: 1,
      keptByUpdate: false,
    };
    // `/`, where Docker keeps its images, this full; its runner reports half a minute later than last time.
    const reportRoot = async (percent: number) => {
      controlPlane.clock.now += HEARTBEAT_INTERVAL_MILLISECONDS;
      const root = {
        path: "/",
        totalBytes: 100 * BYTES_PER_GIBIBYTE,
        usedBytes: percent * BYTES_PER_GIBIBYTE,
        availableBytes: (100 - percent) * BYTES_PER_GIBIBYTE,
      };
      await report([], { host: hostHealth({ disks: [root], imageStore: "/var/lib/docker" }), unusedImages: [unused] });
    };
    const diskTask = async (imageCleanup: string) => {
      await admin.put(apiPath(API_ROUTES.hostControl, { hostId }), { imageCleanup });
      await reportRoot(93);
      await controlPlane.services.detectorService.run();
      return (await openTasks()).find((candidate) => candidate.resource?.kind === "disk")!;
    };
    const cleanedUp = async () => {
      const [job, ...others] = (await takeWork()).jobs;
      expect(others).toEqual([]);
      expect(job).toMatchObject({ action: "prune_images", containerName: "", requestedBy: "Autoheal" });
      return job!;
    };

    it("removes the unused images at once, and closes the task once the host reports the space back", async () => {
      const task = await diskTask("weekly");
      expect(task.assignee).toMatchObject({ kind: "agent", id: "autoheal" });
      await worker().run();
      await worker().run();
      const job = await cleanedUp();
      expect(await detail(task.id)).toMatchObject({ status: "in_progress", checkedOut: true });
      await answer(job.id, { succeeded: true, outcome: "Removed 1 image (23.6 GB).", output: null });

      // Its report from before the clean-up says nothing of what it left.
      await worker().run();
      expect(await detail(task.id)).toMatchObject({ status: "in_progress", checkedOut: false });
      await reportRoot(71);
      await controlPlane.services.detectorService.run();
      await worker().run();
      const closed = await detail(task.id);
      expect(closed.status).toBe("done");
      expect(closed.comments.map((comment) => comment.body)).toEqual(["Removed the unused images: / is now 71% full."]);

      // Full again the same day: the task comes back, and Autoheal cleans up again.
      await reportRoot(95);
      await controlPlane.services.detectorService.run();
      expect(await detail(task.id)).toMatchObject({ status: "todo", assignee: { kind: "agent", id: "autoheal" } });
      await worker().run();
      await cleanedUp();
    });

    it("gives the task to a person when what fills the disk is not images", async () => {
      const task = await diskTask("weekly");
      await worker().run();
      await answer((await cleanedUp()).id, { succeeded: true, outcome: "No image was unused.", output: null });
      await reportRoot(93);
      await controlPlane.services.detectorService.run();
      await worker().run();
      const returned = await detail(task.id);
      expect(returned).toMatchObject({ status: "todo", checkedOut: false });
      expect(returned.assignee).toMatchObject({ kind: "user", name: "admin" });
      expect(returned.comments.at(-1)?.body).toBe(
        "Ran the image clean-up, but / is still 93% full: what fills it is not unused images. Giving this back.",
      );
      await worker().run();
      expect((await takeWork()).jobs).toEqual([]);
    });

    const handOver = async (taskId: string) => {
      const handed = await admin.request({
        method: "PATCH",
        url: apiPath(API_ROUTES.task, { taskId }),
        payload: { assignee: { kind: "agent", id: "autoheal" } },
      });
      expect(handed.statusCode, handed.body).toBe(200);
    };

    it("takes a disk task a person hands over, and gives back a clean-up that failed", async () => {
      const task = await diskTask("off");
      expect(task.assignee).toMatchObject({ kind: "user", name: "admin" });
      await handOver(task.id);
      await worker().run();
      await answer((await cleanedUp()).id, { succeeded: false, outcome: "Docker refused.", output: null });
      expect((await detail(task.id)).assignee).toMatchObject({ kind: "user", name: "admin" });
    });

    it("gives back, saying why, a disk task that removing images cannot free", async () => {
      const nas = {
        path: "/mnt/storage/disk1",
        totalBytes: 100 * BYTES_PER_GIBIBYTE,
        usedBytes: 99 * BYTES_PER_GIBIBYTE,
        availableBytes: 1 * BYTES_PER_GIBIBYTE,
      };
      // A runner from before it said where Docker keeps its images.
      await report([], { host: hostHealth({ disks: [nas] }), unusedImages: [unused] });
      await controlPlane.services.detectorService.run();
      const task = (await openTasks()).find((candidate) => candidate.resource?.id === nas.path)!;
      await handOver(task.id);
      await worker().run();
      expect((await detail(task.id)).comments.at(-1)?.body).toBe(
        "The runner on Alder does not say yet where Docker keeps its images: update it first. Giving this back.",
      );

      await report([], { host: hostHealth({ disks: [nas], imageStore: "/var/lib/docker" }), unusedImages: [unused] });
      await handOver(task.id);
      await worker().run();
      const returned = await detail(task.id);
      expect(returned).toMatchObject({ status: "todo", checkedOut: false, assignee: { kind: "user", name: "admin" } });
      expect(returned.comments.at(-1)?.body).toBe(
        "Docker keeps its images on another disk, so removing the unused ones would not free /mnt/storage/disk1. Giving this back.",
      );
      expect((await takeWork()).jobs).toEqual([]);
    });
  });
});
