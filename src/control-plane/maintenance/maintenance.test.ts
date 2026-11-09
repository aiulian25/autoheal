import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseHandle } from "../database/connection.js";
import { AuditLog } from "../audit/audit-log.js";
import { MaintenanceService } from "./maintenance-service.js";
import { eq } from "drizzle-orm";
import { hosts, users, maintenanceWindows } from "../database/schema.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_ROUTES, apiPath, type EnrolledHostView } from "../../shared/api.js";
import { RUNNER_ROUTES } from "../../shared/protocol.js";
import { MAINTENANCE_MAX_MILLISECONDS, type MaintenanceView } from "../../shared/maintenance.js";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestControlPlane,
  type TestClient,
} from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { heartbeatWith } from "../../../test/support/inventory.js";
import { AGENT_AUTOHEAL, JOB_ACTION } from "../../shared/constants.js";

describe("maintenance windows", () => {
  let plane: TestControlPlane;
  let admin: TestClient;
  let host: EnrolledHostView;
  const route = () => apiPath(API_ROUTES.hostMaintenance, { hostId: host.host.id });
  const create = (containerName: string | null = null, expiresAt = plane.clock.now + 60_000) =>
    admin.post(route(), { containerName, reason: "Planned database service", expiresAt });
  const heartbeat = (supported = true, generation = 0) =>
    plane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      headers: { authorization: `Bearer ${runnerTokenOf(host)}` },
      payload: { ...heartbeatWith(), ...(supported ? { maintenanceGeneration: generation } : {}) },
    });
  beforeEach(async () => {
    plane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(plane)).client;
    host = (await admin.post(API_ROUTES.hosts, { label: "Lab" })).json<EnrolledHostView>();
  });
  afterEach(async () => {
    await plane.app.close();
    await plane.runnerApp.close();
  });
  it("requires supported runners and authorized actors; persists scoped windows, expiry, extension and cancellation", async () => {
    expect((await create()).statusCode).toBe(409);
    await heartbeat();
    const viewer = (await fullySignedInUser(plane, admin, "observer", "viewer")).client;
    expect(
      (await viewer.post(route(), { containerName: null, reason: "No", expiresAt: plane.clock.now + 1000 })).statusCode,
    ).toBe(403);
    const created = await create("paperless");
    expect(created.statusCode).toBe(200);
    const view = created.json<MaintenanceView>();
    expect(view.windows[0]).toMatchObject({
      owner: "admin",
      containerName: "paperless",
      reason: "Planned database service",
    });
    expect(plane.services.maintenance.held(host.host.id, "paperless")).toBe(true);
    expect(plane.services.maintenance.held(host.host.id, "other")).toBe(false);
    const policy = (await heartbeat()).json().control.maintenance;
    expect(policy).toMatchObject({ generation: view.generation, observedAt: plane.clock.now });
    const item = apiPath(API_ROUTES.maintenanceWindow, { hostId: host.host.id, maintenanceId: view.windows[0]!.id });
    expect((await admin.patch(item, { expiresAt: plane.clock.now + 120_000 })).statusCode).toBe(200);
    expect((await create(null, plane.clock.now + MAINTENANCE_MAX_MILLISECONDS + 1)).statusCode).toBe(400);
    expect((await admin.delete(item)).statusCode).toBe(200);
    expect(plane.services.maintenance.view().windows).toEqual([]);
    const audit = plane.stdout.join("\n");
    expect(audit).toContain("maintenance.created");
    expect(audit).toContain("maintenance.extended");
    expect(audit).toContain("maintenance.cancelled");
    expect(audit).not.toContain("Planned database service");
    await create();
    plane.clock.now += 60_000;
    expect(plane.services.maintenance.view().windows).toEqual([]);
    expect(plane.services.maintenance.held(host.host.id, "paperless")).toBe(false);
  });
  it("survives service/database reconstruction, bounds capacity and keeps suppression during a backwards clock change", async () => {
    await heartbeat();
    await create("paperless");
    const saved = plane.services.maintenance.view();
    const directory = mkdtempSync(join(tmpdir(), "autoheal-maintenance-"));
    const path = join(directory, "copy.sqlite");
    await plane.services.databaseHandle.sqlite.backup(path);
    const reopened = new DatabaseHandle(path);
    try {
      const service = new MaintenanceService(reopened, new AuditLog(reopened, () => {}), () => plane.clock.now);
      expect(service.view().windows).toEqual(saved.windows);
      plane.clock.now -= 60_000;
      expect(service.held(host.host.id, "paperless")).toBe(true);
      plane.clock.now += 120_000;
      expect(service.held(host.host.id, "paperless")).toBe(false);
    } finally {
      reopened.close();
      rmSync(directory, { recursive: true, force: true });
    }
    plane.services.databaseHandle.database
      .insert(maintenanceWindows)
      .values(
        Array.from({ length: 128 }, (_, index) => ({
          id: `capacity-${index}`,
          hostId: host.host.id,
          containerName: null,
          owner: "admin",
          reason: "fixture",
          startsAt: plane.clock.now,
          expiresAt: plane.clock.now + 60_000,
        })),
      )
      .run();
    expect((await create()).statusCode).toBe(409);
  });
  it("blocks automatic dispatch while retaining telemetry and permits explicit manual work", async () => {
    await heartbeat();
    const actor = { kind: "agent", agent: AGENT_AUTOHEAL } as const;
    const job = plane.services.jobsService.request(actor, host.host.id, "paperless", JOB_ACTION.checkUpdates, null);
    await create();
    expect(() => plane.services.jobsService.request(actor, host.host.id, "", JOB_ACTION.pruneImages, null)).toThrow(
      "maintenance_active",
    );
    const hostRow = plane.services.databaseHandle.database
      .select()
      .from(hosts)
      .where(eq(hosts.id, host.host.id))
      .get()!;
    expect(plane.services.jobsService.take(hostRow)).toEqual([]);
    const adminId = plane.services.databaseHandle.database.select().from(users).get()!.id;
    const manual = plane.services.jobsService.request(
      { kind: "user", actor: { userId: adminId, username: "admin", ip: "127.0.0.1", requestId: "fixture" } },
      host.host.id,
      "paperless",
      JOB_ACTION.logs,
      null,
    );
    expect(plane.services.jobsService.take(hostRow)).toEqual([expect.objectContaining({ id: manual.id })]);
    expect((await heartbeat()).statusCode).toBe(200);
    plane.clock.now += 60_000;
    expect(plane.services.jobsService.take(hostRow)).toEqual([
      expect.objectContaining({ id: job.id, automatic: true }),
    ]);
  });
});
