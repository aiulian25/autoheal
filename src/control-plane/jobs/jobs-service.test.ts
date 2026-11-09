import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runnerTokenOf, startTestControlPlane, type TestControlPlane } from "../../../test/support/control-plane.js";
import { containerSnapshot, heartbeatWith } from "../../../test/support/inventory.js";
import { fullySignedInAdmin } from "../../../test/support/second-factor.js";
import { API_ERRORS, API_ROUTES, type EnrolledHostView } from "../../shared/api.js";
import type { BackupJobDetails } from "../../shared/container-backups.js";
import {
  AGENT_AUTOHEAL,
  CONTAINER_BACKUP_ANSWER_MILLISECONDS,
  HOST_KIND,
  HOST_PACKAGE_ANSWER_MILLISECONDS,
  JOB_ACTION,
  JOB_ANSWER_MILLISECONDS,
  JOB_EXPIRY_MILLISECONDS,
  JOB_NO_ANSWER,
  JOB_STATUS,
  type JobAction,
} from "../../shared/constants.js";
import { RUNNER_ROUTES } from "../../shared/protocol.js";
import { hosts, jobs } from "../database/schema.js";
import type { TaskAuthor } from "../tasks/tasks-service.js";
import type { JobsService } from "./jobs-service.js";

const AUTOHEAL: TaskAuthor = { kind: "agent", agent: AGENT_AUTOHEAL };
const RESTARTED = { succeeded: true, outcome: "Restarted.", output: null };
// Only what the job keeps: the runner never sees this one.
const BACKUP = { backup: {} as BackupJobDetails };
// The host as its runner reports it: what a case changes nothing about.
const DOCKER_THERE = { docker: true };

describe("the jobs service's own rules", () => {
  let controlPlane: TestControlPlane;
  let hostId: string;
  let service: JobsService;

  beforeEach(async () => {
    controlPlane = await startTestControlPlane();
    const admin = (await fullySignedInAdmin(controlPlane)).client;
    const enrolled = (await admin.post(API_ROUTES.hosts, { label: "Alder" })).json<EnrolledHostView>();
    hostId = enrolled.host.id;
    const response = await controlPlane.runnerApp.inject({
      method: "POST",
      url: RUNNER_ROUTES.heartbeat,
      payload: heartbeatWith({ dryRun: false, containers: [containerSnapshot({ name: "paperless" })] }),
      headers: { authorization: `Bearer ${runnerTokenOf(enrolled)}` },
    });
    expect(response.statusCode).toBe(200);
    service = controlPlane.services.jobsService;
  });

  afterEach(async () => {
    await controlPlane.app.close();
    await controlPlane.runnerApp.close();
  });

  const database = () => controlPlane.services.databaseHandle.database;
  const host = () => database().select().from(hosts).where(eq(hosts.id, hostId)).get()!;
  const changeHost = (change: Partial<typeof hosts.$inferInsert>) =>
    database().update(hosts).set(change).where(eq(hosts.id, hostId)).run();
  const later = (milliseconds: number) => {
    controlPlane.clock.now += milliseconds;
  };
  const ask = (action: JobAction, containerName = "paperless", details = {}) =>
    service.request(AUTOHEAL, hostId, containerName, action, null, details);
  const statusOf = (jobId: string) => service.view(jobId).status;
  const refusedWith = (code: string) => expect.objectContaining({ code });

  it("keeps an action nobody collected open until the moment it expires, and ends it then", () => {
    const job = ask(JOB_ACTION.restart);
    later(JOB_EXPIRY_MILLISECONDS - 1);
    service.expireStale();
    expect(statusOf(job.id)).toBe(JOB_STATUS.pending);
    later(1);
    service.expireStale();
    expect(statusOf(job.id)).toBe(JOB_STATUS.expired);
  });

  it.each([
    [JOB_ACTION.restart, "paperless", {}, JOB_ANSWER_MILLISECONDS],
    [JOB_ACTION.checkPackages, "", {}, HOST_PACKAGE_ANSWER_MILLISECONDS],
    [JOB_ACTION.backupContainer, "paperless", BACKUP, CONTAINER_BACKUP_ANSWER_MILLISECONDS],
  ])("gives a delivered %s its own time to answer, then fails it as never answered", (action, name, details, wait) => {
    const job = ask(action, name, details);
    // As its runner collected it.
    database()
      .update(jobs)
      .set({ status: JOB_STATUS.delivered, deliveredAt: controlPlane.clock.now })
      .where(eq(jobs.id, job.id))
      .run();
    later(wait - 1);
    service.expireStale();
    expect(statusOf(job.id)).toBe(JOB_STATUS.delivered);
    later(1);
    service.expireStale();
    expect(service.view(job.id)).toMatchObject({ status: JOB_STATUS.failed, outcome: JOB_NO_ANSWER });
  });

  it("still takes the answer of an action it had given up on, once", () => {
    const job = ask(JOB_ACTION.restart);
    service.take(host());
    later(JOB_ANSWER_MILLISECONDS);
    service.expireStale();
    expect(statusOf(job.id)).toBe(JOB_STATUS.failed);
    service.complete(host(), job.id, RESTARTED);
    expect(service.view(job.id)).toMatchObject({ status: JOB_STATUS.succeeded, outcome: RESTARTED.outcome });
    expect(() => service.complete(host(), job.id, RESTARTED)).toThrow(refusedWith(API_ERRORS.jobNotFound));
  });

  it("hands a runner back from a long silence nothing it should have collected long before", () => {
    const stale = ask(JOB_ACTION.restart);
    later(JOB_EXPIRY_MILLISECONDS);
    expect(service.take(host())).toEqual([]);
    expect(statusOf(stale.id)).toBe(JOB_STATUS.expired);
    const fresh = ask(JOB_ACTION.restart);
    expect(service.take(host()).map(({ id }) => id)).toEqual([fresh.id]);
    expect(service.take(host())).toEqual([]);
  });

  it("returns the same action while it is on its way, and sends a new one once it ended", () => {
    const first = ask(JOB_ACTION.restart);
    expect(ask(JOB_ACTION.restart).id).toBe(first.id);
    service.take(host());
    expect(ask(JOB_ACTION.restart).id).toBe(first.id);
    service.complete(host(), first.id, RESTARTED);
    expect(ask(JOB_ACTION.restart).id).not.toBe(first.id);
  });

  it.each([
    ["a container the host does not have", JOB_ACTION.restart, "nextcloud", DOCKER_THERE, API_ERRORS.containerNotFound],
    [
      "a container action where Docker is gone",
      JOB_ACTION.restart,
      "paperless",
      { docker: false },
      API_ERRORS.hostHasNoDocker,
    ],
    ["images the host never reported unused", JOB_ACTION.removeImages, "", DOCKER_THERE, API_ERRORS.imageNotFound],
    [
      "a runner update on a host reached over SSH",
      JOB_ACTION.updateRunner,
      "",
      { kind: HOST_KIND.ssh },
      API_ERRORS.runnerUpdateNotHere,
    ],
  ] as const)("refuses up front what its runner would refuse: %s", (_case, action, name, hostChange, code) => {
    changeHost(hostChange);
    const images = action === JOB_ACTION.removeImages ? { images: [`sha256:${"a".repeat(64)}`] } : {};
    expect(() => ask(action, name, images)).toThrow(refusedWith(code));
    expect(database().select().from(jobs).all()).toEqual([]);
  });

  it("still takes package actions on a host where Docker is gone", () => {
    changeHost({ docker: false });
    expect(ask(JOB_ACTION.checkPackages, "").status).toBe(JOB_STATUS.pending);
  });
});
