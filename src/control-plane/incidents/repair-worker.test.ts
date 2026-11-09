import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
  runnerTokenOf,
} from "../../../test/support/control-plane.js";
import { containerSnapshot, heartbeatWith } from "../../../test/support/inventory.js";
import { fillNotificationQueue } from "../../../test/support/notifications.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import { API_ROUTES, apiPath, type EnrolledHostView, type IncidentDetailView } from "../../shared/api.js";
import { INCIDENT_STATUS, TRACE, VERDICT_ESCALATED, VERDICT_REPAIRED } from "../../shared/constants.js";
import {
  RUNNER_ROUTES,
  type ContainerSnapshot,
  type IncidentNotice,
  type WorkResponse,
} from "../../shared/protocol.js";
import { hosts } from "../database/schema.js";
import { oneServer } from "../ollama/ollama-pool.js";
import { RepairWorker, type RepairWorkerDependencies } from "./repair-worker.js";

const update = { status: "available" as const, checkedAt: 1, remoteDigest: `sha256:${"c".repeat(64)}` };
const RESTART_DID_NOT_HOLD = "Restarted tika, but it stopped again within a minute.";

const plan = (repair: string) =>
  JSON.stringify({
    repair,
    findings: "tika exits at start: a stale pid file in its own filesystem says it is running.",
    cause: "It was killed while running and left /run/tika.pid behind.",
    steps: ["Remove /run/tika.pid inside the container.", "Start it again."],
  });

describe("containers given to Ollama", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let token: string;
  let hostId: string;
  let answers: string[];
  let prompts: string[];
  let told: IncidentNotice[];
  // What happens elsewhere while Ollama decides, as a person on the board does.
  let asking: (() => Promise<void>) | null;
  let worker: RepairWorker;
  let dependencies: RepairWorkerDependencies;
  const failing = containerSnapshot({ name: "tika", image: "apache/tika:3.2", state: "exited", exitCode: 1 });

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    token = runnerTokenOf(enrolled);
    hostId = enrolled.host.id;
    answers = [];
    prompts = [];
    told = [];
    asking = null;
    const services = controlPlane.services;
    dependencies = {
      incidents: services.incidentsService,
      inventory: services.inventoryService,
      jobs: services.jobsService,
      models: oneServer(
        {
          chat: async (_systemPrompt: string, userPrompt: string) => {
            prompts.push(userPrompt);
            await asking?.();
            return { content: answers.shift() ?? "", thinking: "Its log says the pid file exists." };
          },
          contextTokens: 16_384,
          model: "model",
          modelDigest: async () => null,
        },
        { enqueue: (_priority, run) => run(new AbortController().signal) },
      ),
      runbooks: services.runbooksService,
      notifier: { incidentHandled: async (_host, notice) => void told.push(notice) },
      clock: () => controlPlane.clock.now,
    };
    worker = new RepairWorker(dependencies);
    await report([failing]);
    await giveToOllama("tika");
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  async function report(containers: ContainerSnapshot[], dryRun = false) {
    const response = await controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      payload: heartbeatWith({ containers, dryRun }),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
  }
  async function giveToOllama(name: string, restart = "repair") {
    const response = await admin.put(apiPath(API_ROUTES.containerControls, { hostId }), { names: [name], restart });
    expect(response.statusCode, response.body).toBe(204);
  }
  // A restart that did not hold: the incident waits for a person.
  const escalate = (containerName = "tika") => {
    const host = controlPlane.services.databaseHandle.database.select().from(hosts).get()!;
    const incidents = controlPlane.services.incidentsService;
    const incident = incidents.create(
      host,
      {
        detectedAt: controlPlane.clock.now,
        report: {
          containerName,
          image: "apache/tika:3.2",
          trigger: "die",
          stateSummary: "status=exited exit=1",
          healthOutputs: [],
          knownContainers: [containerName],
          protectedContainers: [],
          logs: "tika already running (pid file /run/tika.pid)",
        },
      },
      INCIDENT_STATUS.awaitingApproval,
    );
    incidents.update(incident.id, { verdict: VERDICT_ESCALATED, outcome: RESTART_DID_NOT_HOLD });
    return incident;
  };
  const detail = async (incidentId: string) =>
    (await admin.get(apiPath(API_ROUTES.incident, { incidentId }))).json<IncidentDetailView>();
  const eventsOf = async (incidentId: string, kind: string) =>
    (await detail(incidentId)).trace.filter((event) => event.kind === kind).map((event) => event.payload);
  const takeWork = async () =>
    (
      await controlPlane.runnerApp.inject({
        method: "GET",
        url: RUNNER_ROUTES.work,
        headers: { authorization: `Bearer ${token}` },
      })
    ).json<WorkResponse>().jobs;
  async function answerJob(jobId: string, succeeded: boolean, outcome: string) {
    const response = await controlPlane.runnerApp.inject({
      method: "POST",
      url: apiPath(RUNNER_ROUTES.jobResult, { jobId }),
      payload: { succeeded, outcome, output: null },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(204);
  }

  it("leaves an incident a person dismissed while Ollama looked into another as they left it", async () => {
    await report([
      failing,
      containerSnapshot({ name: "paperless", image: "paperless:2", state: "exited", exitCode: 1 }),
    ]);
    await giveToOllama("paperless");
    escalate("tika");
    escalate("paperless");
    // Whichever Ollama looks into first, a person dismisses the other on the board meanwhile.
    const dismissed: string[] = [];
    asking = async () => {
      asking = null;
      for (const waiting of controlPlane.services.incidentsService.list({ status: INCIDENT_STATUS.awaitingApproval })) {
        const response = await admin.post(apiPath(API_ROUTES.incidentApproval, { incidentId: waiting.id }), {
          choice: "dismiss",
        });
        expect(response.statusCode, response.body).toBe(200);
        dismissed.push(waiting.id);
      }
    };
    answers.push(plan("report"), plan("recreate"));
    await worker.run();

    expect(dismissed).toHaveLength(1);
    expect((await detail(dismissed[0]!)).status).toBe(INCIDENT_STATUS.dismissed);
    expect(await eventsOf(dismissed[0]!, TRACE.repairStarted)).toEqual([]);
    expect(prompts).toHaveLength(1);
    expect(await takeWork()).toEqual([]);
  });

  it("sets Ollama's answer aside when the incident ended while it decided, and starts nothing", async () => {
    const incident = escalate();
    // As a restore of the database does.
    asking = async () => {
      controlPlane.services.incidentsService.update(incident.id, { status: INCIDENT_STATUS.cancelled });
    };
    answers.push(plan("recreate"));
    await worker.run();

    expect((await detail(incident.id)).status).toBe(INCIDENT_STATUS.cancelled);
    expect(await takeWork()).toEqual([]);
    expect(await eventsOf(incident.id, TRACE.repairSkipped)).toHaveLength(1);
    expect(await eventsOf(incident.id, TRACE.repairPlanned)).toEqual([]);
    expect(told).toEqual([]);
  });

  it("recreates it once a restart did not hold, and settles the incident when that holds", async () => {
    const incident = escalate();
    answers.push(plan("recreate"));
    await worker.run();

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`What Autoheal did so far: ${RESTART_DID_NOT_HOLD}`);
    expect(prompts[0]).toContain("Repairs on offer: recreate, report.");
    expect(prompts[0]).toContain("tika already running");
    const underWay = await detail(incident.id);
    expect(underWay.status).toBe("approved");
    expect(await eventsOf(incident.id, TRACE.repairStarted)).toEqual([{ offered: ["recreate", "report"] }]);
    const [job] = await takeWork();
    expect(job).toMatchObject({ containerName: "tika", action: "recreate", requestedBy: "Autoheal" });
    expect((await eventsOf(incident.id, TRACE.repairPlanned))[0]).toMatchObject({
      repair: "recreate",
      jobId: job!.id,
      thinking: "Its log says the pid file exists.",
    });

    // Nothing more while the runner works on it.
    await worker.run();
    expect((await detail(incident.id)).status).toBe("approved");

    await answerJob(job!.id, true, "Recreated tika from its image, and it is running.");
    await worker.run();
    const outcome = "Ollama recreated it. Recreated tika from its image, and it is running.";
    expect(await detail(incident.id)).toMatchObject({ status: "resolved", verdict: VERDICT_REPAIRED, outcome });
    expect(told).toEqual([
      expect.objectContaining({
        containerName: "tika",
        verdict: VERDICT_REPAIRED,
        outcome,
        stateSummary: "running again",
      }),
    ]);
    expect(told[0]!.diagnosis).toContain("How to fix it:\n1. Remove /run/tika.pid inside the container.");
    expect(prompts).toHaveLength(1);
  });

  it("finishes every repair in a pass while no alert can be queued", async () => {
    await report([failing, containerSnapshot({ name: "paperless", state: "exited", exitCode: 1 })]);
    await giveToOllama("paperless");
    const repairing = [escalate(), escalate("paperless")];
    answers.push(plan("recreate"), plan("recreate"));
    await worker.run();
    for (const job of await takeWork()) await answerJob(job.id, true, `Recreated ${job.containerName}.`);
    fillNotificationQueue(controlPlane.services.databaseHandle, controlPlane.clock.now);
    await new RepairWorker({ ...dependencies, notifier: controlPlane.services.notifier }).run();
    expect(await Promise.all(repairing.map(async ({ id }) => (await detail(id)).status))).toEqual([
      "resolved",
      "resolved",
    ]);
    expect(controlPlane.services.notificationDeliveries.rules().overflowCount).toBe(2);
  });

  it("hands it back with Ollama's report when the repair does not work, and leaves a person's choice after it alone", async () => {
    const incident = escalate();
    answers.push(plan("recreate"));
    await worker.run();
    const [job] = await takeWork();
    await answerJob(job!.id, false, "Recreated tika, but it exited with code 1.");
    await worker.run();

    const outcome = "Ollama's repair (recreate) did not work. Recreated tika, but it exited with code 1.";
    expect(await detail(incident.id)).toMatchObject({
      status: "awaiting_approval",
      verdict: VERDICT_ESCALATED,
      outcome,
    });
    expect(told).toEqual([expect.objectContaining({ verdict: VERDICT_ESCALATED, outcome })]);
    expect(told[0]!.diagnosis).toContain("Likely cause: It was killed while running and left /run/tika.pid behind.");

    const approved = await admin.post(apiPath(API_ROUTES.incidentApproval, { incidentId: incident.id }), {
      choice: "restart",
    });
    expect(approved.statusCode, approved.body).toBe(200);
    await worker.run();
    expect((await detail(incident.id)).status).toBe("approved");
    expect(await eventsOf(incident.id, TRACE.repairFinished)).toHaveLength(1);
    expect(told).toHaveLength(1);
    expect(prompts).toHaveLength(1);
  });

  it("sends its report instead when the fix is more than it may do", async () => {
    const incident = escalate();
    answers.push(plan("report"));
    await worker.run();
    await worker.run();

    expect(prompts).toHaveLength(1);
    expect(await takeWork()).toEqual([]);
    const outcome = "Ollama looked into it and found no repair it may make: its report says how to fix it.";
    expect(await detail(incident.id)).toMatchObject({ status: "awaiting_approval", outcome });
    expect((await eventsOf(incident.id, TRACE.repairPlanned))[0]).not.toHaveProperty("jobId");
    expect(told).toEqual([expect.objectContaining({ verdict: VERDICT_ESCALATED, outcome })]);
  });

  it("offers a roll back while an update keeps the old container aside, and an update Autoheal may apply alone", async () => {
    await report([
      { ...failing, update, updatePolicy: "auto" },
      containerSnapshot({ name: "tika-autoheal-old", image: "apache/tika:3.1", state: "exited" }),
    ]);
    const applied = await admin.put(apiPath(API_ROUTES.containerControls, { hostId }), {
      names: ["tika"],
      update: "apply",
    });
    expect(applied.statusCode, applied.body).toBe(204);
    const incident = escalate();
    answers.push(plan("roll_back"));
    await worker.run();

    expect(prompts[0]).toContain("Repairs on offer: recreate, roll_back, update, report.");
    expect(await takeWork()).toEqual([expect.objectContaining({ containerName: "tika", action: "roll_back" })]);
    expect((await detail(incident.id)).status).toBe("approved");
  });

  it("offers a container whose new images wait for a person an update only once a person hands the incident over", async () => {
    // As most containers are: its new images are asked about.
    await report([{ ...failing, update }]);
    const incident = escalate();
    answers.push(plan("report"), plan("report"));
    await worker.run();
    expect(prompts[0]).toContain("Repairs on offer: recreate, report.");

    // Their hand-over is their word on its update too.
    controlPlane.services.incidentsService.addEvent(incident.id, TRACE.dispatched, { by: "admin" });
    await worker.run();
    expect(prompts[1]).toContain("Repairs on offer: recreate, update, report.");
  });

  it("reports when Ollama picks a repair that is not on offer", async () => {
    const incident = escalate();
    answers.push(plan("update"));
    await worker.run();

    expect(await takeWork()).toEqual([]);
    expect(await detail(incident.id)).toMatchObject({
      status: "awaiting_approval",
      outcome: "Ollama chose update, which was not on offer, so this is its report.",
    });
  });

  it("never offers a database a newer image", async () => {
    await report([
      containerSnapshot({
        name: "postgres",
        image: "postgres:16-alpine",
        state: "exited",
        update,
        updatePolicy: "auto",
      }),
    ]);
    await giveToOllama("postgres");
    escalate("postgres");
    answers.push(plan("report"));
    await worker.run();

    expect(prompts[0]).toContain("Repairs on offer: recreate, report.");
  });

  it("waits for a person when Ollama's answer is no repair, without asking again", async () => {
    const incident = escalate();
    answers.push("not json at all");
    await worker.run();
    await worker.run();

    expect(prompts).toHaveLength(1);
    expect(await detail(incident.id)).toMatchObject({ status: "awaiting_approval", outcome: RESTART_DID_NOT_HOLD });
    expect(await eventsOf(incident.id, TRACE.repairSkipped)).toEqual([
      { reason: expect.stringContaining("Ollama gave no repair") },
    ]);
    expect(told).toEqual([]);
  });

  it("asks again when a restart of Autoheal cut its ask short", async () => {
    const incident = escalate();
    const incidents = controlPlane.services.incidentsService;
    incidents.addEvent(incident.id, TRACE.repairStarted, { offered: ["recreate", "report"] });
    incidents.update(incident.id, { status: INCIDENT_STATUS.approved });
    answers.push(plan("recreate"));
    await worker.run();

    expect(prompts).toHaveLength(1);
    expect(await takeWork()).toEqual([expect.objectContaining({ action: "recreate" })]);
  });

  it("stops at two repairs a day for one container", async () => {
    for (const attempt of [1, 2]) {
      const earlier = escalate();
      answers.push(plan("recreate"));
      await worker.run();
      const [job] = await takeWork();
      await answerJob(job!.id, false, `Attempt ${attempt} exited with code 1.`);
      await worker.run();
      controlPlane.services.incidentsService.update(earlier.id, { status: INCIDENT_STATUS.dismissed });
    }
    const third = escalate();
    await worker.run();

    expect(prompts).toHaveLength(2);
    expect(await eventsOf(third.id, TRACE.repairSkipped)).toEqual([
      { reason: "tika was given 2 repairs in the last day: this one waits for you." },
    ]);
    expect((await detail(third.id)).status).toBe("awaiting_approval");
  });

  it("leaves alone containers not given to it, hosts in dry-run, and ones running again", async () => {
    await giveToOllama("tika", "ask");
    const incident = escalate();
    await worker.run();
    await giveToOllama("tika");
    await report([failing], true);
    await worker.run();
    await report([containerSnapshot({ name: "tika", image: "apache/tika:3.2" })]);
    await worker.run();

    expect(prompts).toEqual([]);
    expect((await detail(incident.id)).status).toBe("awaiting_approval");
    expect(await eventsOf(incident.id, TRACE.repairStarted)).toEqual([]);
  });
});
