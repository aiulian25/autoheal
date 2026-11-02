import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { heartbeatWith, hostHealth } from "../../../test/support/inventory.js";
import { fullySignedInAdmin, fullySignedInUser } from "../../../test/support/second-factor.js";
import { API_ROUTES, apiPath, type EnrolledHostView, type TaskSummaryView } from "../../shared/api.js";
import { HOST_KIND, HTTP_HEADERS, JOB_ACTION, RUNNER_CAPABILITIES } from "../../shared/constants.js";
import { RUNNER_ROUTES, type PackageFacts, type WorkResponse } from "../../shared/protocol.js";
import type { ProbeView } from "../../shared/probes.js";
import {
  REBOOT_PLAN_ROUTES,
  REBOOT_PLAN_TEXT,
  type RebootPlanBody,
  type RebootPlanPreview,
  type RebootPlanView,
} from "../../shared/reboot-plans.js";
import { hosts, jobs } from "../database/schema.js";
import { serviceProbes } from "../probes/probe-schema.js";

const bootId = (host: number, boot: number) =>
  `${String(host).padStart(8, "0")}-0000-4000-8000-${String(boot).padStart(12, "0")}`;
const LABELS = ["One", "Two", "Three"];
const PACKAGES: PackageFacts = {
  setting: "check",
  unsupported: null,
  unattendedUpgrades: false,
  rebootPackages: [],
  kernelWaiting: null,
  timeZone: "Europe/Lisbon",
  recentChanges: [],
};
const MINUTE = 60_000;

interface Fixture {
  plane: TestControlPlane;
  admin: TestClient;
  tokens: string[];
  ids: string[];
  boots: number[];
}

async function fixture(databasePath?: string): Promise<Fixture> {
  const plane = await startTestControlPlane(databasePath === undefined ? {} : { databasePath });
  const admin = (await fullySignedInAdmin(plane)).client;
  const tokens: string[] = [];
  const ids: string[] = [];
  for (const label of LABELS) {
    const enrolled = (await admin.post(API_ROUTES.hosts, { label })).json<EnrolledHostView>();
    tokens.push(runnerTokenOf(enrolled));
    ids.push(enrolled.host.id);
  }
  return { plane, admin, tokens, ids, boots: [1, 1, 1] };
}

describe("a plan of reboots across three hosts", () => {
  let world: Fixture;
  const runner = (index: number, method: "GET" | "POST", url: string, payload?: object) =>
    world.plane.runnerApp.inject({
      method,
      url,
      payload,
      headers: {
        authorization: `Bearer ${world.tokens[index]!}`,
        [HTTP_HEADERS.runnerCapabilities]: RUNNER_CAPABILITIES,
      },
    });
  const report = async (index: number) => {
    const boot = bootId(index, world.boots[index]!);
    const response = await runner(index, "POST", RUNNER_ROUTES.heartbeat, {
      ...heartbeatWith({ dryRun: false, containers: [], host: hostHealth({ bootId: boot, packages: PACKAGES }) }),
      eventStreamConnected: true,
    });
    expect(response.statusCode, response.body).toBe(200);
  };
  const reportAll = async (except: number[] = []) => {
    for (const index of [0, 1, 2]) if (!except.includes(index)) await report(index);
  };
  const later = (milliseconds: number) => {
    world.plane.clock.now += milliseconds;
  };
  const take = async (index: number) =>
    (await runner(index, "GET", RUNNER_ROUTES.work))
      .json<WorkResponse>()
      .jobs.filter(({ action }) => action === "reboot");
  const rebootJobs = () =>
    world.plane.services.databaseHandle.database.select().from(jobs).where(eq(jobs.action, JOB_ACTION.reboot)).all();
  const bodyWith = (change: Partial<RebootPlanBody> = {}): RebootPlanBody => ({
    name: "Kernel updates",
    hostIds: world.ids,
    minimumHealthy: 2,
    probeIds: [],
    returnMinutes: 10,
    notBefore: null,
    notAfter: null,
    ...change,
  });
  const approve = async (change: Partial<RebootPlanBody> = {}) => {
    const response = await world.admin.post(REBOOT_PLAN_ROUTES.plans, bodyWith(change));
    expect(response.statusCode, response.body).toBe(200);
    return response.json<RebootPlanView>();
  };
  const plan = async () => (await world.admin.get(REBOOT_PLAN_ROUTES.plans)).json<RebootPlanView[]>()[0]!;
  const tick = () => world.plane.services.rebootPlans.tick();
  const statuses = async () => (await plan()).steps.map(({ status }) => status);
  // The host goes down, and comes back on a new boot.
  const rebootAndReturn = async (index: number) => {
    expect((await take(index)).length).toBe(1);
    later(20_000);
    world.boots[index]! += 1;
    await reportAll();
    tick();
  };

  beforeEach(async () => {
    world = await fixture();
    await reportAll();
  });
  afterEach(async () => {
    await world.plane.app.close();
    await world.plane.runnerApp.close();
  });

  it("is for admins", async () => {
    const viewer = await fullySignedInUser(world.plane, world.admin, "operator", "viewer");
    await reportAll();
    expect((await viewer.client.get(REBOOT_PLAN_ROUTES.plans)).statusCode).toBe(403);
    expect((await viewer.client.post(REBOOT_PLAN_ROUTES.plans, bodyWith())).statusCode).toBe(403);
    expect((await viewer.client.post(REBOOT_PLAN_ROUTES.preview, bodyWith())).statusCode).toBe(403);
  });

  it("refuses a minimum that could not hold, and repeated members", async () => {
    expect((await world.admin.post(REBOOT_PLAN_ROUTES.plans, bodyWith({ minimumHealthy: 3 }))).statusCode).toBe(400);
    expect((await world.admin.post(REBOOT_PLAN_ROUTES.plans, bodyWith({ minimumHealthy: 0 }))).statusCode).toBe(400);
    const twice = bodyWith({ hostIds: [world.ids[0]!, world.ids[0]!] });
    expect((await world.admin.post(REBOOT_PLAN_ROUTES.plans, twice)).statusCode).toBe(400);
  });

  it("refuses the machine it runs on", async () => {
    world.plane.services.databaseHandle.database
      .update(hosts)
      .set({ kind: HOST_KIND.local })
      .where(eq(hosts.id, world.ids[1]!))
      .run();
    expect((await world.admin.post(REBOOT_PLAN_ROUTES.preview, bodyWith())).statusCode).toBe(409);
    expect((await world.admin.post(REBOOT_PLAN_ROUTES.plans, bodyWith())).statusCode).toBe(409);
    expect(rebootJobs()).toEqual([]);
  });

  it("previews health, what is waiting and the order, changing nothing", async () => {
    const response = await world.admin.post(
      REBOOT_PLAN_ROUTES.preview,
      bodyWith({ hostIds: [...world.ids].reverse() }),
    );
    const preview = response.json<RebootPlanPreview>();
    expect(preview.hosts.map(({ label }) => label)).toEqual(["Three", "Two", "One"]);
    expect(preview.hosts.every(({ problem, openJobs }) => problem === null && openJobs === 0)).toBe(true);
    expect(preview.problem).toBeNull();
    expect(rebootJobs()).toEqual([]);
    expect((await world.admin.get(REBOOT_PLAN_ROUTES.plans)).json()).toEqual([]);
  });

  it("previews why it would not start, and will not start then", async () => {
    later(2 * MINUTE);
    await reportAll([1, 2]);
    const preview = (await world.admin.post(REBOOT_PLAN_ROUTES.preview, bodyWith())).json<RebootPlanPreview>();
    expect(preview.problem).toBe(REBOOT_PLAN_TEXT.tooFew(0, 2, "One"));
    expect((await world.admin.post(REBOOT_PLAN_ROUTES.plans, bodyWith())).statusCode).toBe(409);
    expect(rebootJobs()).toEqual([]);
  });

  it("reboots one at a time in order, each only with the others healthy, and finishes", async () => {
    const shape = bodyWith({ hostIds: [world.ids[2]!, world.ids[0]!, world.ids[1]!] });
    await approve(shape);
    const order = [2, 0, 1];
    for (const [position, index] of order.entries()) {
      // Only this one reboot exists for this step, however often it ticks.
      tick();
      tick();
      expect(rebootJobs()).toHaveLength(position + 1);
      await rebootAndReturn(index);
      expect((await plan()).steps[position]!.status).toBe("done");
      tick();
    }
    tick();
    const finished = await plan();
    expect(finished.status).toBe("completed");
    expect(finished.body).toEqual(shape);
    expect(rebootJobs()).toHaveLength(3);
  });

  it("never goes below the minimum: a silent host stops the next reboot before it is asked", async () => {
    await approve();
    await rebootAndReturn(0);
    expect(await statuses()).toEqual(["done", "waiting", "waiting"]);
    later(2 * MINUTE);
    // Three has gone quiet: with Two down too, only One would be left.
    await reportAll([2]);
    tick();
    const paused = await plan();
    expect(paused.status).toBe("paused");
    expect(paused.reason).toBe(REBOOT_PLAN_TEXT.tooFew(1, 2, "Two"));
    expect(rebootJobs()).toHaveLength(1);
    tick();
    expect(rebootJobs()).toHaveLength(1);

    await reportAll();
    expect((await world.admin.post(apiPath(REBOOT_PLAN_ROUTES.resume, { planId: paused.id }))).statusCode).toBe(200);
    expect(rebootJobs()).toHaveLength(2);
  });

  it("holds the minimum at every moment across the whole plan", async () => {
    await approve();
    const members = [0, 1, 2];
    const down = new Set<number>();
    let lowestHealthy = members.length;
    for (let turn = 0; turn < 60 && (await plan()).status === "running"; turn += 1) {
      // Each host takes whatever it was asked for; one that takes a reboot goes down at once.
      for (const index of members) if (!down.has(index) && (await take(index)).length > 0) down.add(index);
      lowestHealthy = Math.min(lowestHealthy, members.length - down.size);
      later(20_000);
      await reportAll([...down]);
      tick();
      // It stays down for three turns while ticks keep trying, then comes back on a new boot.
      if (turn % 4 === 3) {
        for (const index of down) world.boots[index]! += 1;
        down.clear();
        await reportAll();
        tick();
      }
    }
    expect((await plan()).status).toBe("completed");
    expect(rebootJobs()).toHaveLength(3);
    expect(lowestHealthy).toBe(2);
  });

  it("does not reboot a host that has itself gone quiet, however many others are up", async () => {
    await approve({ minimumHealthy: 1 });
    await rebootAndReturn(0);
    later(2 * MINUTE);
    await reportAll([1]);
    tick();
    expect(await plan()).toMatchObject({ status: "paused", reason: REBOOT_PLAN_TEXT.notFresh("Two") });
    expect(rebootJobs()).toHaveLength(1);
  });

  it("does not count a host someone else is rebooting as healthy, though it still reports", async () => {
    await approve({ notBefore: world.plane.clock.now + MINUTE });
    const asked = await world.admin.post(apiPath(API_ROUTES.hostActions, { hostId: world.ids[2]! }), {
      action: "reboot",
    });
    expect(asked.statusCode, asked.body).toBe(200);
    await take(2);
    later(2 * MINUTE);
    await reportAll();
    tick();
    expect(await plan()).toMatchObject({ status: "paused", reason: REBOOT_PLAN_TEXT.tooFew(1, 2, "One") });
    expect(rebootJobs().filter(({ hostId }) => hostId === world.ids[0])).toEqual([]);
  });

  it("asks by the same way in as the Reboot button: a host with a job still open, or that cannot be asked, is not rebooted", async () => {
    await approve({ notBefore: world.plane.clock.now + MINUTE });
    const busy = await world.admin.post(apiPath(API_ROUTES.hostActions, { hostId: world.ids[0]! }), {
      action: "check_packages",
    });
    expect(busy.statusCode, busy.body).toBe(200);
    later(2 * MINUTE);
    await reportAll();
    tick();
    expect(await plan()).toMatchObject({
      status: "paused",
      reason: REBOOT_PLAN_TEXT.couldNotAsk("One", "another of its jobs is still open"),
    });
    expect(rebootJobs()).toEqual([]);
  });

  it("pauses rather than asks a host that has not said it can be rebooted from here", async () => {
    await approve({ notBefore: world.plane.clock.now + MINUTE });
    later(2 * MINUTE);
    await reportAll([0]);
    await runner(0, "POST", RUNNER_ROUTES.heartbeat, {
      ...heartbeatWith({ dryRun: false, containers: [], host: hostHealth({ bootId: bootId(0, 1) }) }),
    });
    tick();
    expect(await plan()).toMatchObject({
      status: "paused",
      reason: REBOOT_PLAN_TEXT.couldNotAsk("One", "it has not said it can be rebooted from here"),
    });
    expect(rebootJobs()).toEqual([]);
  });

  it("keeps a paused or waiting plan's place: a second cannot start beside it", async () => {
    await approve({ notBefore: world.plane.clock.now + MINUTE });
    const second = await world.admin.post(REBOOT_PLAN_ROUTES.plans, bodyWith());
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: string }>().error).toBe("reboot_plan_busy");
    expect((await world.admin.get(REBOOT_PLAN_ROUTES.plans)).json<RebootPlanView[]>()).toHaveLength(1);
  });

  it("does not call a host back until it has finished starting", async () => {
    await approve();
    await take(0);
    later(20_000);
    world.boots[0]! += 1;
    await reportAll();
    world.plane.services.databaseHandle.database
      .update(hosts)
      .set({ docker: true, eventStreamConnected: false })
      .where(eq(hosts.id, world.ids[0]!))
      .run();
    tick();
    expect((await plan()).steps[0]!.status).toBe("back");
    expect(rebootJobs()).toHaveLength(1);
    world.plane.services.databaseHandle.database
      .update(hosts)
      .set({ eventStreamConnected: true })
      .where(eq(hosts.id, world.ids[0]!))
      .run();
    tick();
    expect((await plan()).steps[0]!.status).toBe("done");
  });

  it("does not take a host's own going quiet for a return, nor its old boot", async () => {
    await approve();
    await take(0);
    later(20_000);
    await reportAll([0]);
    tick();
    expect(await statuses()).toEqual(["asked", "waiting", "waiting"]);
    await report(0);
    tick();
    expect((await plan()).steps[0]!.status).toBe("asked");
    expect(rebootJobs()).toHaveLength(1);
  });

  it("pauses when a host does not come back, reboots nothing more, opens a task, and says so truthfully", async () => {
    const approved = await approve();
    await take(0);
    later(11 * MINUTE);
    await reportAll([0]);
    tick();
    const paused = await plan();
    expect(paused.status).toBe("paused");
    expect(paused.reason).toBe(REBOOT_PLAN_TEXT.notBack("One", 10));
    expect(paused.steps[0]!.status).toBe("asked");
    expect(rebootJobs()).toHaveLength(1);

    await world.plane.services.detectorService.run();
    const open = (await world.admin.get(`${API_ROUTES.tasks}?status=open`)).json<TaskSummaryView[]>();
    expect(open.map(({ title }) => title)).toContain(REBOOT_PLAN_TEXT.taskTitle("Kernel updates"));

    // Told to carry on, it waits for that same reboot rather than asking again, and carries on once it is back.
    expect((await world.admin.post(apiPath(REBOOT_PLAN_ROUTES.resume, { planId: approved.id }))).statusCode).toBe(200);
    expect(rebootJobs()).toHaveLength(1);
    world.boots[0]! += 1;
    await reportAll();
    tick();
    expect((await plan()).steps[0]!.status).toBe("done");
    tick();
    expect(rebootJobs()).toHaveLength(2);
    await world.plane.services.detectorService.run();
    const after = (await world.admin.get(`${API_ROUTES.tasks}?status=open`)).json<TaskSummaryView[]>();
    expect(after.map(({ title }) => title)).not.toContain(REBOOT_PLAN_TEXT.taskTitle("Kernel updates"));
  });

  it("asks again only after a host really refused", async () => {
    const approved = await approve();
    const [job] = await take(0);
    await runner(0, "POST", apiPath(RUNNER_ROUTES.jobResult, { jobId: job!.id }), {
      succeeded: false,
      outcome: "Refused: a backup is running.",
      output: null,
    });
    await reportAll();
    tick();
    const paused = await plan();
    expect(paused.status).toBe("paused");
    expect(paused.steps[0]!.status).toBe("refused");
    expect(paused.reason).toContain("a backup is running");
    tick();
    expect(rebootJobs()).toHaveLength(1);
    await world.admin.post(apiPath(REBOOT_PLAN_ROUTES.resume, { planId: approved.id }));
    expect(rebootJobs()).toHaveLength(2);
  });

  it("cancels only what is yet to come, and goes on following the reboot already asked", async () => {
    const approved = await approve();
    expect(rebootJobs()).toHaveLength(1);
    const cancelled = await world.admin.post(apiPath(REBOOT_PLAN_ROUTES.cancel, { planId: approved.id }));
    expect(cancelled.statusCode).toBe(200);
    const during = await plan();
    expect(during).toMatchObject({ status: "running", cancelAsked: true });
    expect(during.steps.map(({ status }) => status)).toEqual(["asked", "cancelled", "cancelled"]);
    // Still on the host's list: cancelling takes nothing back.
    expect((await take(0)).length).toBe(1);
    later(20_000);
    world.boots[0]! += 1;
    await reportAll();
    tick();
    expect((await plan()).steps[0]!.status).toBe("done");
    tick();
    expect((await plan()).status).toBe("cancelled");
    expect(rebootJobs()).toHaveLength(1);
  });

  it("ends a cancelled plan saying so when the reboot it was following never came back", async () => {
    const approved = await approve();
    await take(0);
    await world.admin.post(apiPath(REBOOT_PLAN_ROUTES.cancel, { planId: approved.id }));
    later(11 * MINUTE);
    await reportAll([0]);
    tick();
    const ended = await plan();
    expect(ended.status).toBe("cancelled");
    expect(ended.reason).toBe(REBOOT_PLAN_TEXT.notBack("One", 10));
    expect(ended.steps[0]!.status).toBe("asked");
  });

  it("waits for its start, and starts no reboot after its end", async () => {
    await approve({ notBefore: world.plane.clock.now + 5 * MINUTE, notAfter: world.plane.clock.now + 10 * MINUTE });
    tick();
    expect(rebootJobs()).toEqual([]);
    later(6 * MINUTE);
    await reportAll();
    tick();
    expect(rebootJobs()).toHaveLength(1);
    await rebootAndReturn(0);
    later(5 * MINUTE);
    await reportAll();
    tick();
    const paused = await plan();
    expect(paused).toMatchObject({ status: "paused", reason: REBOOT_PLAN_TEXT.windowOver });
    expect(rebootJobs()).toHaveLength(1);
  });

  it("stops when its approver can no longer reboot hosts", async () => {
    await approve();
    await rebootAndReturn(0);
    const permissions = vi.spyOn(world.plane.services.resourcePermissions, "isAdmin").mockReturnValue(false);
    tick();
    permissions.mockRestore();
    expect((await plan()).reason).toBe(REBOOT_PLAN_TEXT.noLongerAllowed);
    expect(rebootJobs()).toHaveLength(1);
  });

  it("keeps one plan open at a time, and pauses after a database restore", async () => {
    await approve();
    expect((await world.admin.post(REBOOT_PLAN_ROUTES.plans, bodyWith())).statusCode).toBe(409);
    world.plane.services.rebootPlans.pauseAfterRestore();
    expect(await plan()).toMatchObject({ status: "paused", reason: REBOOT_PLAN_TEXT.restored });
  });

  describe("with a service check it must see answering", () => {
    let probeId: string;
    const setProbe = (change: Partial<typeof serviceProbes.$inferInsert>) =>
      world.plane.services.databaseHandle.database
        .update(serviceProbes)
        .set(change)
        .where(eq(serviceProbes.id, probeId))
        .run();
    beforeEach(async () => {
      const made = await world.admin.post(apiPath(API_ROUTES.hostProbes, { hostId: world.ids[0]! }), {
        name: "Wiki",
        scope: "this-machine",
        intervalSeconds: 60,
        timeoutSeconds: 1,
        failuresBeforeDown: 1,
        objectivePercent: null,
        target: { kind: "tcp", host: "127.0.0.1", port: 1 },
      });
      probeId = made.json<{ id: string }>().id;
    });
    const answering = () =>
      setProbe({ state: "up", lastCheckedAt: world.plane.clock.now, lastLatencyMilliseconds: 3, lastProblem: null });

    it("will not start on a remembered answer, or one that says down", async () => {
      expect((await world.admin.post(REBOOT_PLAN_ROUTES.plans, bodyWith({ probeIds: [probeId] }))).statusCode).toBe(
        409,
      );
      answering();
      later(3 * MINUTE);
      await reportAll();
      const stale = (
        await world.admin.post(REBOOT_PLAN_ROUTES.preview, bodyWith({ probeIds: [probeId] }))
      ).json<RebootPlanPreview>();
      expect(stale.problem).toBe(REBOOT_PLAN_TEXT.checkStale("Wiki"));
      setProbe({ state: "down", lastCheckedAt: world.plane.clock.now });
      const down = (
        await world.admin.post(REBOOT_PLAN_ROUTES.preview, bodyWith({ probeIds: [probeId] }))
      ).json<RebootPlanPreview>();
      expect(down.problem).toBe(REBOOT_PLAN_TEXT.checkDown("Wiki"));
    });

    it("waits after a return for an answer given since then, and pauses when none comes", async () => {
      answering();
      await approve({ probeIds: [probeId] });
      await rebootAndReturn(0);
      expect((await plan()).steps[0]!.status).toBe("back");
      expect(rebootJobs()).toHaveLength(1);
      later(MINUTE);
      await reportAll();
      answering();
      tick();
      expect((await plan()).steps[0]!.status).toBe("done");
    });

    it("pauses when a required check is gone", async () => {
      answering();
      await approve({ probeIds: [probeId] });
      await rebootAndReturn(0);
      await world.admin.delete(apiPath(API_ROUTES.hostProbe, { hostId: world.ids[0]!, probeId }));
      later(11 * MINUTE);
      await reportAll();
      tick();
      expect((await plan()).status).toBe("paused");
      expect(rebootJobs()).toHaveLength(1);
    });

    it("does not count a check held by maintenance as an answer", async () => {
      answering();
      await reportAll();
      const view = (await world.admin.get(apiPath(API_ROUTES.hostProbes, { hostId: world.ids[0]! }))).json<
        ProbeView[]
      >();
      expect(view[0]!.state).toBe("up");
      expect(world.plane.services.probes.evidence(probeId, null)).toBeNull();
      await runner(0, "POST", RUNNER_ROUTES.heartbeat, {
        ...heartbeatWith({
          dryRun: false,
          containers: [],
          host: hostHealth({ bootId: bootId(0, 1), packages: PACKAGES }),
        }),
        maintenanceGeneration: 0,
      });
      const made = await world.admin.post(apiPath(API_ROUTES.hostMaintenance, { hostId: world.ids[0]! }), {
        containerName: null,
        reason: "Planned",
        expiresAt: world.plane.clock.now + 30 * MINUTE,
      });
      expect(made.statusCode, made.body).toBe(200);
      expect(world.plane.services.probes.evidence(probeId, null)).toBe(REBOOT_PLAN_TEXT.checkHeld("Wiki"));
    });
  });
});

describe("a plan across a control plane restart", () => {
  const FILE_NAME = "autoheal.sqlite";
  let folder: string;
  let plane: TestControlPlane;
  let admin: TestClient;
  let tokens: string[];
  let ids: string[];
  const boots = [1, 1, 1];

  const report = (index: number) =>
    plane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      payload: {
        ...heartbeatWith({
          dryRun: false,
          containers: [],
          host: hostHealth({ bootId: bootId(index, boots[index]!), packages: PACKAGES }),
        }),
        eventStreamConnected: true,
      },
      headers: { authorization: `Bearer ${tokens[index]!}`, [HTTP_HEADERS.runnerCapabilities]: RUNNER_CAPABILITIES },
    });
  const rebootJobs = () =>
    plane.services.databaseHandle.database.select().from(jobs).where(eq(jobs.action, JOB_ACTION.reboot)).all();
  const restart = async () => {
    const clock = plane.clock.now;
    await plane.app.close();
    await plane.runnerApp.close();
    plane = await startTestControlPlane({ databasePath: join(folder, FILE_NAME) });
    plane.clock.now = clock;
  };

  beforeEach(async () => {
    folder = mkdtempSync(join(tmpdir(), "autoheal-reboot-plans-"));
    const world = await fixture(join(folder, FILE_NAME));
    ({ plane, admin, tokens, ids } = world);
    boots.fill(1);
    for (const index of [0, 1, 2]) await report(index);
  });
  afterEach(async () => {
    await plane.app.close();
    await plane.runnerApp.close();
    rmSync(folder, { recursive: true, force: true });
  });

  it("asks nothing again, and carries on from where it was", async () => {
    const approved = await admin.post(REBOOT_PLAN_ROUTES.plans, {
      name: "Kernel updates",
      hostIds: ids,
      minimumHealthy: 2,
      probeIds: [],
      returnMinutes: 10,
      notBefore: null,
      notAfter: null,
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(rebootJobs()).toHaveLength(1);
    await plane.runnerApp.inject({
      method: "GET",
      url: RUNNER_ROUTES.work,
      headers: { authorization: `Bearer ${tokens[0]!}`, [HTTP_HEADERS.runnerCapabilities]: RUNNER_CAPABILITIES },
    });

    await restart();
    plane.services.rebootPlans.tick();
    plane.services.rebootPlans.tick();
    expect(rebootJobs()).toHaveLength(1);
    expect(plane.services.rebootPlans.list()[0]!.steps[0]!.status).toBe("asked");

    plane.clock.now += 20_000;
    boots[0] = 2;
    for (const index of [0, 1, 2]) await report(index);
    plane.services.rebootPlans.tick();
    expect(plane.services.rebootPlans.list()[0]!.steps[0]!.status).toBe("done");
    await restart();
    for (const index of [0, 1, 2]) await report(index);
    plane.services.rebootPlans.tick();
    expect(rebootJobs()).toHaveLength(2);
    expect(rebootJobs().filter(({ hostId }) => hostId === ids[0])).toHaveLength(1);
  });

  it("saves a reboot and the plan's record of it together, so a crash between them cannot ask twice", async () => {
    await admin.post(REBOOT_PLAN_ROUTES.plans, {
      name: "Kernel updates",
      hostIds: ids,
      minimumHealthy: 2,
      probeIds: [],
      returnMinutes: 10,
      notBefore: Date.now() * 2,
      notAfter: null,
    });
    const database = plane.services.databaseHandle.sqlite;
    plane.clock.now = Date.now() * 2 + 1;
    for (const index of [0, 1, 2]) await report(index);
    // The save of the plan fails right after the job is written.
    database.exec(`CREATE TRIGGER fail_save BEFORE UPDATE ON reboot_plans
      WHEN NEW.state_json LIKE '%"status":"asked"%' BEGIN SELECT RAISE(ABORT, 'crash'); END`);
    plane.services.rebootPlans.tick();
    expect(rebootJobs()).toEqual([]);
    database.exec("DROP TRIGGER fail_save");
  });
});
