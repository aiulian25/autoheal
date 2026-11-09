import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestControlPlane } from "../../../test/support/control-plane.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import { API_ERRORS, API_ROUTES, type EnrolledHostView } from "../../shared/api.js";
import {
  INCIDENT_STATUS,
  TRACE,
  VERDICT_ESCALATED,
  VERDICT_FIXED,
  VERDICT_SKIPPED,
  type IncidentStatus,
} from "../../shared/constants.js";
import type { IncidentSubmission, Outcome } from "../../shared/protocol.js";
import { hosts, incidentEvents } from "../database/schema.js";
import type { IncidentsService } from "./incidents-service.js";

const submission: IncidentSubmission = {
  detectedAt: 0,
  report: {
    containerName: "tika",
    image: "apache/tika:3.2",
    trigger: "die",
    stateSummary: "status=exited exit=1",
    healthOutputs: [],
    knownContainers: ["tika"],
    protectedContainers: [],
    logs: "error",
  },
};
const FIXED: Outcome = { outcome: "Restarted tika.", verdict: VERDICT_FIXED, executed: true };
const ESCALATED: Outcome = { outcome: "Restarting tika did not help.", verdict: VERDICT_ESCALATED, executed: false };
const SETTLED = [
  INCIDENT_STATUS.approved,
  INCIDENT_STATUS.dismissed,
  INCIDENT_STATUS.cancelled,
  INCIDENT_STATUS.resolved,
] as const;

describe("an incident's own transitions", () => {
  let controlPlane: TestControlPlane;
  let service: IncidentsService;
  let alder: string;
  let birch: string;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    const admin = (await fullySignedInAdmin(controlPlane)).client;
    const enroll = async (label: string) =>
      (await admin.post(API_ROUTES.hosts, { label })).json<EnrolledHostView>().host.id;
    alder = await enroll("Alder");
    birch = await enroll("Birch");
    service = controlPlane.services.incidentsService;
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  const database = () => controlPlane.services.databaseHandle.database;
  const hostRow = (hostId: string) => database().select().from(hosts).where(eq(hosts.id, hostId)).get()!;
  const open = (status: IncidentStatus) => service.create(hostRow(alder), submission, status);
  const traceOf = (incidentId: string) =>
    database()
      .select({ kind: incidentEvents.kind })
      .from(incidentEvents)
      .where(eq(incidentEvents.incidentId, incidentId))
      .all()
      .map(({ kind }) => kind);

  it.each([
    { result: ESCALATED, status: INCIDENT_STATUS.awaitingApproval },
    { result: FIXED, status: INCIDENT_STATUS.resolved },
  ])("moves a decided incident on by what its runner did: $result.verdict", ({ result, status }) => {
    const incident = open(INCIDENT_STATUS.decided);
    expect(service.recordOutcome(hostRow(alder), incident.id, result)).toMatchObject({
      status,
      verdict: result.verdict,
      outcome: result.outcome,
    });
  });

  it.each(SETTLED)(
    "never moves an incident that is %s back on a late or repeated report, but keeps what it says",
    (status) => {
      const incident = open(status);
      expect(service.recordOutcome(hostRow(alder), incident.id, ESCALATED)).toMatchObject({
        status,
        outcome: ESCALATED.outcome,
      });
      expect(traceOf(incident.id)).toEqual([TRACE.reported, TRACE.outcomeReported]);
    },
  );

  it("takes no outcome from a host the incident is not on", () => {
    const incident = open(INCIDENT_STATUS.decided);
    expect(() => service.recordOutcome(hostRow(birch), incident.id, FIXED)).toThrow(
      expect.objectContaining({ code: API_ERRORS.incidentNotFound }),
    );
    expect(service.find(incident.id).status).toBe(INCIDENT_STATUS.decided);
    expect(traceOf(incident.id)).toEqual([TRACE.reported]);
  });

  it("changes an incident only while it is as it was when looked at", () => {
    const incident = open(INCIDENT_STATUS.awaitingApproval);
    expect(service.updateIf(incident.id, INCIDENT_STATUS.deciding, { status: INCIDENT_STATUS.cancelled })).toBeNull();
    expect(service.find(incident.id).status).toBe(INCIDENT_STATUS.awaitingApproval);
    const changed = service.updateIf(incident.id, INCIDENT_STATUS.awaitingApproval, {
      status: INCIDENT_STATUS.approved,
    });
    expect(changed?.status).toBe(INCIDENT_STATUS.approved);
  });

  it("settles an escalation nothing is left to decide about only while it still waits for a person", () => {
    const waiting = open(INCIDENT_STATUS.awaitingApproval);
    expect(service.settleUnneeded(waiting.id, "tika is running again")).toMatchObject({
      status: INCIDENT_STATUS.resolved,
      verdict: VERDICT_SKIPPED,
      outcome: "tika is running again",
    });
    expect(traceOf(waiting.id)).toEqual([TRACE.reported, TRACE.noLongerNeeded]);
    const decided = open(INCIDENT_STATUS.approved);
    expect(service.settleUnneeded(decided.id, "tika is running again")).toBeNull();
    expect(service.find(decided.id).status).toBe(INCIDENT_STATUS.approved);
    expect(traceOf(decided.id)).toEqual([TRACE.reported]);
  });

  it("cancels only what a control plane restart left mid-decision", () => {
    const deciding = open(INCIDENT_STATUS.deciding);
    const waiting = open(INCIDENT_STATUS.awaitingApproval);
    expect(service.cancelInterrupted()).toBe(1);
    expect(service.find(deciding.id).status).toBe(INCIDENT_STATUS.cancelled);
    expect(traceOf(deciding.id)).toEqual([TRACE.reported, TRACE.controlPlaneRestarted]);
    expect(service.find(waiting.id).status).toBe(INCIDENT_STATUS.awaitingApproval);
  });
});
