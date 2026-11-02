import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeOllama } from "../../../test/fakes/fake-ollama.js";
import {
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
  runnerTokenOf,
} from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { API_ROUTES, apiPath, type EnrolledHostView, type IncidentDetailView } from "../../shared/api.js";
import { APPROVAL_EXPIRY_MILLISECONDS } from "../../shared/constants.js";
import {
  RUNNER_ROUTES,
  type DecisionResponse,
  type IncidentSubmission,
  type WorkResponse,
} from "../../shared/protocol.js";
import { auditEvents } from "../database/schema.js";

const submission: IncidentSubmission = {
  detectedAt: Date.UTC(2026, 9, 20, 11, 59),
  report: {
    containerName: "paperless",
    image: "paperless:2",
    trigger: "die",
    stateSummary: "status=exited",
    healthOutputs: [],
    knownContainers: ["paperless", "tika", "npm"],
    protectedContainers: ["npm"],
    logs: "error",
  },
};

describe("approvals", () => {
  let ollama: FakeOllama;
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let tokens: Record<string, string>;
  let incidentId: string;

  beforeEach(async () => {
    ollama = await FakeOllama.start();
    ollama.handler = () => ({ status: 500, body: {} });
    controlPlane = await startTestControlPlane({ ollamaUrl: ollama.url() });
    admin = (await fullySignedInAdmin(controlPlane)).client;
    tokens = {};
    for (const label of ["HP", "Alder"]) {
      tokens[label] = runnerTokenOf((await admin.post(API_ROUTES.hosts, { label })).json<EnrolledHostView>());
    }
    incidentId = (await runner("HP", "POST", RUNNER_ROUTES.incidents, submission)).json<DecisionResponse>().incidentId;
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
    await ollama.close();
  });

  const runner = (host: string, method: "GET" | "POST", url: string, payload?: object) =>
    controlPlane.runnerApp.inject({ method, url, payload, headers: { authorization: `Bearer ${tokens[host]}` } });
  const approve = (client: TestClient, payload: object) =>
    client.post(apiPath(API_ROUTES.incidentApproval, { incidentId }), payload);
  const work = async (host = "HP") => (await runner(host, "GET", RUNNER_ROUTES.work)).json<WorkResponse>().items;
  const incident = async () =>
    (await admin.get(apiPath(API_ROUTES.incident, { incidentId }))).json<IncidentDetailView>();

  it("starts from an escalation waiting for a person", async () => {
    expect((await incident()).status).toBe("awaiting_approval");
  });

  it("is admin-only", async () => {
    const { client: viewer } = await fullySignedInUser(controlPlane, admin, "partner", "viewer");
    expect((await approve(viewer, { choice: "restart" })).statusCode).toBe(403);
  });

  it.each([
    ["a protected container", "npm"],
    ["a container that is not on the host", "cedar1"],
    ["no container at all", undefined],
  ])("refuses a dependency restart of %s", async (_case, target) => {
    const response = await approve(admin, { choice: "restart_dependency", target });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "invalid_target" });
  });

  it("hands an approved action to its host exactly once, then records the result", async () => {
    const approval = await approve(admin, { choice: "restart_dependency", target: "tika", note: "tika was down" });
    expect(approval.json()).toMatchObject({ choice: "restart_dependency", target: "tika", decidedBy: "admin" });
    expect((await incident()).status).toBe("approved");
    expect(await work("Alder")).toEqual([]);

    const [item] = await work();
    expect(item).toMatchObject({
      containerName: "paperless",
      action: "restart_dependency",
      target: "tika",
      approvedBy: "admin",
    });
    expect(await work()).toEqual([]);

    const otherHost = await runner("Alder", "POST", apiPath(RUNNER_ROUTES.workResult, { workItemId: item!.id }), {
      outcome: "x",
      verdict: "restarted",
      executed: true,
    });
    expect(otherHost.statusCode).toBe(404);
    const result = { outcome: "Restarted tika.", verdict: "restarted", executed: true };
    expect(
      (await runner("HP", "POST", apiPath(RUNNER_ROUTES.workResult, { workItemId: item!.id }), result)).statusCode,
    ).toBe(204);

    const settled = await incident();
    expect(settled).toMatchObject({ status: "resolved", verdict: "restarted", outcome: "Restarted tika." });
    expect(settled.approvals).toHaveLength(1);
    expect(settled.trace.map((event) => event.kind).slice(-3)).toEqual([
      "approval_decided",
      "work_delivered",
      "work_completed",
    ]);
    const actions = controlPlane.services.databaseHandle.database
      .select()
      .from(auditEvents)
      .all()
      .map((event) => event.action);
    expect(actions).toContain("incident.approval_decided");
  });

  it("has no extra effect when approved twice", async () => {
    await approve(admin, { choice: "restart" });
    const again = await approve(admin, { choice: "restart" });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "not_awaiting_approval" });
    expect(await work()).toHaveLength(1);
  });

  it("refuses to approve anything for a revoked host", async () => {
    const [host] = (await admin.get(API_ROUTES.hosts))
      .json<{ id: string; label: string }[]>()
      .filter((candidate) => candidate.label === "HP");
    await admin.post(apiPath(API_ROUTES.hostRevoke, { hostId: host!.id }));
    const response = await approve(admin, { choice: "restart" });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: "host_revoked" });
  });

  it("never moves an incident backwards when the runner's own outcome report arrives late", async () => {
    await approve(admin, { choice: "restart" });
    const late = await runner("HP", "POST", apiPath(RUNNER_ROUTES.incidentOutcome, { incidentId }), {
      outcome: "Needs you, nothing was changed.",
      verdict: "needs you",
      executed: false,
    });
    expect(late.statusCode).toBe(204);
    const current = await incident();
    expect(current.status).toBe("approved");
    expect(current.trace.map((event) => event.kind)).toContain("outcome_reported");
    expect(await work()).toHaveLength(1);
  });

  it("closes the incident on dismiss without giving the host anything", async () => {
    await approve(admin, { choice: "dismiss", note: "known issue" });
    expect((await incident()).status).toBe("dismissed");
    expect(await work()).toEqual([]);
  });

  it("drops an approval the host did not collect in time and lets a person decide again", async () => {
    await approve(admin, { choice: "restart" });
    controlPlane.clock.now += APPROVAL_EXPIRY_MILLISECONDS;
    expect(await work()).toEqual([]);
    const expired = await incident();
    expect(expired.status).toBe("awaiting_approval");
    expect(expired.trace.map((event) => event.kind)).toContain("work_expired");
    expect((await approve(admin, { choice: "restart" })).statusCode).toBe(200);
    expect(await work()).toHaveLength(1);
  });
});
