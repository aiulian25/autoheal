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
  type IncidentDetailView,
  type PromptSnapshotView,
  type RunbookView,
} from "../../shared/api.js";
import { RUNNER_ROUTES, type DecisionResponse, type IncidentSubmission } from "../../shared/protocol.js";

const submission: IncidentSubmission = {
  detectedAt: Date.UTC(2026, 9, 20, 11, 59),
  report: {
    containerName: "paperless",
    image: "ghcr.io/paperless-ngx/paperless-ngx:2.13",
    trigger: "die",
    stateSummary: "status=exited",
    healthOutputs: [],
    knownContainers: ["paperless", "tika"],
    protectedContainers: [],
    logs: "error",
  },
};

describe("runbooks", () => {
  let ollama: FakeOllama;
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let runnerToken: string;

  beforeEach(async () => {
    ollama = await FakeOllama.start();
    ollama.handler = () => answer({ action: "escalate", target: "paperless", diagnosis: "x" });
    controlPlane = await startTestControlPlane({ ollamaUrl: ollama.url() });
    admin = (await fullySignedInAdmin(controlPlane)).client;
    runnerToken = runnerTokenOf((await admin.post(API_ROUTES.hosts, { label: "HP" })).json<EnrolledHostView>());
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
    await ollama.close();
  });

  const create = async (scope: string, title: string, body: string, pattern?: string) =>
    (await admin.post(API_ROUTES.runbooks, { scope, title, body, pattern })).json<RunbookView>();
  const publish = (runbook: RunbookView, version = 1) =>
    admin.post(
      apiPath(API_ROUTES.runbookPublish, { runbookId: runbook.id, versionId: runbook.versions[version - 1]!.id }),
    );
  const decide = async () =>
    (
      await controlPlane.runnerApp.inject({
        method: "POST",
        url: RUNNER_ROUTES.incidents,
        payload: submission,
        headers: { authorization: `Bearer ${runnerToken}` },
      })
    ).json<DecisionResponse>();
  const lastSystemPrompt = () => ollama.requests.at(-1)!.messages[0]!.content;

  it("keeps every version and uses the latest published one", async () => {
    const runbook = await create("container", "Paperless", "Tika starts slowly; restart it.", "paperless");
    expect(runbook).toMatchObject({ publishedVersion: null, versions: [{ version: 1, publishedAt: null }] });
    expect((await publish(runbook)).json()).toMatchObject({ publishedVersion: 1 });
    const second = (
      await admin.post(apiPath(API_ROUTES.runbookVersions, { runbookId: runbook.id }), {
        body: "Never restart paperless.",
      })
    ).json<RunbookView>();
    expect(second.publishedVersion).toBe(1);
    expect((await publish(second, 2)).json()).toMatchObject({ publishedVersion: 2 });
    const stored = (await admin.get(apiPath(API_ROUTES.runbook, { runbookId: runbook.id }))).json<RunbookView>();
    expect(stored.versions.map((version) => version.body)).toEqual([
      "Tika starts slowly; restart it.",
      "Never restart paperless.",
    ]);
    expect(stored.versions[0]!.createdBy).toBe("admin");
  });

  it("validates scope, pattern and length", async () => {
    const global = await admin.post(API_ROUTES.runbooks, {
      scope: "global",
      title: "x",
      body: "y",
      pattern: "paperless",
    });
    expect(global.json()).toEqual({ error: "runbook_pattern_invalid" });
    const container = await admin.post(API_ROUTES.runbooks, { scope: "container", title: "x", body: "y" });
    expect(container.statusCode).toBe(422);
    const long = await admin.post(API_ROUTES.runbooks, { scope: "global", title: "x", body: "y".repeat(2_001) });
    expect(long.json()).toEqual({ error: "runbook_too_long" });
  });

  it("keeps an archived runbook read-only", async () => {
    const runbook = await create("global", "Old", "ARCHIVED RULE");
    await admin.post(apiPath(API_ROUTES.runbookArchive, { runbookId: runbook.id }));
    const saved = await admin.post(apiPath(API_ROUTES.runbookVersions, { runbookId: runbook.id }), { body: "x" });
    expect(saved.statusCode).toBe(409);
    expect(saved.json()).toEqual({ error: "runbook_archived" });
    expect((await publish(runbook)).json()).toEqual({ error: "runbook_archived" });
  });

  it("lets viewers read runbooks but not change them", async () => {
    await create("global", "House rules", "Escalate anything touching the database.");
    const { client: viewer } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    expect((await viewer.get(API_ROUTES.runbooks)).json()).toHaveLength(1);
    expect((await viewer.post(API_ROUTES.runbooks, { scope: "global", title: "x", body: "y" })).statusCode).toBe(403);
  });

  it("gives the model the runbooks that match, least specific first, and records which", async () => {
    await publish(await create("container", "Paperless", "CONTAINER RULE", "paperless"));
    await publish(await create("global", "House", "GLOBAL RULE"));
    await publish(await create("image", "Paperless image", "IMAGE RULE", "ghcr.io/paperless-ngx/paperless-ngx"));
    await publish(await create("container", "Tika", "OTHER CONTAINER RULE", "tika"));
    await create("global", "Draft only", "DRAFT RULE");
    const archived = await create("global", "Old", "ARCHIVED RULE");
    await publish(archived);
    await admin.post(apiPath(API_ROUTES.runbookArchive, { runbookId: archived.id }));

    const { incidentId } = await decide();
    const prompt = lastSystemPrompt();
    expect(prompt.indexOf("GLOBAL RULE")).toBeLessThan(prompt.indexOf("IMAGE RULE"));
    expect(prompt.indexOf("IMAGE RULE")).toBeLessThan(prompt.indexOf("CONTAINER RULE"));
    for (const absent of ["OTHER CONTAINER RULE", "DRAFT RULE", "ARCHIVED RULE"]) {
      expect(prompt).not.toContain(absent);
    }
    const incident = (await admin.get(apiPath(API_ROUTES.incident, { incidentId }))).json<IncidentDetailView>();
    expect(incident.trace.find((event) => event.kind === "prompt_built")!.payload.runbooks).toEqual([
      { title: "House", version: 1 },
      { title: "Paperless image", version: 1 },
      { title: "Paperless", version: 1 },
    ]);
    const snapshot = (
      await admin.get(apiPath(API_ROUTES.prompt, { promptHash: incident.promptHash! }))
    ).json<PromptSnapshotView>();
    expect(snapshot.systemPrompt).toBe(prompt);
  });

  it("changes the prompt hash only when the instructions change", async () => {
    const promptHashOf = async () => {
      const { incidentId } = await decide();
      return (await admin.get(apiPath(API_ROUTES.incident, { incidentId }))).json<IncidentDetailView>().promptHash;
    };
    const base = await promptHashOf();
    expect(await promptHashOf()).toBe(base);
    await publish(await create("global", "House", "GLOBAL RULE"));
    const withRunbook = await promptHashOf();
    expect(withRunbook).not.toBe(base);
    expect(await promptHashOf()).toBe(withRunbook);
  });
});
