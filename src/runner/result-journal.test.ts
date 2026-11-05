import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { guardStateFixture } from "../../test/support/guard-state.js";
import { ResultJournal, type ResultKind, type ResultReport } from "./result-journal.js";
import { Decider } from "./decider.js";
import { ControlPlaneClient, ControlPlaneError, refusedForGood } from "./control-plane-client.js";
import { ApprovedWork, type ApprovedWorkDependencies } from "./approved-work.js";
import type { IncidentSubmission, Outcome } from "../shared/protocol.js";
import { JOB_OUTCOMES } from "../shared/constants.js";

const outcome: Outcome = { outcome: "Restarted app.", verdict: "restarted", executed: true };
const submission: IncidentSubmission = {
  detectedAt: 1,
  report: {
    containerName: "app",
    image: "app:1",
    trigger: "die",
    stateSummary: "exited",
    healthOutputs: [],
    knownContainers: ["app"],
    protectedContainers: [],
    logs: "redacted",
  },
};
const kinds: ResultKind[] = ["incident", "handled", "work", "job"];
const reportFor = (kind: ResultKind, id: string): ResultReport =>
  kind === "job"
    ? { kind, id, result: { succeeded: true, outcome: "done", output: null } }
    : kind === "handled"
      ? {
          kind,
          id,
          result: {
            ...submission,
            resultId: id,
            decision: { action: "restart", target: "app", diagnosis: "crashed" },
            result: outcome,
          },
        }
      : { kind, id, result: outcome };

describe("durable action results", () => {
  it.each(kinds)("replays only the %s report after a response is lost and the runner restarts", async (kind) => {
    const { store, volumes } = guardStateFixture();
    const journal = await ResultJournal.open(store);
    const id = randomUUID();
    let executions = 0;
    if (await journal.reserve(kind, id)) executions++;
    await journal.complete(reportFor(kind, id));
    const accepted = new Map();
    const send = vi.fn(async (report: ResultReport) => {
      accepted.set(`${report.kind}:${report.id}`, report);
      if (send.mock.calls.length === 1) throw new Error("response lost after commit");
    });
    await journal.flush(kinds, send);
    const restarted = await ResultJournal.open(store);
    if (await restarted.reserve(kind, id)) executions++;
    await restarted.flush(kinds, send);
    expect(executions).toBe(1);
    expect(accepted.size).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect((await ResultJournal.open(store)).count(kinds)).toBe(0);
    expect(volumes.size).toBe(1);
  });

  it("drops a result the control plane refuses for good, and keeps one refused for now", async () => {
    const { store } = guardStateFixture();
    const journal = await ResultJournal.open(store);
    const [finished, busy] = [randomUUID(), randomUUID()];
    for (const id of [finished, busy]) {
      await journal.reserve("job", id);
      await journal.complete(reportFor("job", id));
    }
    // A job already over, as a runner that re-follows an old package run reports it; and a moment of rate limiting.
    const send = vi.fn(async (report: ResultReport) => {
      throw new ControlPlaneError(report.id === finished ? 404 : 429, "{}");
    });
    await journal.flush(kinds, send, refusedForGood);
    expect(journal.count(kinds)).toBe(1);

    const restarted = await ResultJournal.open(store);
    await restarted.flush(kinds, send, refusedForGood);
    expect(send.mock.calls.slice(2).map(([report]) => report.id)).toEqual([busy]);
  });

  it("fails closed on capacity, interruption, corrupt storage and publication errors", async () => {
    const f = guardStateFixture();
    const journal = await ResultJournal.open(f.store, 1);
    await journal.reserve("job", "first");
    await expect(journal.reserve("job", "second")).rejects.toThrow("full");
    const restarted = await ResultJournal.open(f.store, 1);
    expect(await restarted.reserve("job", "first")).toBe(false);
    await expect(restarted.complete(reportFor("job", "first"))).rejects.toThrow("reconciliation");
    expect(restarted.count(kinds)).toBe(1);
    f.store.createVolume = async () => {
      throw new Error("disk full");
    };
    await expect(ResultJournal.open(f.store)).rejects.toThrow("unavailable");
    f.volumes.values().next().value!.Labels!["autoheal.result.record"] = "corrupt";
    await expect(ResultJournal.open(f.store)).rejects.toThrow("corrupt");
  });

  it("retains an acknowledged report if local acknowledgement persistence fails", async () => {
    const f = guardStateFixture();
    const journal = await ResultJournal.open(f.store);
    await journal.reserve("job", "first");
    await journal.complete(reportFor("job", "first"));
    f.store.createVolume = async () => {
      throw new Error("disk full");
    };
    await expect(journal.flush(kinds, async () => {})).rejects.toThrow("persistence failed");
    const restarted = await ResultJournal.open({
      ...f.store,
      createVolume: async (Name, Labels) => {
        f.volumes.set(Name, { Name, Labels });
      },
    });
    expect(restarted.count(kinds)).toBe(1);
    const send = vi.fn(async () => {});
    await restarted.flush(kinds, send);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([null, randomUUID()])(
    "recovers Decider delivery with incident ID %s without repeating the action",
    async (incidentId) => {
      const f = guardStateFixture();
      const client = new ControlPlaneClient({ url: "https://unused.test", token: "unused", pin: null });
      let online = false;
      const send = vi.fn(async () => {
        if (!online) throw new Error("offline");
      });
      client.reportOutcome = send;
      client.submitHandled = send;
      const first = new Decider(client, () => null, undefined, await ResultJournal.open(f.store));
      const decided = {
        incidentId,
        decision: { action: "restart" as const, target: "app", diagnosis: "crashed" },
        decidedBy: "model" as const,
      };
      await first.prepareOutcome(submission, decided);
      await first.recordOutcome(submission, decided, outcome);
      await first.flushOutbox();
      online = true;
      const restored = new Decider(client, () => null, undefined, await ResultJournal.open(f.store));
      await restored.flushOutbox();
      expect(restored.pendingHandled).toBe(0);
      expect(send.mock.calls.length).toBeGreaterThan(1);
    },
  );

  it("saves approved outcomes before notifications and refuses execution when full", async () => {
    const f = guardStateFixture();
    const journal = await ResultJournal.open(f.store, 1);
    const run = vi.fn(async () => ({ succeeded: true, outcome: "done", output: null }));
    const dependencies: ApprovedWorkDependencies = {
      controlPlane: {
        takeWork: async () => ({
          items: [],
          jobs: [{ id: "job", action: "start", containerName: "app", requestedBy: "admin", expiresAt: 100 }],
        }),
        reportWorkResult: async () => {},
        reportJobResult: async () => {
          throw new Error("offline");
        },
      },
      docker: { inspect: async () => null, containerNames: async () => new Set() },
      executor: { carryOut: async () => outcome },
      jobs: { run },
      hostJobs: { run, followable: async () => [] },
      notify: async () => {
        throw new Error("notification failed");
      },
      settings: { protectedContainers: new Set() },
    };
    const first = new ApprovedWork(dependencies, journal);
    await first.runOnce();
    await first.settled();
    const reportJobResult = vi.fn(async () => {});
    const restored = new ApprovedWork(
      { ...dependencies, controlPlane: { ...dependencies.controlPlane, reportJobResult } },
      await ResultJournal.open(f.store, 1),
    );
    await restored.flush();
    expect(reportJobResult).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    const full = await ResultJournal.open(f.store, 1);
    await full.reserve("job", "occupied");
    const blocked = new ApprovedWork(dependencies, full);
    await blocked.runOnce();
    await blocked.settled();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

it("does not deliver a result while its durable publication is still pending", async () => {
  const f = guardStateFixture();
  const journal = await ResultJournal.open(f.store);
  await journal.reserve("job", "job");
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const create = f.store.createVolume;
  f.store.createVolume = async (name, labels) => {
    await barrier;
    await create(name, labels);
  };
  const saving = journal.complete(reportFor("job", "job"));
  await new Promise((resolve) => setImmediate(resolve));
  const send = vi.fn(async () => {});
  const sending = journal.flush(kinds, send);
  await new Promise((resolve) => setImmediate(resolve));
  expect(send).not.toHaveBeenCalled();
  release();
  await saving;
  await sending;
  expect(send).toHaveBeenCalledTimes(1);
});

it("retains an approved outcome despite a failed notification and retries it after restart", async () => {
  const f = guardStateFixture();
  const journal = await ResultJournal.open(f.store);
  const execute = vi.fn(async () => outcome);
  const reportWorkResult = vi.fn(async () => {});
  const deps: ApprovedWorkDependencies = {
    controlPlane: {
      takeWork: async () => ({
        items: [
          {
            id: "work",
            incidentId: "incident",
            containerName: "app",
            action: "restart",
            target: "app",
            approvedBy: "admin",
            expiresAt: 100,
          },
        ],
        jobs: [],
      }),
      reportWorkResult,
      reportJobResult: async () => {},
    },
    docker: {
      inspect: async () => ({
        Id: "app",
        Name: "/app",
        Config: { Image: "app:1" },
        State: { Running: false, Status: "exited", ExitCode: 1 },
        HostConfig: { RestartPolicy: { Name: "no" } },
      }),
      containerNames: async () => new Set(["app"]),
    },
    executor: { carryOut: execute },
    jobs: { run: async () => ({ succeeded: true, outcome: "done", output: null }) },
    hostJobs: { run: async () => ({ succeeded: true, outcome: "done", output: null }), followable: async () => [] },
    notify: async () => {
      throw new Error("notification unavailable");
    },
    settings: { protectedContainers: new Set() },
  };
  const work = new ApprovedWork(deps, journal);
  await work.runOnce();
  await work.settled();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(reportWorkResult).not.toHaveBeenCalled();
  const restored = new ApprovedWork(deps, await ResultJournal.open(f.store));
  await restored.flush();
  expect(reportWorkResult).toHaveBeenCalledWith("work", outcome);
  expect(execute).toHaveBeenCalledTimes(1);
});

it("keeps standalone outcomes durably without waiting for a nonexistent server acknowledgement", async () => {
  const f = guardStateFixture();
  const journal = await ResultJournal.open(f.store);
  const decider = new Decider(null, () => null, undefined, journal);
  const decision = {
    incidentId: null,
    decision: { action: "restart" as const, target: "app", diagnosis: "crashed" },
    decidedBy: "agent_fallback" as const,
  };
  await decider.prepareOutcome(submission, decision);
  await decider.recordOutcome(submission, decision, outcome);
  expect(decider.pendingHandled).toBe(0);
  expect((await ResultJournal.open(f.store)).count(["handled"])).toBe(1);
});

it("resumes a host result from an interrupted reservation without launching the host job again", async () => {
  const f = guardStateFixture();
  const before = await ResultJournal.open(f.store);
  await before.reserve("job", "host-job");
  const journal = await ResultJournal.open(f.store);
  const run = vi.fn(async () => ({ succeeded: true, outcome: "finished", output: null }));
  const reportJobResult = vi.fn(async () => {});
  const work = new ApprovedWork(
    {
      controlPlane: {
        takeWork: async () => ({ items: [], jobs: [] }),
        reportWorkResult: async () => {},
        reportJobResult,
      },
      docker: { inspect: async () => null, containerNames: async () => new Set() },
      executor: { carryOut: async () => outcome },
      jobs: { run },
      hostJobs: {
        run,
        followable: async () => [
          { jobId: "host-job", result: Promise.resolve({ succeeded: true, outcome: "finished", output: null }) },
        ],
      },
      notify: async () => {},
      settings: { protectedContainers: new Set() },
    },
    journal,
  );
  // A delegated host run is not an unacknowledged result until it has ended.
  await work.flush();
  await work.resumeHostRuns();
  await new Promise((resolve) => setImmediate(resolve));
  await work.settled();
  await work.flush();
  expect(run).not.toHaveBeenCalled();
  expect(reportJobResult).toHaveBeenCalledWith("host-job", { succeeded: true, outcome: "finished", output: null });
  expect(journal.count(kinds)).toBe(0);
});

it("closes a host job left behind with no run to follow, so the host's next jobs run; a container's stays blocked", async () => {
  const f = guardStateFixture();
  const before = await ResultJournal.open(f.store);
  // A reboot whose runner went down with the host, and an update interrupted on a container.
  await before.reserve("job", "reboot", "host");
  await before.reserve("job", "update", "paperless");
  const journal = await ResultJournal.open(f.store);
  await expect(journal.reserve("job", "check", "host")).rejects.toThrow("requires reconciliation");
  const reportJobResult = vi.fn(async () => {});
  const run = vi.fn(async () => ({ succeeded: true, outcome: "finished", output: null }));
  const work = new ApprovedWork(
    {
      controlPlane: {
        takeWork: async () => ({ items: [], jobs: [] }),
        reportWorkResult: async () => {},
        reportJobResult,
      },
      docker: { inspect: async () => null, containerNames: async () => new Set() },
      executor: { carryOut: async () => outcome },
      jobs: { run },
      // Too long ago: the host has no run of it left to follow.
      hostJobs: { run, followable: async () => [] },
      notify: async () => {},
      settings: { protectedContainers: new Set() },
    },
    journal,
  );
  await work.resumeHostRuns();
  await new Promise((resolve) => setImmediate(resolve));
  await work.settled();
  await work.runOnce();
  expect(reportJobResult).toHaveBeenCalledWith("reboot", {
    succeeded: false,
    outcome: JOB_OUTCOMES.interruptedByRestart,
    output: null,
  });
  expect(run).not.toHaveBeenCalled();
  expect(await journal.reserve("job", "check", "host")).toBe(true);
  await expect(journal.reserve("job", "restart", "paperless")).rejects.toThrow("requires reconciliation");
});

it("answers at once a job the journal will not admit, and never starts it", async () => {
  const f = guardStateFixture();
  await (await ResultJournal.open(f.store)).reserve("job", "update", "paperless");
  const journal = await ResultJournal.open(f.store);
  const reportJobResult = vi.fn(async () => {});
  const run = vi.fn(async () => ({ succeeded: true, outcome: "restarted", output: null }));
  const restart = {
    id: "restart",
    action: "restart" as const,
    containerName: "paperless",
    requestedBy: "admin",
    expiresAt: Date.now() + 60_000,
  };
  const work = new ApprovedWork(
    {
      controlPlane: {
        takeWork: async () => ({ items: [], jobs: [restart] }),
        reportWorkResult: async () => {},
        reportJobResult,
      },
      docker: { inspect: async () => null, containerNames: async () => new Set() },
      executor: { carryOut: async () => outcome },
      jobs: { run },
      hostJobs: { run, followable: async () => [] },
      notify: async () => {},
      settings: { protectedContainers: new Set() },
    },
    journal,
  );
  await work.runOnce();
  await work.settled();
  expect(run).not.toHaveBeenCalled();
  expect(reportJobResult).toHaveBeenCalledWith("restart", {
    succeeded: false,
    outcome: expect.stringContaining("requires reconciliation"),
    output: null,
  });
});

it("blocks a new action ID from bypassing an interrupted action on the same container", async () => {
  const f = guardStateFixture();
  const first = await ResultJournal.open(f.store);
  await first.reserve("handled", randomUUID(), "app");
  const restarted = await ResultJournal.open(f.store);
  await expect(restarted.reserve("handled", randomUUID(), "app")).rejects.toThrow("cannot bypass");
  await expect(restarted.reserve("job", "other-job", "other-app")).resolves.toBe(true);
});

it("closes jobs an earlier runner never finished once asked, so their containers take new jobs, never running them again", async () => {
  const f = guardStateFixture();
  const before = await ResultJournal.open(f.store);
  await before.reserve("job", "start-redis", "redis");
  const journal = await ResultJournal.open(f.store);
  await expect(journal.reserve("job", "start-again", "redis")).rejects.toThrow("requires reconciliation");

  await journal.settleInterrupted();

  expect(await journal.reserve("job", "start-redis", "redis")).toBe(false);
  expect(await journal.reserve("job", "start-again", "redis")).toBe(true);
  const sent: ResultReport[] = [];
  await journal.flush(["job"], async (report) => void sent.push(report));
  expect(sent).toEqual([
    {
      kind: "job",
      id: "start-redis",
      result: { succeeded: false, outcome: JOB_OUTCOMES.interruptedByRestart, output: null },
    },
  ]);
});

it("keeps taking actions when an old snapshot is in use for a moment, and removes it at the next change", async () => {
  const f = guardStateFixture();
  const journal = await ResultJournal.open(f.store);
  const remove = f.store.removeVolume;
  f.store.removeVolume = async () => {
    throw new Error("volume is in use");
  };
  expect(await journal.reserve("job", "first", "app")).toBe(true);
  expect(f.volumes.size).toBe(2);

  f.store.removeVolume = remove;
  expect(await journal.reserve("job", "second", "other")).toBe(true);
  expect(f.volumes.size).toBe(1);
  expect((await ResultJournal.open(f.store)).count(["job"])).toBe(2);
});
