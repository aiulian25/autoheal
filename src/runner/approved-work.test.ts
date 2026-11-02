import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeDockerEngine, exitedContainer } from "../../test/fakes/fake-docker-engine.js";
import { instantTime } from "../../test/support/instant-time.js";
import { RESTART_CHOICE } from "../shared/constants.js";
import type { ContainerJob, IncidentNotice, Job, JobResult, Outcome, WorkItem } from "../shared/protocol.js";
import { ControlPlaneError } from "./control-plane-client.js";
import { DockerClient } from "./docker-client.js";
import { Executor } from "./executor.js";
import type { FollowedRun } from "./host-package-jobs.js";
import { RemedyGuard } from "./remedy-guard.js";
import { ApprovedWork } from "./approved-work.js";

const item = (overrides: Partial<WorkItem> = {}): WorkItem => ({
  id: "w1",
  incidentId: "i1",
  containerName: "paperless",
  action: "restart",
  target: "paperless",
  approvedBy: "admin",
  expiresAt: Date.now() + 60_000,
  ...overrides,
});

describe("ApprovedWork", () => {
  let engine: FakeDockerEngine;
  let reported: [string, Outcome][];
  let jobResults: [string, JobResult][];
  let notifications: IncidentNotice[];
  let reportFailures: number;
  let refusedForGood: Set<string>;
  const protectedContainers = new Set(["npm"]);

  beforeEach(async () => {
    engine = await FakeDockerEngine.start();
    engine.add(exitedContainer("paperless"));
    engine.add(exitedContainer("tika"));
    engine.add(exitedContainer("npm"));
    reported = [];
    jobResults = [];
    notifications = [];
    reportFailures = 0;
    refusedForGood = new Set();
  });

  afterEach(() => engine.close());

  // A package run that ends only when the test says so.
  let finishUpgrade: (result: JobResult) => void;
  const upgradeResult = () =>
    new Promise<JobResult>((resolve) => {
      finishUpgrade = resolve;
    });

  const approvedWorkFor = (
    items: WorkItem[],
    jobs: Job[] = [],
    followable: FollowedRun[] = [],
    executor?: Pick<Executor, "carryOut">,
    runJob?: (job: Job) => Promise<JobResult>,
  ) => {
    const docker = new DockerClient(engine.socketPath);
    const time = instantTime();
    return new ApprovedWork({
      controlPlane: {
        takeWork: async () => ({ items: items.splice(0), jobs: jobs.splice(0) }),
        reportJobResult: async (id, result) => {
          jobResults.push([id, result]);
        },
        reportWorkResult: async (id, outcome) => {
          if (refusedForGood.has(id)) {
            throw new ControlPlaneError(404, '{"error":"work_item_not_found"}');
          }
          if (reportFailures > 0) {
            reportFailures -= 1;
            throw new Error("control plane unreachable");
          }
          reported.push([id, outcome]);
        },
      },
      docker,
      // Every container here asks first: a person's approval is that answer, so it restarts all the same.
      executor:
        executor ??
        new Executor(
          docker,
          new RemedyGuard(protectedContainers),
          { dryRun: false, protectedContainers },
          () => RESTART_CHOICE.ask,
          time.wait,
          time.clock,
        ),
      jobs: {
        run:
          runJob ??
          (async (job) => ({ succeeded: true, outcome: `ran ${job.action} on ${job.containerName}`, output: null })),
      },
      hostJobs: { run: () => upgradeResult(), followable: async () => followable },
      notify: async (notice) => {
        notifications.push(notice);
      },
      settings: { protectedContainers },
    });
  };

  // Approved actions run in the background; what each did goes out with the poll after it.
  const runToTheEnd = async (work: ApprovedWork) => {
    await work.runOnce();
    await work.settled();
    await work.runOnce();
  };

  it("runs an approved restart on a container that is still broken, and links the incident", async () => {
    await runToTheEnd(approvedWorkFor([item()]));
    expect(engine.restarts).toEqual(["paperless"]);
    expect(reported).toEqual([["w1", { outcome: "Restarted paperless.", verdict: "restarted", executed: true }]]);
    expect(notifications[0]).toMatchObject({
      containerName: "paperless",
      verdict: "restarted",
      diagnosis: "Approved by admin.",
      incidentId: "i1",
    });
  });

  it("runs container actions people asked for, and reports what each did", async () => {
    const job: Job = {
      id: "j1",
      containerName: "tika",
      action: "stop",
      requestedBy: "admin",
      expiresAt: Date.now() + 60_000,
    };
    const work = approvedWorkFor([], [job, { ...job, id: "j2", action: "logs" }]);
    await work.runOnce();
    await work.settled();
    expect(jobResults).toEqual([
      ["j1", { succeeded: true, outcome: "ran stop on tika", output: null }],
      ["j2", { succeeded: true, outcome: "ran logs on tika", output: null }],
    ]);
  });

  it("runs three containers' actions at once, each container's in order, and reports each once", async () => {
    const asked = (id: string, containerName: string, action: "stop" | "remove" | "restart"): Job => ({
      id,
      containerName,
      action,
      requestedBy: "admin",
      expiresAt: Date.now() + 60_000,
    });
    const jobs = [
      asked("j1", "a", "stop"),
      asked("j2", "b", "restart"),
      asked("j3", "a", "remove"),
      asked("j4", "c", "restart"),
      asked("j5", "d", "restart"),
    ];
    let running = 0;
    let most = 0;
    const order: string[] = [];
    const run = async (job: Job): Promise<JobResult> => {
      running += 1;
      most = Math.max(most, running);
      order.push(`${job.id} began`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`${job.id} ended`);
      running -= 1;
      return { succeeded: true, outcome: `ran ${job.id}`, output: null };
    };

    const work = approvedWorkFor([], jobs, [], undefined, run);
    await work.runOnce();
    await work.settled();
    expect(most).toBe(3);
    expect(order.indexOf("j3 began")).toBeGreaterThan(order.indexOf("j1 ended"));
    expect(jobResults.map(([id]) => id).toSorted()).toEqual(["j1", "j2", "j3", "j4", "j5"]);
  });

  describe("while a long job runs", () => {
    const asked = (id: string, containerName: string, action: ContainerJob["action"]): Job => ({
      id,
      containerName,
      action,
      requestedBy: "admin",
      expiresAt: Date.now() + 60_000,
    });
    const imageRemoval = (id: string): Job => ({
      id,
      containerName: "",
      action: "remove_images",
      images: ["sha256:old"],
      requestedBy: "admin",
      expiresAt: Date.now() + 60_000,
    });
    // Each job ends when the test says so; what began and ended, in order.
    let order: string[];
    let finish: Map<string, () => void>;
    const run = (job: Job) =>
      new Promise<JobResult>((resolve) => {
        order.push(`${job.id} began`);
        finish.set(job.id, () => {
          order.push(`${job.id} ended`);
          resolve({ succeeded: true, outcome: `ran ${job.id}`, output: null });
        });
      });
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    beforeEach(() => {
      order = [];
      finish = new Map();
    });

    it("takes the next poll's jobs at once: a restart does not wait for an update elsewhere", async () => {
      const jobs = [asked("j1", "jellyfin", "update")];
      const work = approvedWorkFor([], jobs, [], undefined, run);
      await work.runOnce();
      jobs.push(asked("j2", "tika", "restart"));
      await work.runOnce();
      await settle();
      finish.get("j2")!();
      await settle();

      expect(order).toEqual(["j1 began", "j2 began", "j2 ended"]);
      expect(jobResults.map(([id]) => id)).toEqual(["j2"]);
      finish.get("j1")!();
      await work.settled();
      expect(jobResults.map(([id]) => id)).toEqual(["j2", "j1"]);
    });

    it("keeps one container's jobs in the order asked, across polls", async () => {
      const jobs = [asked("j1", "tika", "stop")];
      const work = approvedWorkFor([], jobs, [], undefined, run);
      await work.runOnce();
      jobs.push(asked("j2", "tika", "remove"));
      await work.runOnce();
      await settle();
      expect(order).toEqual(["j1 began"]);

      finish.get("j1")!();
      await settle();
      finish.get("j2")!();
      await work.settled();
      expect(order).toEqual(["j1 began", "j1 ended", "j2 began", "j2 ended"]);
    });

    it("removes images alone: never beside an update that may have just pulled one", async () => {
      const jobs = [asked("j1", "jellyfin", "update")];
      const work = approvedWorkFor([], jobs, [], undefined, run);
      await work.runOnce();
      jobs.push(imageRemoval("j2"), asked("j3", "tika", "restart"));
      await work.runOnce();
      await settle();
      // The removal waits for the update; the restart asked after it may still go beside the update.
      expect(order).toEqual(["j1 began", "j3 began"]);

      finish.get("j1")!();
      await settle();
      expect(order).toEqual(["j1 began", "j3 began", "j1 ended"]);
      finish.get("j3")!();
      await settle();
      expect(order.at(-1)).toBe("j2 began");

      jobs.push(asked("j4", "tika", "stop"));
      await work.runOnce();
      await settle();
      expect(order.at(-1)).toBe("j2 began");
      finish.get("j2")!();
      await settle();
      expect(order.at(-1)).toBe("j4 began");
      finish.get("j4")!();
      await work.settled();
      expect(jobResults.map(([id]) => id)).toEqual(["j1", "j3", "j2", "j4"]);
    });
  });

  it("runs a package job in the background and reports it at the poll after it ends", async () => {
    const upgrade: Job = {
      id: "h1",
      containerName: "",
      action: "upgrade_packages",
      packages: ["openssl"],
      requestedBy: "admin",
      expiresAt: Date.now() + 60_000,
    };
    const stop: Job = {
      id: "j1",
      containerName: "tika",
      action: "stop",
      requestedBy: "admin",
      expiresAt: upgrade.expiresAt,
    };
    const work = approvedWorkFor([], [upgrade, stop]);

    await work.runOnce();
    await work.settled();
    expect(jobResults.map(([id]) => id)).toEqual(["j1"]);

    finishUpgrade({ succeeded: true, outcome: "Upgraded openssl.", output: null });
    await new Promise((resolve) => setImmediate(resolve));
    await work.runOnce();

    expect(jobResults).toEqual([
      ["j1", { succeeded: true, outcome: "ran stop on tika", output: null }],
      ["h1", { succeeded: true, outcome: "Upgraded openssl.", output: null }],
    ]);
  });

  it("after a restart, reports the package runs it finds on the host once they end", async () => {
    const work = approvedWorkFor(
      [],
      [],
      [{ jobId: "h9", result: Promise.resolve({ succeeded: true, outcome: "The upgrade finished.", output: null }) }],
    );

    await work.resumeHostRuns();
    await new Promise((resolve) => setImmediate(resolve));
    await work.runOnce();

    expect(jobResults).toEqual([["h9", { succeeded: true, outcome: "The upgrade finished.", output: null }]]);
  });

  it("does not hold up the dashboard's actions while an approved restart is still being watched", async () => {
    let watched: (outcome: Outcome) => void = () => undefined;
    let started: () => void = () => undefined;
    const watching = new Promise<void>((resolve) => {
      started = resolve;
    });
    // A restart still being watched: it ends when the test says so.
    const executor = {
      carryOut: () =>
        new Promise<Outcome>((resolve) => {
          watched = resolve;
          started();
        }),
    };
    const stop: Job = {
      id: "j1",
      containerName: "tika",
      action: "stop",
      requestedBy: "admin",
      expiresAt: Date.now() + 60_000,
    };
    const work = approvedWorkFor([item()], [stop], [], executor);

    await work.runOnce();
    await watching;
    await new Promise((resolve) => setImmediate(resolve));
    expect(jobResults.map(([id]) => id)).toEqual(["j1"]);
    expect(reported).toEqual([]);

    watched({ outcome: "Restarted paperless.", verdict: "restarted", executed: true });
    await work.settled();
    await work.runOnce();
    expect(reported).toEqual([["w1", { outcome: "Restarted paperless.", verdict: "restarted", executed: true }]]);
  });

  it("reports a result again later when the control plane did not accept it", async () => {
    reportFailures = 1;
    const runner = approvedWorkFor([item()]);
    await runToTheEnd(runner);
    expect(engine.restarts).toEqual(["paperless"]);
    expect(reported).toEqual([]);
    expect(runner.pendingResults).toBe(1);
    await runner.runOnce();
    expect(reported.map(([id]) => id)).toEqual(["w1"]);
    expect(runner.pendingResults).toBe(0);
  });

  it("drops a result refused for good while later results still get through", async () => {
    refusedForGood = new Set(["w1"]);
    const runner = approvedWorkFor([item(), item({ id: "w2", containerName: "tika", target: "tika" })]);
    await runToTheEnd(runner);
    expect(engine.restarts.toSorted()).toEqual(["paperless", "tika"]);
    expect(reported.map(([id]) => id)).toEqual(["w2"]);
    // Not sent again at every poll: the control plane will never take it.
    expect(runner.pendingResults).toBe(0);
  });

  it("leaves a container that recovered on its own alone", async () => {
    engine.add(exitedContainer("paperless", { State: { Status: "running", Running: true } }));
    await runToTheEnd(approvedWorkFor([item()]));
    expect(engine.restarts).toEqual([]);
    expect(reported[0]![1]).toMatchObject({ verdict: "no longer needed", executed: false });
  });

  it("does not run a job container that finished cleanly, approval or not", async () => {
    engine.add(
      exitedContainer("paperless", {
        State: { Status: "exited", Running: false, ExitCode: 0 },
        HostConfig: { RestartPolicy: { Name: "no" } },
      }),
    );
    await runToTheEnd(approvedWorkFor([item()]));
    expect(engine.restarts).toEqual([]);
    expect(reported[0]![1]).toMatchObject({ verdict: "no longer needed", executed: false });
  });

  it("still refuses a protected target, approved or not", async () => {
    await runToTheEnd(approvedWorkFor([item({ action: "restart_dependency", target: "npm" })]));
    expect(engine.restarts).toEqual([]);
    expect(reported[0]![1]).toMatchObject({ verdict: "needs you" });
  });
});
