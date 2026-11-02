import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestClient, type TestControlPlane } from "../../test/support/control-plane.js";
import { fullySignedInAdmin } from "../../test/support/second-factor.js";
import { API_ROUTES, apiPath, type IncidentDetailView } from "../shared/api.js";
import type { IncidentSubmission } from "../shared/protocol.js";
import { hosts, replayRuns, users } from "./database/schema.js";

const submission: IncidentSubmission = {
  detectedAt: Date.UTC(2026, 9, 20, 11, 59),
  report: {
    containerName: "paperless",
    image: "paperless:2",
    trigger: "die",
    stateSummary: "status=exited",
    healthOutputs: [],
    knownContainers: ["paperless"],
    protectedContainers: [],
    logs: "error",
  },
};

describe("recovering from a control-plane restart", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
    await admin.post(API_ROUTES.hosts, { label: "HP" });
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  it("cancels incidents that were left mid-decision, and says why in their trace", async () => {
    const host = controlPlane.services.databaseHandle.database.select().from(hosts).get()!;
    const stuck = controlPlane.services.incidentsService.create(host, submission, "deciding");
    const settled = controlPlane.services.incidentsService.create(host, submission, "resolved");

    expect(controlPlane.services.incidentsService.cancelInterrupted()).toBe(1);

    const detail = (await admin.get(apiPath(API_ROUTES.incident, { incidentId: stuck.id }))).json<IncidentDetailView>();
    expect(detail.status).toBe("cancelled");
    expect(detail.trace.map((event) => event.kind)).toEqual(["reported", "control_plane_restarted"]);
    expect(controlPlane.services.incidentsService.find(settled.id).status).toBe("resolved");
  });

  it("closes replays that have no process behind them any more", () => {
    const database = controlPlane.services.databaseHandle.database;
    const adminRow = database.select().from(users).get()!;
    database
      .insert(replayRuns)
      .values({
        id: randomUUID(),
        createdBy: adminRow.id,
        createdAt: controlPlane.clock.now,
        status: "running",
        modelName: "qwen3:4b-instruct",
        incidentCount: 3,
      })
      .run();
    expect(controlPlane.services.replayService.finishInterrupted()).toBe(1);
    expect(database.select().from(replayRuns).where(eq(replayRuns.status, "running")).all()).toEqual([]);
    expect(controlPlane.services.replayService.list()[0]).toMatchObject({ status: "finished" });
  });
});
