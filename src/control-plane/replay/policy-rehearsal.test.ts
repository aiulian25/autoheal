import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_ROUTES, apiPath, type EnrolledHostView, type HostControlView } from "../../shared/api.js";
import { RUNNER_ROUTES } from "../../shared/protocol.js";
import type { PolicyRehearsalContext, PolicyRehearsalResult } from "../../shared/recovery-policy-simulator.js";
import { incidents, jobs, workItems, containerControls, hosts } from "../database/schema.js";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestControlPlane,
  type TestClient,
} from "../../../test/support/control-plane.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { containerSnapshot, heartbeatWith } from "../../../test/support/inventory.js";

describe("deterministic recovery policy rehearsal API", () => {
  let plane: TestControlPlane;
  let admin: TestClient;
  let hostId: string;
  const controlPath = () => apiPath(API_ROUTES.hostControl, { hostId });
  const run = (source: "synthetic" | "history" = "synthetic", extra = {}) =>
    admin.post(API_ROUTES.policyRehearsal, {
      hostId,
      source,
      proposedRestartDefault: "restart",
      ...(source === "synthetic" ? { events: [{ kind: "failure", at: plane.clock.now, name: "app" }] } : {}),
      ...extra,
    });
  beforeEach(async () => {
    plane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(plane)).client;
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Rehearsal-lab" })).json<EnrolledHostView>();
    hostId = enrolled.host.id;
    await plane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      headers: { authorization: `Bearer ${runnerTokenOf(enrolled)}` },
      payload: {
        ...heartbeatWith({
          dryRun: false,
          protectedContainers: ["protected"],
          containers: [
            containerSnapshot({ name: "app" }),
            containerSnapshot({ name: "override" }),
            containerSnapshot({ name: "protected" }),
          ],
        }),
        maintenanceGeneration: 0,
      },
    });
    await admin.put(apiPath(API_ROUTES.containerControls, { hostId }), { names: ["override"], restart: "tell" });
  });
  afterEach(async () => {
    await plane.app.close();
    await plane.runnerApp.close();
  });
  it("compares a proposed default without model/work/policy mutations and preserves explicit/locked controls", async () => {
    const context = (
      await admin.get(apiPath(API_ROUTES.policyRehearsalContext, { hostId }))
    ).json<PolicyRehearsalContext>();
    expect(context.containers.find(({ name }) => name === "override")).toMatchObject({
      inherited: false,
      restart: "tell",
    });
    const before = plane.services.databaseHandle.sqlite.prepare("SELECT total_changes() AS count").get();
    const response = await run();
    expect(response.statusCode).toBe(200);
    const result = response.json<PolicyRehearsalResult>();
    expect(result.current.decisions[0]?.reason).toBe("policy-ask");
    expect(result.proposed.decisions[0]?.reason).toBe("allowed");
    expect(result.change.containers).toEqual([{ name: "app", before: "ask", after: "restart" }]);
    expect(plane.services.databaseHandle.sqlite.prepare("SELECT total_changes() AS count").get()).toEqual(before);
    expect(plane.services.databaseHandle.database.select().from(jobs).all()).toEqual([]);
    expect(plane.services.databaseHandle.database.select().from(workItems).all()).toEqual([]);
    expect((await admin.get(controlPath())).json<HostControlView>().restartDefault).toBe("ask");
  });
  it("requires normal administrator authorization and bounds the request before simulation", async () => {
    const viewer = (await fullySignedInUser(plane, admin, "viewer", "viewer")).client;
    expect((await viewer.get(apiPath(API_ROUTES.policyRehearsalContext, { hostId }))).statusCode).toBe(200);
    expect(
      (await viewer.post(API_ROUTES.policyRehearsal, { hostId, source: "history", proposedRestartDefault: "restart" }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await run("synthetic", {
          events: Array.from({ length: 501 }, () => ({ kind: "failure", at: plane.clock.now, name: "app" })),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await run("synthetic", {
          events: [
            { kind: "failure", at: plane.clock.now, name: "app" },
            { kind: "failure", at: plane.clock.now + 8 * 86_400_000, name: "app" },
          ],
        })
      ).statusCode,
    ).toBe(400);
    expect((await admin.get(apiPath(API_ROUTES.policyRehearsalContext, { hostId: randomUUID() }))).statusCode).toBe(
      404,
    );
  });
  it("caps captured historical evidence and clearly states incomplete temporal-state assumptions", async () => {
    plane.services.databaseHandle.database
      .insert(incidents)
      .values(
        Array.from({ length: 501 }, (_, index) => ({
          id: randomUUID(),
          hostId,
          containerName: "app",
          image: "example:1",
          triggerEvent: "die" as const,
          status: "resolved" as const,
          detectedAt: plane.clock.now - index * 1000,
          createdAt: plane.clock.now - index * 1000,
          updatedAt: plane.clock.now,
        })),
      )
      .run();
    const response = await run("history");
    expect(response.statusCode).toBe(200);
    const result = response.json<PolicyRehearsalResult>();
    expect(result.evidence.incidentIds).toHaveLength(500);
    expect(result.proposed.decisions).toHaveLength(500);
    expect(result.evidence.assumptions.join(" ")).toContain("not an authoritative reconstruction");
    expect((await admin.get(controlPath())).json<HostControlView>().restartDefault).toBe("ask");
  });
  it("preserves configured protections and explicit rules for names absent from current inventory", async () => {
    plane.services.databaseHandle.database
      .update(hosts)
      .set({ protectedContainersJson: JSON.stringify(["protected", "future-protected"]) })
      .where(eq(hosts.id, hostId))
      .run();
    plane.services.databaseHandle.database
      .insert(containerControls)
      .values({
        hostId,
        containerName: "retired",
        restartChoice: "tell",
        updateChoice: "ask",
        changedAt: plane.clock.now,
      })
      .run();
    const result = (
      await run("synthetic", {
        events: [
          { kind: "failure", at: plane.clock.now, name: "future-protected" },
          { kind: "failure", at: plane.clock.now, name: "retired" },
        ],
      })
    ).json<PolicyRehearsalResult>();
    expect(result.proposed.decisions.map(({ reason }) => reason)).toEqual(["protected", "policy-tell"]);
  });
  it("reuses retained maintenance policy and does not turn a rehearsal into a maintenance bypass", async () => {
    const created = await admin.post(apiPath(API_ROUTES.hostMaintenance, { hostId }), {
      containerName: "app",
      reason: "fixture",
      expiresAt: plane.clock.now + 60_000,
    });
    expect(created.statusCode).toBe(200);
    const result = (await run()).json<PolicyRehearsalResult>();
    expect(result.current.decisions[0]?.reason).toBe("maintenance");
    expect(result.proposed.decisions[0]?.reason).toBe("maintenance");
  });
});
