import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runnerTokenOf, startTestControlPlane, type TestControlPlane } from "../../../test/support/control-plane.js";
import { containerSnapshot, heartbeatWith } from "../../../test/support/inventory.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import { API_ERRORS, API_ROUTES, type EnrolledHostView } from "../../shared/api.js";
import {
  AVAILABILITY_GROUPS,
  CONTAINER_STATE_EXITED,
  HOST_SILENT_AFTER_MILLISECONDS,
  JOB_ACTION,
  JOB_STATUS,
} from "../../shared/constants.js";
import { RUNNER_ROUTES, type ContainerSnapshot } from "../../shared/protocol.js";
import { ROLLOUT_REASONS, type RolloutView } from "../../shared/rollouts.js";
import type { Actor } from "../audit/audit-log.js";
import { hosts, jobs, users } from "../database/schema.js";
import { rollouts } from "./rollout-schema.js";
import type { RolloutService } from "./rollout-service.js";

const SOURCE = "ghcr.io/example/app:latest";
const TARGET = `ghcr.io/example/app@sha256:${"b".repeat(64)}`;
const SOURCE_ID = "1".repeat(64);
const REPLACEMENT_ID = "222222222222";
const PLATFORM = "linux/amd64";
const FINGERPRINT = "a".repeat(64);
const OBSERVE_MILLISECONDS = 60_000;
const SECOND = 1000;
// Reports this far apart are each fresh, yet fewer than three fit in the window and the time a report may take.
const SPARSE_REPORTS_MILLISECONDS = 150_000;
const UPDATED = "Updated.";
const DID_NOT_START = "The new image did not start.";

describe("a rollout's own transitions", () => {
  let controlPlane: TestControlPlane;
  let token: string;
  let hostId: string;
  let admin: Actor;
  let service: RolloutService;
  // Reported beside the canary in every heartbeat: a rollout's later targets and their replicas.
  let beside: ContainerSnapshot[];

  beforeEach(async () => {
    beside = [];
    controlPlane = await startTestControlPlane();
    const client = (await fullySignedInAdmin(controlPlane)).client;
    const enrolled = (await client.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    hostId = enrolled.host.id;
    token = runnerTokenOf(enrolled);
    const { id } = database().select({ id: users.id }).from(users).get()!;
    admin = { userId: id, username: "admin", ip: "127.0.0.1", requestId: "test" };
    service = controlPlane.services.rollouts;
    await report({ containerId: SOURCE_ID.slice(0, REPLACEMENT_ID.length), image: SOURCE });
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  const database = () => controlPlane.services.databaseHandle.database;
  const later = (milliseconds: number) => {
    controlPlane.clock.now += milliseconds;
  };
  const report = async (canary: Partial<ContainerSnapshot>) => {
    const response = await controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      payload: {
        ...heartbeatWith({ dryRun: false, containers: [containerSnapshot({ name: "canary", ...canary }), ...beside] }),
        operationPreviews: true,
        rollouts: true,
      },
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
  };
  const replaced = (restartCount = 0) => report({ containerId: REPLACEMENT_ID, image: TARGET, restartCount });
  const planNow = () => service.list()[0]!;
  const refusedWith = (code: string) => expect.objectContaining({ code });

  const targetNamed = (containerName: string, jobId: string | null) => ({
    hostId,
    containerName,
    targetReference: TARGET,
    sourceContainerId: SOURCE_ID,
    platform: PLATFORM,
    fingerprint: FINGERPRINT,
    members: [containerName],
    jobId,
    replacementId: null,
    baselineRestarts: null,
  });

  // What create() leaves once its review passed: the canary's update asked for, and collected by its runner.
  function underWay(createdBy = admin.userId, followers: readonly string[] = []) {
    const id = randomUUID();
    const job = controlPlane.services.jobsService.request(
      { kind: "user", actor: admin },
      hostId,
      "canary",
      JOB_ACTION.update,
      null,
      {
        expectedResourcesFingerprint: FINGERPRINT,
        undoIfUnhealthy: true,
        rollout: {
          id,
          targetReference: TARGET,
          expectedSourceContainerId: SOURCE_ID,
          expectedPlatform: PLATFORM,
          requireStateless: true,
        },
      },
    );
    const now = controlPlane.clock.now;
    const plan: RolloutView = {
      id,
      createdAt: now,
      updatedAt: now,
      createdBy,
      status: "updating",
      targets: [targetNamed("canary", job.id), ...followers.map((name) => targetNamed(name, null))],
      current: 0,
      observeMilliseconds: OBSERVE_MILLISECONDS,
      observeStartedAt: null,
      lastSampleAt: null,
      samples: 0,
      serviceVerificationRequired: false,
      externalDataIsolated: true,
      reason: null,
      rollbackReadiness: "startup_only_then_manual",
    };
    database()
      .insert(rollouts)
      .values({ id, createdAt: now, updatedAt: now, stateJson: JSON.stringify(plan) })
      .run();
    database().update(jobs).set({ status: JOB_STATUS.delivered, deliveredAt: now }).where(eq(jobs.id, job.id)).run();
    return { id, jobId: job.id };
  }
  const updated = (jobId: string, succeeded = true) => {
    const host = database().select().from(hosts).where(eq(hosts.id, hostId)).get()!;
    controlPlane.services.jobsService.complete(host, jobId, {
      succeeded,
      outcome: succeeded ? UPDATED : DID_NOT_START,
      output: null,
    });
  };
  // A report this long after the last, and the tick that reads it. The first after the update starts the watching.
  const reportAfter = async (milliseconds: number) => {
    later(milliseconds);
    await replaced();
    service.tick();
  };

  it("watches a canary once its update went well, and is ready only after the whole window and three reports", async () => {
    const { jobId } = underWay();
    updated(jobId);
    expect(planNow()).toMatchObject({ status: "observing", reason: ROLLOUT_REASONS.awaitingReport });
    await reportAfter(SECOND);
    expect(planNow()).toMatchObject({ status: "observing", samples: 1, observeStartedAt: controlPlane.clock.now });
    await reportAfter(OBSERVE_MILLISECONDS / 2);
    later(OBSERVE_MILLISECONDS / 2);
    service.tick();
    expect(planNow()).toMatchObject({ status: "observing", samples: 2 });
    await replaced();
    service.tick();
    expect(planNow()).toMatchObject({ status: "ready", samples: 3, reason: ROLLOUT_REASONS.observationPassed });
  });

  it("is inconclusive when too few reports come in its window and the time a report may take", async () => {
    const { jobId } = underWay();
    updated(jobId);
    await reportAfter(SECOND);
    await reportAfter(SPARSE_REPORTS_MILLISECONDS);
    expect(planNow().status).toBe("observing");
    later(OBSERVE_MILLISECONDS + HOST_SILENT_AFTER_MILLISECONDS - SPARSE_REPORTS_MILLISECONDS + 1);
    service.tick();
    expect(planNow()).toMatchObject({
      status: "inconclusive",
      samples: 2,
      reason: ROLLOUT_REASONS.insufficientReports,
    });
  });

  it("fails when the replacement restarts while it is watched", async () => {
    const { jobId } = underWay();
    updated(jobId);
    await reportAfter(SECOND);
    later(SECOND);
    await replaced(1);
    service.tick();
    expect(planNow()).toMatchObject({ status: "failed", reason: ROLLOUT_REASONS.replacementChanged });
  });

  it("fails with what the runner said when the update fails", () => {
    const { jobId } = underWay();
    updated(jobId, false);
    expect(planNow()).toMatchObject({ status: "failed", reason: DID_NOT_START });
  });

  it("stays as it was once held: watching stops, and nothing promotes or holds it again", async () => {
    const { id, jobId } = underWay();
    updated(jobId);
    await reportAfter(SECOND);
    expect(service.hold(admin, id)).toMatchObject({ status: "held", reason: ROLLOUT_REASONS.heldByAdministrator });
    later(OBSERVE_MILLISECONDS);
    await replaced();
    service.tick();
    expect(planNow()).toMatchObject({ status: "held", samples: 1 });
    expect(() => service.promote(admin, id, true)).toThrow(refusedWith(API_ERRORS.rolloutGate));
    expect(() => service.hold(admin, id)).toThrow(refusedWith(API_ERRORS.rolloutGate));
  });

  it("promotes only a ready cohort, and the last one completes the rollout", async () => {
    const { id, jobId } = underWay();
    updated(jobId);
    expect(() => service.promote(admin, id, false)).toThrow(refusedWith(API_ERRORS.rolloutGate));
    await reportAfter(SECOND);
    await reportAfter(OBSERVE_MILLISECONDS / 2);
    await reportAfter(OBSERVE_MILLISECONDS / 2);
    expect(service.promote(admin, id, false)).toMatchObject({
      status: "completed",
      reason: ROLLOUT_REASONS.completed,
    });
  });

  it("holds a rollout whose author is no longer an admin, before anything more happens", () => {
    underWay("someone-who-left");
    service.tick();
    expect(planNow()).toMatchObject({ status: "held", reason: ROLLOUT_REASONS.requesterUnauthorized });
  });
  describe("a later target whose replicas form an availability group", () => {
    const replica = (name: string, state = "running") =>
      containerSnapshot({ name, containerId: name.padEnd(12, "0").slice(0, 12), state } as Partial<ContainerSnapshot>);
    const group = (...members: string[]) =>
      controlPlane.services.availabilityGroups.add(admin, {
        name: "app",
        minimumAvailable: 1,
        evidenceFreshSeconds: AVAILABILITY_GROUPS.freshSeconds.maximum,
        members: members.map((containerName) => ({ hostId, containerName, failureDomain: null, probeId: null })),
      });
    const jobsFor = (containerName: string) =>
      database().select().from(jobs).where(eq(jobs.containerName, containerName)).all();
    const host = () => database().select().from(hosts).where(eq(hosts.id, hostId)).get()!;
    const ready = async (jobId: string) => {
      updated(jobId);
      await reportAfter(SECOND);
      await reportAfter(OBSERVE_MILLISECONDS / 2);
      await reportAfter(OBSERVE_MILLISECONDS / 2);
      expect(planNow().status).toBe("ready");
    };
    const spareStopped = async (stopped: boolean) => {
      beside = [replica("follower"), replica("spare", stopped ? CONTAINER_STATE_EXITED : "running")];
      await replaced();
    };

    beforeEach(() => {
      beside = [replica("follower"), replica("spare")];
      group("follower", "spare");
    });

    it("queues no later target once the replica it would leave serving stopped, and stays ready to try again", async () => {
      const { id, jobId } = underWay(admin.userId, ["follower"]);
      await ready(jobId);
      await spareStopped(true);

      expect(() => service.promote(admin, id, false)).toThrow(refusedWith(API_ERRORS.availabilityGate));
      expect(planNow()).toMatchObject({ status: "ready", current: 0 });
      expect(jobsFor("follower")).toEqual([]);

      await spareStopped(false);
      expect(service.promote(admin, id, false)).toMatchObject({ status: "updating", current: 1 });
      expect(jobsFor("follower")).toHaveLength(1);
    });

    it("does not count its own later targets against the one it replaces now", async () => {
      const { id, jobId } = underWay(admin.userId, ["follower", "spare"]);
      await ready(jobId);

      expect(service.promote(admin, id, false)).toMatchObject({ status: "updating", current: 1 });
    });

    it("hands its runner no queued later target while the replica it would leave serving is stopped", async () => {
      const { id, jobId } = underWay(admin.userId, ["follower"]);
      await ready(jobId);
      service.promote(admin, id, false);
      const handed = () => controlPlane.services.jobsService.take(host()).map(({ containerName }) => containerName);

      await spareStopped(true);
      expect(handed()).toEqual([]);
      expect(jobsFor("follower")).toMatchObject([{ status: JOB_STATUS.pending }]);

      await spareStopped(false);
      expect(handed()).toEqual(["follower"]);
    });
  });
});
