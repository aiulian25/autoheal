import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startTestControlPlane,
  runnerTokenOf,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { FakeOllama, answer, type ChatRequest } from "../../../test/fakes/fake-ollama.js";
import { containerSnapshot, heartbeatWith, hostHealth } from "../../../test/support/inventory.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import {
  API_ROUTES,
  apiPath,
  type EnrolledHostView,
  type IncidentDetailView,
  type TaskDetailView,
  type TaskSummaryView,
} from "../../shared/api.js";
import { INCIDENT_STATUS, TRACE } from "../../shared/constants.js";
import {
  RUNNER_ROUTES,
  type ContainerSnapshot,
  type PackageCheck,
  type PackageFacts,
  type WorkResponse,
} from "../../shared/protocol.js";
import { hosts } from "../database/schema.js";
import { osUpdatesKey } from "../host-packages/host-packages-service.js";

const update = { status: "available" as const, checkedAt: 1, remoteDigest: `sha256:${"c".repeat(64)}` };
const packageFacts: PackageFacts = {
  setting: "apply",
  unsupported: null,
  unattendedUpgrades: false,
  rebootPackages: [],
  kernelWaiting: null,
  timeZone: "Europe/Lisbon",
  recentChanges: [],
};
const pending = (name: string, origin: string) => ({ name, installed: "1.0", candidate: "1.1", origins: [origin] });
const CHECK: PackageCheck = {
  refreshed: true,
  refreshProblem: null,
  needsRepair: false,
  upgradable: [
    pending("curl", "Debian:13.1/stable"),
    pending("netdata", "Netdata:stable"),
    pending("postgresql-17", "Debian:13.1/stable"),
  ],
  keptBack: [],
  removable: [],
  rebootRequired: null,
};
const REPORT = {
  findings: "The new version stops at once: 'missing setting APP_MODE'.",
  cause: "Version 2 needs a setting the container does not have.",
  steps: ["Add APP_MODE=production to its environment.", "Update it again."],
};
const PLAN = {
  repair: "update",
  findings: "postgres exits: 'database files are incompatible with server'.",
  cause: "The files were made by a newer version.",
  steps: ["Run the newer image."],
};

// The question's JSON schema says which question it is: a repair, or why handed-over work failed.
const isRepair = (chat: ChatRequest) => "repair" in ((chat.format.properties as object | undefined) ?? {});

describe("work handed to the Ollama agent", () => {
  let ollama: FakeOllama;
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let token: string;
  let hostId: string;
  const whoami = containerSnapshot({ name: "whoami", image: "traefik/whoami:v1", update });
  const postgres = containerSnapshot({ name: "postgres", image: "postgres:16-alpine", update });
  // Protected by the host's .env.
  const npm = containerSnapshot({ name: "npm", image: "jc21/nginx-proxy-manager:2", update });

  beforeEach(async () => {
    ollama = await FakeOllama.start();
    ollama.handler = (chat) => answer(isRepair(chat) ? PLAN : REPORT);
    controlPlane = await startTestControlPlane({ ollamaUrl: ollama.url() });
    admin = (await fullySignedInAdmin(controlPlane)).client;
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    token = runnerTokenOf(enrolled);
    hostId = enrolled.host.id;
    await report([whoami, postgres, npm]);
    await controlPlane.services.detectorService.run();
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
    await ollama.close();
  });

  async function report(containers: ContainerSnapshot[], dryRun = false) {
    const response = await controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      payload: heartbeatWith({ containers, dryRun, host: hostHealth({ packages: packageFacts }) }),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
  }
  const runner = (method: "GET" | "POST", url: string, payload?: object) =>
    controlPlane.runnerApp.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  const takeWork = async () => (await runner("GET", RUNNER_ROUTES.work)).json<WorkResponse>().jobs;
  const answerJob = async (jobId: string, result: object) =>
    expect((await runner("POST", apiPath(RUNNER_ROUTES.jobResult, { jobId }), result)).statusCode).toBe(204);
  const dispatch = (payload: object, client = admin) => client.post(API_ROUTES.agentDispatch, payload);
  const taskFor = async (title: string) =>
    (await admin.get(API_ROUTES.tasks)).json<TaskSummaryView[]>().find((task) => task.title === title)!;
  const detail = async (taskId: string) =>
    (await admin.get(apiPath(API_ROUTES.task, { taskId }))).json<TaskDetailView>();
  const comments = async (taskId: string) => (await detail(taskId)).comments.map((comment) => comment.body);
  // The agents run as soon as work is handed over: what they asked of the runner arrives in their own time.
  const workArrives = async () => {
    let jobs: WorkResponse["jobs"] = [];
    await vi.waitFor(async () => {
      jobs = await takeWork();
      expect(jobs.length).toBeGreaterThan(0);
    });
    return jobs;
  };

  it("applies the updates it is handed whatever held them, each undone at once if it does not hold", async () => {
    const whoamiTask = await taskFor("Update whoami on Alder");
    const postgresTask = await taskFor("Update postgres on Alder");
    const response = await dispatch({ updates: [whoamiTask.id, postgresTask.id] });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ updates: 2, packages: 0, incidents: 0 });

    const jobs = await workArrives();
    expect(jobs.toSorted((first, second) => first.containerName.localeCompare(second.containerName))).toEqual([
      expect.objectContaining({ containerName: "postgres", action: "update", undoIfUnhealthy: true }),
      expect.objectContaining({ containerName: "whoami", action: "update", undoIfUnhealthy: true }),
    ]);
    // Neither an ask-first container nor a database was put to Ollama: the person decided.
    expect(ollama.requests).toEqual([]);
    expect((await detail(whoamiTask.id)).assignee).toMatchObject({ kind: "agent", name: "Autoheal" });
    expect(await comments(whoamiTask.id)).toContain(
      "admin handed this to Ollama: applying it whatever held it, undone at once if it does not come back healthy.",
    );
    expect(controlPlane.stdout.filter((line) => line.includes("agent.dispatched"))).toHaveLength(2);

    const whoamiJob = jobs.find((job) => job.containerName === "whoami")!;
    await answerJob(whoamiJob.id, {
      succeeded: false,
      outcome: "Updated whoami, but the new container stopped (exit 1), so it was undone at once.",
      output: "whoami 2: missing setting APP_MODE",
    });
    expect((await detail(whoamiTask.id)).assignee).toMatchObject({ kind: "user", name: "admin" });
    await controlPlane.services.failureReporter.run();
    await controlPlane.services.failureReporter.run();
    expect(ollama.requests).toHaveLength(1);
    const asked = ollama.requests[0]!.messages.at(-1)!.content;
    expect(asked).toContain("What failed: update of whoami on Alder.");
    expect(asked).toContain("<<<LOGS\nwhoami 2: missing setting APP_MODE\nLOGS>>>");
    expect((await comments(whoamiTask.id)).at(-1)).toBe(
      [
        REPORT.findings,
        `Likely cause: ${REPORT.cause}`,
        "How to fix it:",
        `1. ${REPORT.steps[0]}`,
        `2. ${REPORT.steps[1]}`,
      ].join("\n"),
    );
  });

  it("refuses the whole hand-over when its runner would refuse part of it, and changes nothing", async () => {
    const whoamiTask = await taskFor("Update whoami on Alder");
    const npmTask = await taskFor("Update npm on Alder");
    expect((await dispatch({ updates: [whoamiTask.id, npmTask.id] })).json()).toEqual({ error: "hands_off" });
    expect((await detail(whoamiTask.id)).assignee).toMatchObject({ kind: "user" });

    const { client: viewer } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    expect((await dispatch({ updates: [whoamiTask.id] }, viewer)).statusCode).toBe(403);
    expect((await dispatch({})).statusCode).toBe(400);

    await report([whoami], true);
    expect((await dispatch({ updates: [whoamiTask.id] })).json()).toEqual({ error: "hands_off" });
    expect(await takeWork()).toEqual([]);
  });

  it("installs the packages it is handed now, the held ones too, and hands their task back after", async () => {
    await controlPlane.services.hostPackages.request(
      { kind: "agent", agent: "autoheal" },
      hostId,
      "check_packages",
      [],
    );
    const [check] = await takeWork();
    await answerJob(check!.id, { succeeded: true, outcome: "Checked.", output: null, packages: CHECK });
    await controlPlane.services.detectorService.run();
    const task = controlPlane.services.tasksService.openFor(osUpdatesKey(hostId))!;

    const response = await dispatch({ packages: [{ hostId, names: ["netdata", "postgresql-17"] }] });
    expect(response.json()).toEqual({ updates: 0, packages: 2, incidents: 0 });
    const [upgrade] = await takeWork();
    expect(upgrade).toMatchObject({
      action: "upgrade_packages",
      packages: ["netdata", "postgresql-17"],
      requestedBy: "Autoheal",
    });
    expect(await detail(task.id)).toMatchObject({ status: "in_progress", assignee: { kind: "agent" } });
    expect(await comments(task.id)).toContain(
      "admin handed these to Ollama: installing netdata, postgresql-17 now, whatever held them. A reboot they need stays yours.",
    );

    await answerJob(upgrade!.id, {
      succeeded: false,
      outcome: "The upgrade failed.",
      output: "E: dpkg was interrupted, you must manually run 'dpkg --configure -a'",
    });
    expect(await detail(task.id)).toMatchObject({ status: "todo", assignee: { kind: "user", name: "admin" } });
    await controlPlane.services.failureReporter.run();
    expect(ollama.requests[0]!.messages.at(-1)!.content).toContain(
      "What failed: upgrade packages of the host's packages",
    );
    expect((await comments(task.id)).at(-1)).toContain("How to fix it:");
    expect(JSON.stringify(await comments(task.id))).not.toContain("night");

    expect((await dispatch({ packages: [{ hostId, names: ["vim"] }] })).json()).toEqual({
      error: "packages_not_offered",
    });
  });

  it("repairs an escalated incident it is handed, whatever its container's own answer, a database's update too", async () => {
    await report([{ ...postgres, state: "exited", exitCode: 1 }, whoami, npm]);
    const host = controlPlane.services.databaseHandle.database.select().from(hosts).get()!;
    const incidents = controlPlane.services.incidentsService;
    const incident = incidents.create(
      host,
      {
        detectedAt: controlPlane.clock.now,
        report: {
          containerName: "postgres",
          image: "postgres:16-alpine",
          trigger: "die",
          stateSummary: "status=exited exit=1",
          healthOutputs: [],
          knownContainers: ["postgres", "whoami", "npm"],
          protectedContainers: ["npm"],
          logs: "FATAL: database files are incompatible with server",
        },
      },
      INCIDENT_STATUS.awaitingApproval,
    );

    expect((await dispatch({ incidents: [incident.id] })).json()).toEqual({ updates: 0, packages: 0, incidents: 1 });
    const [job] = await workArrives();
    expect(job).toMatchObject({ containerName: "postgres", action: "update", requestedBy: "Autoheal" });
    expect(ollama.requests[0]!.messages.at(-1)!.content).toContain("Repairs on offer: recreate, update, report.");
    const view = (
      await admin.get(apiPath(API_ROUTES.incident, { incidentId: incident.id }))
    ).json<IncidentDetailView>();
    expect(view.status).toBe("approved");
    expect(view.trace.map((event) => event.kind)).toEqual(
      expect.arrayContaining([TRACE.dispatched, TRACE.repairStarted, TRACE.repairPlanned]),
    );

    expect((await dispatch({ incidents: [incident.id] })).json()).toEqual({ error: "not_awaiting_approval" });
  });
});
