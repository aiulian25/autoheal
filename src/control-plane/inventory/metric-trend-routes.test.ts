import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_ROUTES, apiPath, type EnrolledHostView } from "../../shared/api.js";
import { TREND } from "../../shared/metric-trends.js";
import { RUNNER_ROUTES } from "../../shared/protocol.js";
import { decodeJoinCode } from "../../shared/join-code.js";
import { metricAnomalies, metricSeries, metricRollups } from "./metric-rollups-schema.js";
import { jobs, workItems } from "../database/schema.js";
import { startTestControlPlane, type TestControlPlane, type TestClient } from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { heartbeatWith, hostHealth, hostMetrics } from "../../../test/support/inventory.js";
describe("metric trend read and review API", () => {
  let plane: TestControlPlane, admin: TestClient, hostId: string, anomalyId: string;
  beforeEach(async () => {
    plane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(plane)).client;
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Trend-lab" })).json<EnrolledHostView>();
    hostId = enrolled.host.id;
    await plane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      headers: { authorization: `Bearer ${decodeJoinCode(enrolled.joinCode)!.token}` },
      payload: heartbeatWith({ host: hostHealth({ bootId: "12345678-1234-1234-1234-123456789abc" }) }),
    });
    plane.services.metricsStore.record(hostId, { host: hostMetrics(), containers: [] });
    plane.services.metricRollups.flush();
    const series = plane.services.databaseHandle.database.select().from(metricSeries).get()!;
    anomalyId = randomUUID();
    plane.services.databaseHandle.database
      .insert(metricAnomalies)
      .values({
        id: anomalyId,
        seriesId: series.id,
        metric: "cpu",
        identity: series.identity,
        state: "active",
        observedAt: plane.clock.now,
        baseline: 10,
        mad: 1,
        threshold: 25,
        observed: 60,
        baselineBuckets: 24,
        baselineSamples: 1440,
        recentSamples: 180,
        pattern: "elevated",
      })
      .run();
  });
  afterEach(async () => {
    await plane.app.close();
    await plane.runnerApp.close();
    plane.services.databaseHandle.close();
  });
  it("allows ordinary authenticated reads but reserves feedback for an administrator", async () => {
    const viewer = (await fullySignedInUser(plane, admin, "viewer", "viewer")).client;
    const read = await viewer.get(apiPath(API_ROUTES.hostTrends, { hostId }));
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ hostId, status: "learning", retention: TREND.retention });
    expect((await viewer.get(`${API_ROUTES.metricAnomalies}?hostId=${hostId}`)).json()).toHaveLength(1);
    const path = apiPath(API_ROUTES.metricAnomalyFeedback, { anomalyId });
    expect((await viewer.post(path, { observedAt: plane.clock.now, assessment: "useful" })).statusCode).toBe(403);
    expect((await admin.post(path, { observedAt: plane.clock.now - 1, assessment: "useful" })).statusCode).toBe(409);
    expect((await admin.post(path, { observedAt: plane.clock.now, assessment: "expected" })).statusCode).toBe(200);
    expect((await admin.post(path, { observedAt: plane.clock.now, assessment: "restart" })).statusCode).toBe(400);
    expect(
      (
        await admin.post(apiPath(API_ROUTES.metricAnomalyFeedback, { anomalyId: randomUUID() }), {
          observedAt: plane.clock.now,
          assessment: "useful",
        })
      ).statusCode,
    ).toBe(404);
    expect(plane.services.databaseHandle.database.select().from(jobs).all()).toEqual([]);
    expect(plane.services.databaseHandle.database.select().from(workItems).all()).toEqual([]);
  });
  it("keeps retention data separate from normal incident evidence and refuses anonymous access", async () => {
    const anonymous = plane.client();
    expect((await anonymous.get(apiPath(API_ROUTES.hostTrends, { hostId }))).statusCode).toBe(401);
    expect(await admin.get(apiPath(API_ROUTES.hostTrends, { hostId: randomUUID() }))).toMatchObject({
      statusCode: 404,
    });
    expect(plane.services.databaseHandle.database.select().from(metricRollups).all()).toHaveLength(1);
  });
});
