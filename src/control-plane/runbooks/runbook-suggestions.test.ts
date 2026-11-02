import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeOllama, answer } from "../../../test/fakes/fake-ollama.js";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import {
  API_ROUTES,
  apiPath,
  type EnrolledHostView,
  type RunbookSuggestionView,
  type RunbookView,
} from "../../shared/api.js";
import {
  APPROVAL_EXPIRY_MILLISECONDS,
  MILLISECONDS_PER_DAY,
  VERDICT_FIXED,
  VERDICT_SKIPPED,
} from "../../shared/constants.js";
import { RUNNER_ROUTES, type DecisionResponse, type WorkResponse } from "../../shared/protocol.js";

interface Approval {
  choice: string;
  target?: string;
  note?: string;
}

describe("runbook drafts from recurring escalations", () => {
  let ollama: FakeOllama;
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let token: string;

  beforeEach(async () => {
    ollama = await FakeOllama.start();
    // Ollama does not answer: every failure waits for a person.
    ollama.handler = () => ({ status: 500, body: {} });
    controlPlane = await startTestControlPlane({ ollamaUrl: ollama.url() });
    admin = (await fullySignedInAdmin(controlPlane)).client;
    token = runnerTokenOf((await admin.post(API_ROUTES.hosts, { label: "HP" })).json<EnrolledHostView>());
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
    await ollama.close();
  });

  const runner = (method: "GET" | "POST", url: string, payload?: object) =>
    controlPlane.runnerApp.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  const suggested = async () => (await admin.get(API_ROUTES.runbookSuggestions)).json<RunbookSuggestionView[]>();
  const draftPath = (key: string) => apiPath(API_ROUTES.runbookSuggestionDraft, { key });

  // A container dies, and Ollama's silence leaves it to a person.
  async function escalate(container: string, daysAgo: number) {
    const submission = {
      detectedAt: controlPlane.clock.now - daysAgo * MILLISECONDS_PER_DAY,
      report: {
        containerName: container,
        image: `${container}:1`,
        trigger: "die",
        stateSummary: "status=exited",
        healthOutputs: [],
        knownContainers: ["paperless", "tika", "redis", "npm"],
        // One Compose project: dependencies the model may restart.
        projectContainers: ["paperless", "tika", "redis"],
        protectedContainers: ["npm"],
        logs: "error",
      },
    };
    return (await runner("POST", RUNNER_ROUTES.incidents, submission)).json<DecisionResponse>().incidentId;
  }

  // A person approves a fix, and its runner takes it.
  async function approve(incidentId: string, approval: Approval) {
    const approved = await admin.post(apiPath(API_ROUTES.incidentApproval, { incidentId }), approval);
    expect(approved.statusCode, approved.body).toBe(200);
    const [item] = (await runner("GET", RUNNER_ROUTES.work)).json<WorkResponse>().items;
    return item!;
  }

  // The runner reports how the fix went: by default, it held.
  async function report(workItemId: string, verdict: string = VERDICT_FIXED) {
    const result = { outcome: verdict, verdict, executed: verdict === VERDICT_FIXED };
    expect((await runner("POST", apiPath(RUNNER_ROUTES.workResult, { workItemId }), result)).statusCode).toBe(204);
  }

  async function settle(container: string, daysAgo: number, approval: Approval) {
    await report((await approve(await escalate(container, daysAgo), approval)).id);
  }

  it("suggests a container escalated three times and settled by the same fix, drafts it and tries it on request", async () => {
    // Only the last 30 days count, and two escalations of tika are not enough.
    for (const days of [40, 9, 5, 2]) {
      await settle("paperless", days, {
        choice: "restart_dependency",
        target: "tika",
        note: `tika was down ${days} days ago`,
      });
    }
    for (const days of [8, 3]) await settle("tika", days, { choice: "restart" });
    // Nor is a fix the runner found no longer needed.
    const skipped = await approve(await escalate("paperless", 7), { choice: "restart_dependency", target: "tika" });
    await report(skipped.id, VERDICT_SKIPPED);

    const [suggestion, ...others] = await suggested();
    expect(others).toEqual([]);
    expect(suggestion).toMatchObject({
      hostLabel: "HP",
      containerName: "paperless",
      trigger: "die",
      action: "restart_dependency",
      target: "tika",
      title: "paperless: restart tika when it dies",
      runbookId: null,
      replay: null,
    });
    expect(suggestion!.incidents).toHaveLength(3);

    // The model now answers as the draft says, but once it picks another dependency.
    let calls = 0;
    ollama.handler = () =>
      answer({ action: "restart_dependency", target: calls++ === 0 ? "redis" : "tika", diagnosis: "it is down" });
    const drafted = await admin.post(draftPath(suggestion!.key));
    expect(drafted.statusCode, drafted.body).toBe(200);
    const view = drafted.json<RunbookSuggestionView>();
    await controlPlane.services.replayService.whenFinished(view.replay!.id);
    expect((await suggested())[0]).toMatchObject({
      key: suggestion!.key,
      runbookId: view.runbookId,
      replay: { status: "finished", matched: 2, incidents: 3 },
    });

    // Tried again, the same draft is replayed, and its newest replay counts.
    const again = (await admin.post(draftPath(suggestion!.key))).json<RunbookSuggestionView>();
    expect(again.runbookId).toBe(view.runbookId);
    await controlPlane.services.replayService.whenFinished(again.replay!.id);
    expect((await suggested())[0]!.replay).toMatchObject({ id: again.replay!.id, matched: 3 });

    const runbook = (await admin.get(apiPath(API_ROUTES.runbook, { runbookId: view.runbookId! }))).json<RunbookView>();
    expect(runbook).toMatchObject({ scope: "container", pattern: "paperless", title: suggestion!.title });
    expect(runbook.publishedVersion).toBeNull();
    const [version] = runbook.versions;
    expect(version!.body).toContain('When paperless dies, answer "restart_dependency" with target "tika"');
    expect(version!.body).toContain("tika was down 2 days ago");
    expect(version!.body).not.toContain("tika was down 40 days ago");

    // Published, the case is answered.
    await admin.post(apiPath(API_ROUTES.runbookPublish, { runbookId: runbook.id, versionId: version!.id }));
    expect(await suggested()).toEqual([]);
  });

  it("counts only the matches with the fix that held, sets a case aside when its draft is archived, and is for admins", async () => {
    for (const days of [6, 4, 1]) await settle("paperless", days, { choice: "restart" });
    const [suggestion] = await suggested();
    // The model escalates each time: about paperless, as the fix was, but not to restart it.
    ollama.handler = () => answer({ action: "escalate", diagnosis: "unsure" });
    const view = (await admin.post(draftPath(suggestion!.key))).json<RunbookSuggestionView>();
    await controlPlane.services.replayService.whenFinished(view.replay!.id);
    expect((await suggested())[0]!.replay).toMatchObject({ status: "finished", matched: 0, incidents: 3 });

    const viewer = (await fullySignedInUser(controlPlane, admin, "observer", "viewer")).client;
    expect((await viewer.get(API_ROUTES.runbookSuggestions)).statusCode).toBe(403);
    expect((await viewer.post(draftPath(suggestion!.key))).statusCode).toBe(403);
    expect((await admin.post(draftPath("0".repeat(64)))).json()).toEqual({ error: "runbook_suggestion_not_found" });

    await admin.post(apiPath(API_ROUTES.runbookArchive, { runbookId: view.runbookId! }));
    expect(await suggested()).toEqual([]);
  });

  it("counts an escalation once when a late result settles it a second time", async () => {
    await settle("paperless", 5, { choice: "restart" });
    const incidentId = await escalate("paperless", 3);
    const late = await approve(incidentId, { choice: "restart" });
    // The fix expires before the runner reports it, and a person approves it again.
    controlPlane.clock.now += APPROVAL_EXPIRY_MILLISECONDS;
    expect((await runner("GET", RUNNER_ROUTES.work)).json<WorkResponse>().items).toEqual([]);
    await report((await approve(incidentId, { choice: "restart" })).id);
    await report(late.id);
    expect(await suggested()).toEqual([]);

    await settle("paperless", 1, { choice: "restart" });
    expect((await suggested())[0]!.incidents).toHaveLength(3);
  });
});
