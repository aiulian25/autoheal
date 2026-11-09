import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeOllama, answer } from "../../../test/fakes/fake-ollama.js";
import {
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
  runnerTokenOf,
} from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import {
  API_ROUTES,
  apiPath,
  type EnrolledHostView,
  type IncidentSummaryView,
  type ReplayRunView,
  type RunbookView,
} from "../../shared/api.js";
import { RUNNER_ROUTES, type IncidentSubmission } from "../../shared/protocol.js";
import { workItems } from "../database/schema.js";

const submission = (containerName: string): IncidentSubmission => ({
  detectedAt: Date.UTC(2026, 9, 20, 11, 59),
  report: {
    containerName,
    image: `${containerName}:1`,
    trigger: "die",
    stateSummary: "status=exited",
    healthOutputs: [],
    knownContainers: ["paperless", "tika", "redis"],
    protectedContainers: [],
    logs: "connection reset",
  },
});

describe("replay", () => {
  let ollama: FakeOllama;
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let runnerToken: string;

  beforeEach(async () => {
    ollama = await FakeOllama.start();
    // Live decisions escalate; with the draft runbook in the prompt, the model restarts instead.
    ollama.handler = (request) =>
      request.messages[0]!.content.includes("DRAFT RULE")
        ? answer({ action: "restart", target: "x", diagnosis: "the draft says restart" })
        : answer({ action: "escalate", target: "x", diagnosis: "unsure" });
    controlPlane = await startTestControlPlane({ ollamaUrl: ollama.url() });
    admin = (await fullySignedInAdmin(controlPlane)).client;
    runnerToken = runnerTokenOf((await admin.post(API_ROUTES.hosts, { label: "HP" })).json<EnrolledHostView>());
    for (const container of ["paperless", "tika", "redis"]) {
      await submit(submission(container));
    }
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
    await ollama.close();
  });

  const submit = (payload: IncidentSubmission) =>
    controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.incidents,
      payload,
      headers: { authorization: `Bearer ${runnerToken}` },
    });
  const draftRunbook = async () =>
    (
      await admin.post(API_ROUTES.runbooks, { scope: "global", title: "Draft", body: "DRAFT RULE" })
    ).json<RunbookView>();
  const startReplay = async (draftVersionIds: string[]) => {
    const started = (
      await admin.post(API_ROUTES.replays, { draftVersionIds, incidentCount: 10 })
    ).json<ReplayRunView>();
    await controlPlane.services.replayService.whenFinished(started.id);
    return (await admin.get(apiPath(API_ROUTES.replay, { replayId: started.id }))).json<ReplayRunView>();
  };

  it("shows how a draft runbook would change past decisions, without publishing it", async () => {
    const draft = await draftRunbook();
    const run = await startReplay([draft.versions[0]!.id]);
    expect(run).toMatchObject({
      status: "finished",
      incidentCount: 3,
      changedCount: 3,
      modelName: "qwen3:4b-instruct",
    });
    expect(run.results.map((result) => [result.containerName, result.originalAction, result.replayAction])).toEqual([
      ["redis", "escalate", "restart"],
      ["tika", "escalate", "restart"],
      ["paperless", "escalate", "restart"],
    ]);
    const withoutDraft = await startReplay([]);
    expect(withoutDraft.changedCount).toBe(0);
  });

  it("replays one incident against a draft, from that incident's own page", async () => {
    const draft = await draftRunbook();
    const tika = (await admin.get(API_ROUTES.incidents))
      .json<IncidentSummaryView[]>()
      .find((incident) => incident.containerName === "tika")!;
    // What the live decision's prompt carried besides the report goes with the replay too.
    controlPlane.services.incidentsService.saveEvidence(tika.id, ["Earlier incidents: tika was restarted twice"]);
    const started = await admin.post(API_ROUTES.replays, {
      draftVersionIds: [draft.versions[0]!.id],
      incidentIds: [tika.id],
    });
    expect(started.statusCode, started.body).toBe(200);
    const replayId = started.json<ReplayRunView>().id;
    await controlPlane.services.replayService.whenFinished(replayId);
    expect(ollama.requests.at(-1)!.messages[1]!.content).toContain("Earlier incidents: tika was restarted twice");
    const run = (await admin.get(apiPath(API_ROUTES.replay, { replayId }))).json<ReplayRunView>();
    expect(run).toMatchObject({ incidentCount: 1, changedCount: 1 });
    expect(run.results.map((result) => [result.containerName, result.replayAction])).toEqual([["tika", "restart"]]);

    const unknown = await admin.post(API_ROUTES.replays, { incidentIds: ["00000000-0000-4000-8000-000000000000"] });
    expect(unknown.json()).toEqual({ error: "incident_not_found" });
  });

  it("never creates work and never changes an incident", async () => {
    const before = (await admin.get(API_ROUTES.incidents)).json<IncidentSummaryView[]>();
    await startReplay([(await draftRunbook()).versions[0]!.id]);
    expect((await admin.get(API_ROUTES.incidents)).json()).toEqual(before);
    expect(controlPlane.services.databaseHandle.database.select().from(workItems).all()).toEqual([]);
  });

  it("decides a live incident first when one arrives mid-replay", async () => {
    const order: string[] = [];
    ollama.handler = async (request) => {
      const live = request.messages[1]!.content.includes("Failed container: urgent");
      await new Promise((resolve) => setTimeout(resolve, live ? 1 : 40));
      order.push(live ? "live" : "replay");
      return answer({ action: "escalate", target: "x", diagnosis: "d" });
    };
    const started = (await admin.post(API_ROUTES.replays, { incidentCount: 3 })).json<ReplayRunView>();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const live = await submit(submission("urgent"));
    expect(live.statusCode).toBe(200);
    order.push("live answered");
    await controlPlane.services.replayService.whenFinished(started.id);
    expect(order.indexOf("live answered")).toBeLessThan(order.lastIndexOf("replay"));
    const run = (await admin.get(apiPath(API_ROUTES.replay, { replayId: started.id }))).json<ReplayRunView>();
    expect(run.results.filter((result) => result.error === null)).toHaveLength(3);
  });

  it("asks the Ollama that decides for the incidents' host, with the model in use there", async () => {
    const watching = await FakeOllama.start();
    watching.models = { "qwen3:30b-a3b": {} };
    watching.handler = () => answer({ action: "restart", target: "x", diagnosis: "the host's own Ollama" });
    try {
      const added = await admin.post(API_ROUTES.ollamaServers, {
        name: "Rowan",
        url: watching.url(),
        model: "qwen3:30b-a3b",
        contextTokens: 32_768,
      });
      const hostId = (await admin.get(API_ROUTES.hosts)).json<{ id: string }[]>()[0]!.id;
      const assigned = await admin.put(
        apiPath(API_ROUTES.ollamaServerHosts, { serverId: added.json<{ id: string }>().id }),
        {
          hostIds: [hostId],
        },
      );
      expect(assigned.statusCode, assigned.body).toBeLessThan(300);
      const asked = ollama.requests.length;

      const run = await startReplay([]);
      expect(run).toMatchObject({ status: "finished", incidentCount: 3, modelName: "qwen3:30b-a3b" });
      expect(run.results.map((result) => result.replayDiagnosis)).toEqual(Array(3).fill("the host's own Ollama"));
      expect(watching.requests).toHaveLength(3);
      expect(ollama.requests).toHaveLength(asked);
    } finally {
      await watching.close();
    }
  });

  it("asks another model the same Ollama has, over as many recent incidents as asked, and refuses one it lacks", async () => {
    ollama.models["qwen3:30b-a3b"] = { capabilities: ["completion", "thinking"] };
    const before = ollama.requests.length;
    const started = (
      await admin.post(API_ROUTES.replays, { incidentCount: 2, modelName: "qwen3:30b-a3b" })
    ).json<ReplayRunView>();
    await controlPlane.services.replayService.whenFinished(started.id);
    const run = (await admin.get(apiPath(API_ROUTES.replay, { replayId: started.id }))).json<ReplayRunView>();
    expect(run).toMatchObject({ modelName: "qwen3:30b-a3b", incidentCount: 2 });
    expect(ollama.requests.slice(before).map((request) => request.model)).toEqual(["qwen3:30b-a3b", "qwen3:30b-a3b"]);

    const runs = (await admin.get(API_ROUTES.replays)).json<ReplayRunView[]>().length;
    const missing = await admin.post(API_ROUTES.replays, { modelName: "qwen3:235b" });
    expect(missing.statusCode).toBe(422);
    expect(missing.json()).toEqual({ error: "model_not_found" });
    expect((await admin.get(API_ROUTES.replays)).json<ReplayRunView[]>()).toHaveLength(runs);
  });

  it("is started by admins only, and refuses unknown drafts", async () => {
    const { client: viewer } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    expect((await viewer.post(API_ROUTES.replays, {})).statusCode).toBe(403);
    const unknown = await admin.post(API_ROUTES.replays, { draftVersionIds: ["6f1c9a1e-0000-4000-8000-000000000000"] });
    expect(unknown.json()).toEqual({ error: "runbook_version_not_found" });
    expect((await viewer.get(API_ROUTES.replays)).statusCode).toBe(200);
  });
});
