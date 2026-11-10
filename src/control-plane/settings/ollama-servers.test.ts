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
import {
  API_ROUTES,
  apiPath,
  type AuditEventView,
  type EnrolledHostView,
  type OllamaServersView,
} from "../../shared/api.js";
import { RUNNER_ROUTES, type HeartbeatResponse, type IncidentSubmission } from "../../shared/protocol.js";

const MODEL = "qwen3:30b-a3b";
const thinking = { capabilities: ["completion", "thinking"], model_info: { "qwen3moe.context_length": 262_144 } };
const submission = (detectedAt: number): IncidentSubmission => ({
  detectedAt,
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
});

describe("several Ollama servers, each watching chosen hosts", () => {
  let fallback: FakeOllama;
  let second: FakeOllama;
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let hostId: string;
  let otherHostId: string;
  let runnerToken: string;
  let otherRunnerToken: string;

  beforeEach(async () => {
    fallback = await FakeOllama.start();
    second = await FakeOllama.start();
    second.models = { [MODEL]: thinking };
    controlPlane = await startTestControlPlane({ ollamaUrl: fallback.url() });
    admin = (await fullySignedInAdmin(controlPlane)).client;
    const first = (await admin.post(API_ROUTES.hosts, { label: "HP" })).json<EnrolledHostView>();
    const other = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    hostId = first.host.id;
    otherHostId = other.host.id;
    runnerToken = runnerTokenOf(first);
    otherRunnerToken = runnerTokenOf(other);
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
    await fallback.close();
    await second.close();
  });

  const fromRunner = (url: string, payload: object, token = runnerToken) =>
    controlPlane.runnerApp.inject({ method: "POST", url, payload, headers: { authorization: `Bearer ${token}` } });
  const servers = async () => (await admin.get(API_ROUTES.ollamaServers)).json<OllamaServersView>();
  const body = () => ({ name: "Orion2480", url: second.url(), model: MODEL, contextTokens: 32_768 });
  const added = async () => (await admin.post(API_ROUTES.ollamaServers, body())).json<{ id: string }>().id;
  const assign = (serverId: string, hostIds: string[]) =>
    admin.put(apiPath(API_ROUTES.ollamaServerHosts, { serverId }), { hostIds });

  it("changes nothing until a host is ticked: every host stays on the default", async () => {
    await added();
    await fromRunner(RUNNER_ROUTES.incidents, submission(1_000));
    expect(second.requests).toHaveLength(0);
    expect(fallback.requests).toHaveLength(1);
  });

  it("sends a ticked host's incident to its server, built for that server, and tells its runner", async () => {
    const id = await added();
    expect((await assign(id, [hostId])).statusCode).toBe(204);
    await fromRunner(RUNNER_ROUTES.incidents, submission(1_000));
    expect(fallback.requests).toHaveLength(0);
    expect(second.requests.at(-1)).toMatchObject({ model: MODEL, options: { num_ctx: 32_768 } });
    const answer = (await fromRunner(RUNNER_ROUTES.heartbeat, heartbeatWith())).json<HeartbeatResponse>();
    expect(answer.ollama).toEqual({ url: second.url(), model: MODEL, contextTokens: 32_768 });

    await fromRunner(RUNNER_ROUTES.incidents, submission(2_000), otherRunnerToken);
    expect(fallback.requests).toHaveLength(1);
    const other = (
      await fromRunner(RUNNER_ROUTES.heartbeat, heartbeatWith(), otherRunnerToken)
    ).json<HeartbeatResponse>();
    expect(other.ollama?.url).toBe(fallback.url());
  });

  it("moves a host from one server to another, and unticking goes back to the default", async () => {
    const id = await added();
    const third = await FakeOllama.start();
    third.models = { [MODEL]: thinking };
    const another = (await admin.post(API_ROUTES.ollamaServers, { ...body(), name: "NUC2", url: third.url() })).json<{
      id: string;
    }>().id;
    await assign(id, [hostId, otherHostId]);
    await assign(another, [hostId]);
    const seen = (await servers()).extras;
    expect(seen.find((server) => server.id === id)?.hostIds).toEqual([otherHostId]);
    expect(seen.find((server) => server.id === another)?.hostIds).toEqual([hostId]);
    await assign(another, []);
    await fromRunner(RUNNER_ROUTES.incidents, submission(1_000));
    expect(third.requests).toHaveLength(0);
    expect(fallback.requests).toHaveLength(1);
    await third.close();
  });

  it("falls back when its server has gone, says so on the incident, and carries on", async () => {
    const id = await added();
    await assign(id, [hostId]);
    await second.close();
    const decided = (await fromRunner(RUNNER_ROUTES.incidents, submission(1_000))).json<{ incidentId: string }>();
    expect(fallback.requests).toHaveLength(1);
    const incident = controlPlane.services.incidentsService.detail(decided.incidentId);
    expect(incident.trace.some((event) => event.kind === "server_fell_back")).toBe(true);
    second = await FakeOllama.start();
  });

  it("removing a server sends its hosts back, and the audit log names them", async () => {
    const id = await added();
    await assign(id, [hostId]);
    expect((await admin.delete(apiPath(API_ROUTES.ollamaServer, { serverId: id }))).statusCode).toBe(204);
    expect((await servers()).extras).toEqual([]);
    await fromRunner(RUNNER_ROUTES.incidents, submission(1_000));
    expect(fallback.requests).toHaveLength(1);
    const audit = (await admin.get(API_ROUTES.audit)).json<AuditEventView[]>();
    expect(audit.find((event) => event.action === "ollama.server_removed")?.details).toEqual({
      name: "Orion2480",
      hostsMovedToDefault: [hostId],
    });
  });

  it("checks a server before storing it, and refuses a name in use", async () => {
    const unreachable = await admin.post(API_ROUTES.ollamaServers, { ...body(), url: "https://localhost:1" });
    expect(unreachable.json()).toEqual({ error: "ollama_unreachable" });
    await added();
    const taken = await admin.post(API_ROUTES.ollamaServers, body());
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: "ollama_server_name_taken" });
  });

  it("keeps the review's choice, and forgets it with its server", async () => {
    const id = await added();
    await admin.put(API_ROUTES.ollamaReviewServer, { serverId: id });
    expect((await servers()).reviewServerId).toBe(id);
    expect(controlPlane.services.ollamaPool.reviewServer().id).toBe(id);
    await admin.delete(apiPath(API_ROUTES.ollamaServer, { serverId: id }));
    expect((await servers()).reviewServerId).toBeNull();
  });

  it("names the default without choosing it, keeps names apart, and goes back to Default when blank", async () => {
    expect((await admin.put(API_ROUTES.ollamaDefaultName, { name: "Mini" })).statusCode).toBe(204);
    expect((await servers()).defaultName).toBe("Mini");
    const settingsNow = (await admin.get(API_ROUTES.ollamaSettings)).json<{ source: string }>();
    expect(settingsNow.source).toBe("environment");
    const taken = await admin.post(API_ROUTES.ollamaServers, { ...body(), name: "Mini" });
    expect(taken.json()).toEqual({ error: "ollama_server_name_taken" });
    await added();
    const takenByServer = await admin.put(API_ROUTES.ollamaDefaultName, { name: "Orion2480" });
    expect(takenByServer.json()).toEqual({ error: "ollama_server_name_taken" });
    await admin.put(API_ROUTES.ollamaDefaultName, { name: "  " });
    expect((await servers()).defaultName).toBeNull();
    const viewer = (await fullySignedInUser(controlPlane, admin, "namer", "viewer")).client;
    expect((await viewer.put(API_ROUTES.ollamaDefaultName, { name: "x" })).statusCode).toBe(403);
  });

  it("shows a viewer the servers, and refuses every change", async () => {
    const id = await added();
    const viewer = (await fullySignedInUser(controlPlane, admin, "viewer", "viewer")).client;
    expect((await viewer.get(API_ROUTES.ollamaServers)).statusCode).toBe(200);
    const refused = [
      await viewer.post(API_ROUTES.ollamaServers, body()),
      await viewer.put(apiPath(API_ROUTES.ollamaServer, { serverId: id }), body()),
      await viewer.delete(apiPath(API_ROUTES.ollamaServer, { serverId: id })),
      await viewer.put(apiPath(API_ROUTES.ollamaServerHosts, { serverId: id }), { hostIds: [] }),
      await viewer.put(API_ROUTES.ollamaReviewServer, { serverId: null }),
    ];
    expect(refused.map(({ statusCode }) => statusCode)).toEqual([403, 403, 403, 403, 403]);
  });

  it("opens a warning naming the hosts when one is down, and closes it once it answers", async () => {
    const id = await added();
    await assign(id, [hostId]);
    const { detect } = await import("../tasks/detectors.js");
    const status = (reachable: boolean) => ({
      ...controlPlane.services.ollamaMonitor.status(),
      checkedAt: 1,
      reachable,
    });
    const inputs = (reachable: boolean) =>
      ({
        now: 1,
        hosts: [{ id: hostId, label: "HP" }],
        containers: [],
        history: () => [],
        homeAssistant: null,
        ollama: status(true),
        ollamaExtras: [{ id, name: "Orion2480", status: status(reachable), hostIds: [hostId] }],
        owner: null,
        packagePlan: () => null,
        unusedImages: () => [],
        imageCleanup: () => null,
      }) as unknown as Parameters<typeof detect>[0];
    const key = `ollama-server:${id}`;
    const down = detect(inputs(false)).problems.find((problem) => problem.key === key);
    expect(down?.title).toContain("Orion2480");
    expect(down?.description).toContain("HP");
    const back = detect(inputs(true));
    expect(back.problems.some((problem) => problem.key === key)).toBe(false);
    expect(back.judges(key)).toBe(true);
    expect(back.judges("ollama-server:removed-long-ago")).toBe(true);
  });
});
