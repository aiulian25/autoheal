import { describe, expect, it, vi } from "vitest";
import { ApprovedWork, type ApprovedWorkDependencies } from "./approved-work.js";
import type { JobResult } from "../shared/protocol.js";
const barrier = <Value>() => {
  let release!: (value: Value) => void;
  return {
    promise: new Promise<Value>((resolve) => {
      release = resolve;
    }),
    release: (value: Value) => release(value),
  };
};
const done: JobResult = { succeeded: true, outcome: "done", output: null };
describe("approved-work shutdown", () => {
  it("drains an admitted poll and its jobs, refuses new polls, and flushes without taking more work", async () => {
    const poll = barrier<Awaited<ReturnType<ApprovedWorkDependencies["controlPlane"]["takeWork"]>>>();
    const action = barrier<JobResult>();
    const takeWork = vi.fn(() => poll.promise);
    const reportJobResult = vi.fn(async () => {});
    const run = vi.fn(() => action.promise);
    const work = new ApprovedWork({
      controlPlane: { takeWork, reportJobResult, reportWorkResult: async () => {} },
      docker: { inspect: async () => null, containerNames: async () => new Set() },
      executor: {
        carryOut: async () => {
          throw new Error("unexpected");
        },
      },
      jobs: { run },
      hostJobs: { run: async () => done, followable: async () => [] },
      notify: async () => {},
      settings: { protectedContainers: new Set() },
    });
    const polling = work.runOnce();
    let settled = false;
    const drain = work.settled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    work.stop();
    poll.release({
      items: [],
      jobs: [
        { id: "job-1", action: "start", containerName: "app", requestedBy: "admin", expiresAt: Date.now() + 60000 },
      ],
    });
    await polling;
    await work.runOnce();
    expect(takeWork).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    action.release(done);
    await drain;
    await work.flush();
    expect(reportJobResult).toHaveBeenCalledWith("job-1", done);
    expect(takeWork).toHaveBeenCalledTimes(1);
  });
  it("keeps draining an earlier job when the last admitted poll fails", async () => {
    const action = barrier<JobResult>();
    let polls = 0;
    const work = new ApprovedWork({
      controlPlane: {
        takeWork: async () => {
          if (++polls > 1) throw new Error("offline");
          return {
            items: [],
            jobs: [
              { id: "job", action: "start", containerName: "app", requestedBy: "admin", expiresAt: Date.now() + 60000 },
            ],
          };
        },
        reportJobResult: async () => {},
        reportWorkResult: async () => {},
      },
      docker: { inspect: async () => null, containerNames: async () => new Set() },
      executor: {
        carryOut: async () => {
          throw new Error("unexpected");
        },
      },
      jobs: { run: () => action.promise },
      hostJobs: { run: async () => done, followable: async () => [] },
      notify: async () => {},
      settings: { protectedContainers: new Set() },
    });
    await work.runOnce();
    const poll = work.runOnce();
    work.stop();
    let finished = false;
    const drain = work.settled().then(() => {
      finished = true;
    });
    await expect(poll).rejects.toThrow("offline");
    expect(finished).toBe(false);
    action.release(done);
    await drain;
    expect(finished).toBe(true);
  });
});
