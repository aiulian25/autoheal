import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeOllama } from "../../../test/fakes/fake-ollama.js";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { heartbeatWith } from "../../../test/support/inventory.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { API_ROUTES, type AuditEventView, type EnrolledHostView, type OllamaSettingsView } from "../../shared/api.js";
import { RUNNER_ROUTES, type HeartbeatResponse, type IncidentSubmission } from "../../shared/protocol.js";

const submission: IncidentSubmission = {
  detectedAt: Date.UTC(2026, 9, 24, 12),
  report: {
    containerName: "paperless",
    image: "paperless:2",
    trigger: "die",
    stateSummary: "status=exited exit_code=1",
    healthOutputs: [],
    knownContainers: ["paperless"],
    protectedContainers: [],
    logs: "crashed",
  },
};
const thinking = (contextLength: number) => ({
  capabilities: ["completion", "thinking"],
  model_info: { "qwen3moe.context_length": contextLength },
});

describe("the Ollama Autoheal asks, chosen in the dashboard", () => {
  let fromEnvironment: FakeOllama;
  let chosen: FakeOllama;
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let runnerToken: string;

  beforeEach(async () => {
    fromEnvironment = await FakeOllama.start();
    chosen = await FakeOllama.start();
    chosen.models = { "qwen3:30b-a3b": thinking(262_144) };
    controlPlane = await startTestControlPlane({ ollamaUrl: fromEnvironment.url() });
    admin = (await fullySignedInAdmin(controlPlane)).client;
    runnerToken = runnerTokenOf((await admin.post(API_ROUTES.hosts, { label: "HP" })).json<EnrolledHostView>());
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
    await fromEnvironment.close();
    await chosen.close();
  });

  const fromRunner = (url: string, payload: object) =>
    controlPlane.runnerApp.inject({
      method: "POST",
      url,
      payload,
      headers: { authorization: `Bearer ${runnerToken}` },
    });
  const view = async () => (await admin.get(API_ROUTES.ollamaSettings)).json<OllamaSettingsView>();
  const environment = () => ({ url: fromEnvironment.url(), model: "qwen3:4b-instruct", contextTokens: 16_384 });

  it("asks the .env's until another is saved, then that one, without a restart, and the .env's again on request", async () => {
    expect(await view()).toEqual({
      source: "environment",
      ...environment(),
      plainHttp: false,
      fromEnvironment: environment(),
    });

    const saved = { url: chosen.url(), model: "qwen3:30b-a3b", contextTokens: 32_768 };
    expect((await admin.put(API_ROUTES.ollamaSettings, saved)).statusCode).toBe(204);
    expect(await view()).toMatchObject({ source: "dashboard", ...saved });
    await fromRunner(RUNNER_ROUTES.incidents, submission);
    expect(fromEnvironment.requests).toHaveLength(0);
    expect(chosen.requests.at(-1)).toMatchObject({ model: "qwen3:30b-a3b", options: { num_ctx: 32_768 } });
    // Runners deciding alone get it with their next heartbeat.
    const answer = (await fromRunner(RUNNER_ROUTES.heartbeat, heartbeatWith())).json<HeartbeatResponse>();
    expect(answer.ollama).toEqual(saved);
    const audit = (await admin.get(API_ROUTES.audit)).json<AuditEventView[]>();
    expect(audit.find((event) => event.action === "ollama.saved")?.details).toEqual({
      url: saved.url,
      model: saved.model,
      contextWindow: saved.contextTokens,
    });

    expect((await admin.delete(API_ROUTES.ollamaSettings)).statusCode).toBe(204);
    expect((await view()).source).toBe("environment");
    await fromRunner(RUNNER_ROUTES.incidents, { ...submission, detectedAt: submission.detectedAt + 1 });
    expect(fromEnvironment.requests.at(-1)).toMatchObject({ model: "qwen3:4b-instruct", options: { num_ctx: 16_384 } });
  });

  it("asks that Ollama first: refuses no answer, a model it lacks, one that cannot answer, more than the model reads", async () => {
    const asking = (overrides: object) =>
      admin.put(API_ROUTES.ollamaSettings, {
        url: chosen.url(),
        model: "qwen3:30b-a3b",
        contextTokens: 16_384,
        ...overrides,
      });
    expect((await asking({ url: "https://localhost:1" })).json()).toEqual({ error: "ollama_unreachable" });
    expect((await asking({ model: "qwen3:235b" })).json()).toEqual({ error: "model_not_found" });
    chosen.models["nomic-embed-text"] = {
      capabilities: ["embedding"],
      model_info: { "nomic-bert.context_length": 2_048 },
    };
    expect((await asking({ model: "nomic-embed-text" })).json()).toEqual({ error: "model_cannot_answer" });
    chosen.models["qwen3:30b-a3b"] = thinking(40_960);
    expect((await asking({ contextTokens: 65_536 })).json()).toEqual({ error: "context_too_large" });
    expect((await asking({ contextTokens: 3 })).statusCode).toBe(400);
    expect((await view()).source).toBe("environment");
  });

  it("is read by everyone signed in and changed by admins only", async () => {
    const { client: viewer } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    expect((await viewer.get(API_ROUTES.ollamaSettings)).statusCode).toBe(200);
    const saved = { url: chosen.url(), model: "qwen3:30b-a3b", contextTokens: 16_384 };
    expect((await viewer.put(API_ROUTES.ollamaSettings, saved)).statusCode).toBe(403);
    expect((await viewer.delete(API_ROUTES.ollamaSettings)).statusCode).toBe(403);
    expect((await view()).source).toBe("environment");
  });
});
