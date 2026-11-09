import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestControlPlane, type TestControlPlane } from "../../../test/support/control-plane.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import { API_ERRORS, API_ROUTES, type EnrolledHostView } from "../../shared/api.js";
import { MILLISECONDS_PER_HOUR } from "../../shared/constants.js";
import {
  REBOOT_PLAN,
  REBOOT_PLAN_STATUS,
  REBOOT_PLAN_TEXT,
  REBOOT_STEP_STATUS,
  type RebootPlanBody,
} from "../../shared/reboot-plans.js";
import type { Actor } from "../audit/audit-log.js";
import { hosts, users } from "../database/schema.js";
import { RebootPlansService } from "./reboot-plans-service.js";

describe("a reboot plan's own window and cancellation", () => {
  let controlPlane: TestControlPlane;
  let admin: Actor;
  let hostIds: string[];
  let asked: string[];
  // What the host shows of its reboot: back from a new boot, or refused it.
  let progress: { cameBack: boolean; heard: boolean; refused: boolean };
  let service: RebootPlansService;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    const client = (await fullySignedInAdmin(controlPlane)).client;
    const enroll = async (label: string) =>
      (await client.post(API_ROUTES.hosts, { label })).json<EnrolledHostView>().host.id;
    hostIds = [await enroll("Alder"), await enroll("Birch")];
    const database = controlPlane.services.databaseHandle.database;
    // Each up and reporting, with its Docker events connected: healthy, as far as the plan can tell.
    database.update(hosts).set({ eventStreamConnected: true }).run();
    const { id } = database.select({ id: users.id }).from(users).get()!;
    admin = { userId: id, username: "admin", ip: "127.0.0.1", requestId: "test" };
    asked = [];
    progress = { cameBack: false, heard: true, refused: false };
    const jobs = controlPlane.services.jobsService;
    service = new RebootPlansService({
      databaseHandle: controlPlane.services.databaseHandle,
      audit: controlPlane.services.auditLog,
      permissions: { isAdmin: () => true },
      hostPackages: {
        request: (author, hostId, action) => {
          asked.push(hostId);
          return jobs.request(author, hostId, "", action, null);
        },
      },
      power: { powerOf: () => null, lastSeenOf: () => controlPlane.clock.now, rebootProgress: () => progress },
      probes: { evidence: () => null, nameOf: () => null },
      rebootRequired: () => true,
      clock: () => controlPlane.clock.now,
    });
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  const body = (window: Partial<Pick<RebootPlanBody, "notBefore" | "notAfter">> = {}): RebootPlanBody => ({
    name: "Kernel",
    hostIds,
    minimumHealthy: 1,
    probeIds: [],
    returnMinutes: REBOOT_PLAN.returnMinutes.usual,
    notBefore: null,
    notAfter: null,
    ...window,
  });
  const planNow = () => service.list()[0]!;
  const stepsNow = () => planNow().steps.map(({ status }) => status);

  it("waits for its start to the moment, then asks the first host only", () => {
    const start = controlPlane.clock.now + MILLISECONDS_PER_HOUR;
    service.create(admin, body({ notBefore: start }));
    controlPlane.clock.now = start - 1;
    service.tick();
    expect(asked).toEqual([]);
    controlPlane.clock.now = start;
    service.tick();
    expect(asked).toEqual([hostIds[0]]);
    expect(stepsNow()).toEqual([REBOOT_STEP_STATUS.asked, REBOOT_STEP_STATUS.waiting]);
  });

  it.each([
    {
      moment: "at the very end of its window",
      afterEnd: 0,
      hostsAsked: 2,
      status: REBOOT_PLAN_STATUS.running,
      reason: null,
    },
    {
      moment: "once its window is over",
      afterEnd: 1,
      hostsAsked: 1,
      status: REBOOT_PLAN_STATUS.paused,
      reason: REBOOT_PLAN_TEXT.windowOver,
    },
  ])("asks the next host $moment only while it is still in time", ({ afterEnd, hostsAsked, status, reason }) => {
    const end = controlPlane.clock.now + MILLISECONDS_PER_HOUR;
    service.create(admin, body({ notAfter: end }));
    progress.cameBack = true;
    controlPlane.clock.now = end + afterEnd;
    // The first host back, then the next one's turn.
    service.tick();
    service.tick();
    expect(asked).toHaveLength(hostsAsked);
    expect(planNow()).toMatchObject({ status, reason });
  });

  it("cancels what has not begun, follows the reboot already asked to its end, and ends cancelled", () => {
    const { id } = service.create(admin, body());
    const cancelled = service.cancel(admin, id);
    expect(cancelled).toMatchObject({ status: REBOOT_PLAN_STATUS.running, cancelAsked: true });
    expect(stepsNow()).toEqual([REBOOT_STEP_STATUS.asked, REBOOT_STEP_STATUS.cancelled]);
    progress.cameBack = true;
    service.tick();
    service.tick();
    expect(planNow().status).toBe(REBOOT_PLAN_STATUS.cancelled);
    expect(stepsNow()).toEqual([REBOOT_STEP_STATUS.done, REBOOT_STEP_STATUS.cancelled]);
    expect(asked).toEqual([hostIds[0]]);
    expect(() => service.cancel(admin, id)).toThrow(expect.objectContaining({ code: API_ERRORS.rebootPlanBusy }));
  });

  it("ends a plan paused on a refusal at once when cancelled, asking nothing more", () => {
    const { id } = service.create(admin, body());
    progress.refused = true;
    service.tick();
    expect(planNow().status).toBe(REBOOT_PLAN_STATUS.paused);
    expect(service.cancel(admin, id).status).toBe(REBOOT_PLAN_STATUS.cancelled);
    expect(stepsNow()).toEqual([REBOOT_STEP_STATUS.cancelled, REBOOT_STEP_STATUS.cancelled]);
    expect(asked).toEqual([hostIds[0]]);
  });
});
