import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_ROUTES, apiPath, CSRF_HEADER, type EnrolledHostView } from "../../shared/api.js";
import type { DiagnosticBundle, DiagnosticPreview } from "../../shared/diagnostics.js";
import { DIAGNOSTIC_TTL_MILLISECONDS } from "../../shared/diagnostics.js";
import { INCIDENT_STATUS } from "../../shared/constants.js";
import { sha256Hex } from "../../shared/hash.js";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestControlPlane,
  type TestClient,
} from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";

const SECRET = "opaque-synthetic-support-secret";
describe("authenticated incident diagnostic exports", () => {
  let plane: TestControlPlane;
  let admin: TestClient;
  let incidentId: string;
  const previewPath = () => apiPath(API_ROUTES.diagnosticsPreview, { incidentId });
  const downloadPath = (previewId: string) => apiPath(API_ROUTES.diagnosticsDownload, { incidentId, previewId });
  beforeEach(async () => {
    plane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(plane)).client;
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Lab" })).json<EnrolledHostView>();
    const host = plane.services.hostsService.authenticate(runnerTokenOf(enrolled))!;
    incidentId = plane.services.incidentsService.create(
      host,
      {
        detectedAt: plane.clock.now,
        report: {
          containerName: "db",
          image: "postgres:16",
          trigger: "die",
          stateSummary: "status=exited",
          healthOutputs: [SECRET],
          knownContainers: ["db"],
          protectedContainers: [],
          logs: SECRET,
        },
      },
      INCIDENT_STATUS.resolved,
    ).id;
  });
  afterEach(async () => {
    await plane.app.close();
    await plane.runnerApp.close();
  });
  it("preserves incident read access, authenticates both actions and binds the stream to its requesting session", async () => {
    expect((await plane.client().post(previewPath(), { sections: ["facts"] })).statusCode).toBe(401);
    expect(
      (
        await admin.request({
          method: "POST",
          url: previewPath(),
          payload: { sections: ["facts"] },
          headers: { [CSRF_HEADER]: "invalid" },
        })
      ).statusCode,
    ).toBe(403);
    const viewer = (await fullySignedInUser(plane, admin, "observer", "viewer")).client;
    expect((await viewer.get(apiPath(API_ROUTES.incident, { incidentId }))).statusCode).toBe(200);
    const response = await viewer.post(previewPath(), { sections: ["trace", "facts", "usage"] });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain(SECRET);
    const preview = response.json<DiagnosticPreview>();
    expect((await admin.post(downloadPath(preview.id))).statusCode).toBe(404);
    const download = await viewer.post(downloadPath(preview.id));
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toContain(`autoheal-diagnostics-${preview.id}.json`);
    expect(download.headers["cache-control"]).toBe("no-store");
    expect(download.body).not.toContain(SECRET);
    const bundle = download.json<DiagnosticBundle>();
    expect(bundle.manifest.sha256).toBe(sha256Hex(JSON.stringify(bundle.evidence)));
    expect(Buffer.byteLength(download.body)).toBe(preview.byteLength);
    expect((await viewer.post(downloadPath(preview.id))).statusCode).toBe(404);
    const audit = plane.stdout.filter((line) => line.includes("diagnostics.exported"));
    expect(audit).toHaveLength(1);
    expect(audit.join("")).not.toContain(SECRET);
  });
  it("rejects stale or invalid previews and clears outstanding exports during restore maintenance", async () => {
    expect((await admin.post(previewPath(), { sections: ["environment"] })).statusCode).toBe(400);
    expect((await admin.post(previewPath(), { sections: ["facts", "facts"] })).statusCode).toBe(400);
    const preview = (await admin.post(previewPath(), { sections: ["facts"] })).json<DiagnosticPreview>();
    plane.clock.now += DIAGNOSTIC_TTL_MILLISECONDS;
    expect((await admin.post(downloadPath(preview.id))).json()).toEqual({ error: "diagnostics_expired" });
    const fresh = (await admin.post(previewPath(), { sections: ["facts"] })).json<DiagnosticPreview>();
    plane.services.diagnostics.reset();
    expect((await admin.post(downloadPath(fresh.id))).statusCode).toBe(404);
  });
});
