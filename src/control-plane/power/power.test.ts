import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runnerTokenOf,
  startTestControlPlane,
  type TestClient,
  type TestControlPlane,
} from "../../../test/support/control-plane.js";
import { heartbeatWith, hostHealth } from "../../../test/support/inventory.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import {
  API_ROUTES,
  apiPath,
  type EnrolledHostView,
  type HostView,
  type JobView,
  type TaskSummaryView,
} from "../../shared/api.js";
import { JOB_STATUS, POWER, POWER_OUTCOMES, POWER_PHASE } from "../../shared/constants.js";
import type { PackageFacts, WorkResponse } from "../../shared/protocol.js";
import { RUNNER_ROUTES } from "../../shared/protocol.js";

const BOOT = "8c2f3c1e-5b7a-4d36-9e0f-1a2b3c4d5e6f";
const NEXT_BOOT = "1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a";
// Its packages only checked: reboot and shutdown do not depend on that.
const facts: PackageFacts = {
  setting: "check",
  unsupported: null,
  unattendedUpgrades: false,
  rebootPackages: [],
  kernelWaiting: null,
  timeZone: "Europe/Lisbon",
  recentChanges: [],
};

describe("a reboot or a shutdown, followed from what the host shows", () => {
  let controlPlane: TestControlPlane;
  let admin: TestClient;
  let token: string;
  let hostId: string;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    admin = (await fullySignedInAdmin(controlPlane)).client;
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    token = runnerTokenOf(enrolled);
    hostId = enrolled.host.id;
    await report(BOOT);
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  async function report(bootId: string) {
    const response = await controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      payload: heartbeatWith({ dryRun: false, host: hostHealth({ bootId, packages: facts }) }),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
  }
  const takeWork = async () =>
    (
      await controlPlane.runnerApp.inject({
        method: "GET",
        url: RUNNER_ROUTES.work,
        headers: { authorization: `Bearer ${token}` },
      })
    ).json<WorkResponse>().jobs;
  const ask = async (action: string) => {
    const asked = await admin.post(apiPath(API_ROUTES.hostActions, { hostId }), { action });
    expect(asked.statusCode, asked.body).toBe(200);
    return asked.json<JobView>();
  };
  const host = async () => (await admin.get(API_ROUTES.hosts)).json<HostView[]>().find(({ id }) => id === hostId)!;
  const job = async (id: string) => (await admin.get(apiPath(API_ROUTES.job, { jobId: id }))).json<JobView>();
  const later = (milliseconds: number) => {
    controlPlane.clock.now += milliseconds;
  };

  it("reboots a host whose packages are only checked: going down, offline, then ready on its new boot", async () => {
    const reboot = await ask("reboot");
    expect((await host()).power).toMatchObject({ action: "reboot", phase: POWER_PHASE.asked, requestedBy: "admin" });
    expect((await takeWork()).map(({ action }) => action)).toEqual(["reboot"]);
    expect((await host()).power?.phase).toBe(POWER_PHASE.goingDown);

    later(POWER.silentAfterMilliseconds + 1_000);
    expect((await host()).power?.phase).toBe(POWER_PHASE.offline);
    // Quiet on purpose: no "stopped reporting" task.
    later(5 * 60_000);
    await controlPlane.services.detectorService.run();
    expect((await admin.get(`${API_ROUTES.tasks}?status=open`)).json<TaskSummaryView[]>()).toEqual([]);

    await report(NEXT_BOOT);
    expect((await host()).power?.phase).toBe(POWER_PHASE.ready);
    expect(await job(reboot.id)).toMatchObject({
      status: JOB_STATUS.succeeded,
      outcome: expect.stringMatching(/^Rebooted/),
    });
    later(POWER.shownMilliseconds + 1_000);
    await report(NEXT_BOOT);
    expect((await host()).power).toBeUndefined();
  });

  it("shuts a host down: going down, then off once it is quiet, its job done, and off for as long as it stays so", async () => {
    const shutdown = await ask("shutdown");
    await takeWork();
    expect((await host()).power?.phase).toBe(POWER_PHASE.goingDown);

    later(POWER.silentAfterMilliseconds + 1_000);
    controlPlane.services.power.tick();
    expect(await job(shutdown.id)).toMatchObject({ status: JOB_STATUS.succeeded, outcome: POWER_OUTCOMES.shutDown });
    // Long after (within the session's hour), still off.
    later(50 * 60_000);
    expect((await host()).power).toMatchObject({ action: "shutdown", phase: POWER_PHASE.off });
    await controlPlane.services.detectorService.run();
    expect((await admin.get(`${API_ROUTES.tasks}?status=open`)).json<TaskSummaryView[]>()).toEqual([]);

    // Powered on again: a new boot, and nothing more to follow.
    await report(NEXT_BOOT);
    expect((await host()).power).toBeUndefined();
  });
});
