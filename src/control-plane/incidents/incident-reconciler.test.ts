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
import {
  HOST_SILENT_AFTER_MILLISECONDS,
  INCIDENT_CLEAR_MILLISECONDS,
  INCIDENT_OUTCOME_LOST,
  INCIDENT_OUTCOME_LOST_MILLISECONDS,
  INCIDENT_STATUS,
} from "../../shared/constants.js";
import { RUNNER_ROUTES, type ContainerSnapshot, type IncidentSubmission } from "../../shared/protocol.js";
import { hosts } from "../database/schema.js";
import { IncidentReconciler } from "./incident-reconciler.js";

const HALF_MINUTE = 30_000;
const MINUTE = 2 * HALF_MINUTE;

const submission = (detectedAt: number): IncidentSubmission => ({
  detectedAt,
  report: {
    containerName: "tika",
    image: "apache/tika:3.2",
    trigger: "die",
    stateSummary: "status=exited exit=1",
    healthOutputs: [],
    knownContainers: ["tika", "paperless"],
    protectedContainers: [],
    logs: "error",
  },
});

describe("escalations that nothing is left to decide about", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let token: string;
  let cleared: [host: string, container: string, outcome: string][];
  let reconciler: IncidentReconciler;
  const paperless = containerSnapshot({ name: "paperless" });

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
    token = runnerTokenOf((await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>());
    cleared = [];
    reconciler = new IncidentReconciler({
      incidents: controlPlane.services.incidentsService,
      inventory: controlPlane.services.inventoryService,
      notifier: {
        incidentCleared: async (host, incident, outcome) => void cleared.push([host, incident.containerName, outcome]),
      },
      clock: () => controlPlane.clock.now,
    });
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  const later = (milliseconds: number) => {
    controlPlane.clock.now += milliseconds;
  };
  const escalate = () => {
    const host = controlPlane.services.databaseHandle.database.select().from(hosts).get()!;
    return controlPlane.services.incidentsService.create(
      host,
      submission(controlPlane.clock.now),
      INCIDENT_STATUS.awaitingApproval,
    );
  };
  // Reports every half minute, as runners send them, and a pass after each.
  const reportFor = async (milliseconds: number, containers: ContainerSnapshot[]) => {
    for (let waited = 0; waited < milliseconds; waited += HALF_MINUTE) {
      later(HALF_MINUTE);
      const response = await controlPlane.runnerApp.inject({
        method: "POST",
        url: RUNNER_ROUTES.heartbeat,
        payload: heartbeatWith({ containers, dryRun: false }),
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      await reconciler.run();
    }
  };
  const detail = async (incidentId: string) =>
    (await admin.get(apiPath(API_ROUTES.incident, { incidentId }))).json<IncidentDetailView>();

  it("settles one whose container has stayed gone for two minutes of reports, and says so", async () => {
    const incident = escalate();
    await reportFor(INCIDENT_CLEAR_MILLISECONDS, [paperless]);
    expect((await detail(incident.id)).status).toBe("awaiting_approval");

    await reportFor(HALF_MINUTE, [paperless]);
    const settled = await detail(incident.id);
    const outcome = "tika is no longer on Alder (removed or replaced): nothing is left to decide.";
    expect(settled).toMatchObject({ status: "resolved", verdict: "no longer needed", outcome });
    expect(settled.trace.at(-1)?.kind).toBe("no_longer_needed");
    expect(cleared).toEqual([["Alder", "tika", outcome]]);
  });

  it("settles every one in a pass while no alert can be queued", async () => {
    reconciler = new IncidentReconciler({
      incidents: controlPlane.services.incidentsService,
      inventory: controlPlane.services.inventoryService,
      notifier: controlPlane.services.notifier,
      clock: () => controlPlane.clock.now,
    });
    const waiting = [escalate(), escalate()];
    fillNotificationQueue(controlPlane.services.databaseHandle, controlPlane.clock.now);
    await reportFor(INCIDENT_CLEAR_MILLISECONDS + HALF_MINUTE, [paperless]);
    expect(await Promise.all(waiting.map(async ({ id }) => (await detail(id)).status))).toEqual([
      "resolved",
      "resolved",
    ]);
    expect(controlPlane.services.notificationDeliveries.rules().overflowCount).toBe(2);
  });

  it("waits while it is down or failing its health check, and starts over when Docker restarts it", async () => {
    const incident = escalate();
    await reportFor(5 * MINUTE, [containerSnapshot({ name: "tika", state: "exited", exitCode: 1, health: "none" })]);
    await reportFor(5 * MINUTE, [containerSnapshot({ name: "tika", health: "unhealthy" })]);
    await reportFor(MINUTE, [containerSnapshot({ name: "tika" })]);
    const restartedAt = controlPlane.clock.now;
    await reportFor(INCIDENT_CLEAR_MILLISECONDS - HALF_MINUTE, [
      containerSnapshot({ name: "tika", startedAt: restartedAt }),
    ]);
    expect((await detail(incident.id)).status).toBe("awaiting_approval");

    await reportFor(HALF_MINUTE, [containerSnapshot({ name: "tika", startedAt: restartedAt })]);
    expect(await detail(incident.id)).toMatchObject({
      status: "resolved",
      outcome: "tika is running again: nothing is left to decide.",
    });
    expect(cleared).toHaveLength(1);
  });

  it("goes only by reports sent since the escalation, from a host still reporting", async () => {
    await reportFor(HALF_MINUTE, [paperless]);
    later(1);
    const incident = escalate();
    later(INCIDENT_CLEAR_MILLISECONDS);
    await reconciler.run();
    expect((await detail(incident.id)).status).toBe("awaiting_approval");

    // Gone, then the host falls silent before the two minutes are up: nothing is settled from old news.
    await reportFor(MINUTE, [paperless]);
    later(HOST_SILENT_AFTER_MILLISECONDS + 1);
    await reconciler.run();
    expect((await detail(incident.id)).status).toBe("awaiting_approval");
    expect(cleared).toEqual([]);
  });

  describe("a repair whose runner never said how it ended", () => {
    const decide = () => {
      const host = controlPlane.services.databaseHandle.database.select().from(hosts).get()!;
      return controlPlane.services.incidentsService.create(
        host,
        submission(controlPlane.clock.now),
        INCIDENT_STATUS.decided,
      );
    };
    const down = containerSnapshot({ name: "tika", state: "exited" });
    const running = containerSnapshot({ name: "tika" });

    it("stays with the runner until the limit, then waits for a person while its container is down", async () => {
      const incident = decide();
      await reportFor(INCIDENT_OUTCOME_LOST_MILLISECONDS - HALF_MINUTE, [down]);
      expect((await detail(incident.id)).status).toBe("decided");

      await reportFor(HALF_MINUTE + INCIDENT_CLEAR_MILLISECONDS * 2, [down]);
      expect(await detail(incident.id)).toMatchObject({
        status: "awaiting_approval",
        outcome: INCIDENT_OUTCOME_LOST,
      });
      expect((await detail(incident.id)).trace.at(-1)?.kind).toBe("outcome_lost");
      expect(cleared).toEqual([]);
    });

    it("settles by itself when its container is fine", async () => {
      const incident = decide();
      await reportFor(INCIDENT_OUTCOME_LOST_MILLISECONDS + INCIDENT_CLEAR_MILLISECONDS + MINUTE, [running]);
      expect(await detail(incident.id)).toMatchObject({
        status: "resolved",
        outcome: "tika is running again: nothing is left to decide.",
      });
    });

    it("is left alone while its host is silent, and a late report still settles it", async () => {
      const incident = decide();
      later(INCIDENT_OUTCOME_LOST_MILLISECONDS);
      await reconciler.run();
      expect((await detail(incident.id)).status).toBe("decided");

      await reportFor(HALF_MINUTE, [down]);
      expect((await detail(incident.id)).status).toBe("awaiting_approval");
      const host = controlPlane.services.databaseHandle.database.select().from(hosts).get()!;
      controlPlane.services.incidentsService.recordOutcome(host, incident.id, {
        verdict: "restarted",
        outcome: "Restarted tika.",
        executed: true,
      });
      expect((await detail(incident.id)).status).toBe("resolved");
    });
  });

  it("leaves a person's decision made meanwhile as it is", () => {
    const incident = escalate();
    controlPlane.services.incidentsService.update(incident.id, { status: INCIDENT_STATUS.dismissed });
    expect(controlPlane.services.incidentsService.settleUnneeded(incident.id, "nothing is left")).toBeNull();
    expect(controlPlane.services.incidentsService.find(incident.id).status).toBe("dismissed");
  });
});
