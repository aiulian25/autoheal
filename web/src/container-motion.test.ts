import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContainerView, JobView } from "../../src/shared/api.js";
import { AWAIT_REPORT_MILLISECONDS, MOTION_MILLISECONDS } from "./constants.js";
import { motionOf, useContainerMotion, workOf } from "./container-motion.js";

const container = (overrides: Partial<ContainerView> = {}) =>
  ({
    name: "jellyfin",
    containerId: "aaaaaaaaaaaa",
    state: "running",
    startedAt: 1_000,
    problem: null,
    ...overrides,
  }) as ContainerView;

const job = (overrides: Partial<JobView> = {}) =>
  ({
    id: "j1",
    containerName: "jellyfin",
    action: "update",
    status: "delivered",
    progress: null,
    stack: null,
    ...overrides,
  }) as JobView;

describe("what changed in a container between two reports", () => {
  it("tells each change a person sees, and nothing when only its numbers moved", () => {
    const running = container();
    expect(motionOf(running, container({ containerId: "bbbbbbbbbbbb" }))).toBe("updated");
    expect(motionOf(running, container({ state: "exited" }))).toBe("stopped");
    expect(motionOf(container({ state: "exited" }), running)).toBe("started");
    expect(motionOf(running, container({ state: "paused" }))).toBe("paused");
    expect(motionOf(container({ state: "paused" }), running)).toBe("started");
    expect(motionOf(running, container({ startedAt: 9_000 }))).toBe("restarted");
    expect(motionOf(running, container({ state: "exited", problem: "crashed" }))).toBe("failed");
    expect(motionOf(running, container({ restartCount: 3 }))).toBeNull();
  });
});

describe("the jobs working on a host's containers", () => {
  it("names the newest job on its way for each container, and leaves out reading logs and ended ones", () => {
    const working = workOf([
      job({ id: "j3", action: "restart", status: "pending" }),
      job({ id: "j2" }),
      job({ id: "j4", containerName: "tika", action: "logs", status: "pending" }),
      job({ id: "j5", containerName: "paperless", action: "stop", status: "succeeded" }),
    ]);
    expect([...working].map(([name, entry]) => [name, entry.id])).toEqual([["jellyfin", "j3"]]);
  });

  it("puts a stack job on every container of its Compose project, and on no other", () => {
    const rows = [
      container({ name: "immich-server", composeProject: "immich" }),
      container({ name: "immich-db", composeProject: "immich" }),
      container({ name: "jellyfin", composeProject: null }),
    ];
    const working = workOf([job({ id: "s1", containerName: "", action: "stack_up", stack: "immich" })], rows);
    expect([...working.keys()]).toEqual(["immich-server", "immich-db"]);
  });
});

describe("each row's change, seen for a moment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const watch = (containers: ContainerView[], jobs: JobView[] = []) =>
    renderHook(({ containers, jobs }) => useContainerMotion(containers, jobs), {
      initialProps: { containers, jobs },
    });

  it("moves nothing on the first list, then shows each change until its moment has passed", () => {
    const tika = container({ name: "tika", containerId: "cccccccccccc" });
    const hook = watch([container(), tika]);
    expect(hook.result.current.motions.size).toBe(0);

    hook.rerender({ containers: [container({ state: "exited" }), container({ name: "redis" })], jobs: [] });
    expect([...hook.result.current.motions]).toEqual([
      ["jellyfin", "stopped"],
      ["redis", "appeared"],
      ["tika", "removed"],
    ]);
    // The removed one is still drawn, as it was, while it fades.
    expect(hook.result.current.ghosts).toEqual([tika]);

    act(() => vi.advanceTimersByTime(MOTION_MILLISECONDS));
    expect(hook.result.current.motions.size).toBe(0);
    expect(hook.result.current.ghosts).toEqual([]);
  });

  it("keeps a newer change when an older one's moment ends", () => {
    const hook = watch([container()]);
    hook.rerender({ containers: [container({ state: "exited" })], jobs: [] });
    act(() => vi.advanceTimersByTime(MOTION_MILLISECONDS / 2));
    hook.rerender({ containers: [container()], jobs: [] });
    act(() => vi.advanceTimersByTime(MOTION_MILLISECONDS / 2));
    expect(hook.result.current.motions.get("jellyfin")).toBe("started");
  });

  it("drops a removed one's fading row the moment a container of its name is back", () => {
    const hook = watch([container()]);
    hook.rerender({ containers: [], jobs: [] });
    hook.rerender({ containers: [container({ containerId: "dddddddddddd" })], jobs: [] });
    expect(hook.result.current.ghosts).toEqual([]);
    expect(hook.result.current.motions.get("jellyfin")).toBe("appeared");
  });

  it("moves a row once its job ended, as the report shows the outcome, or red when the job failed", () => {
    const working = [job(), job({ id: "j2", containerName: "tika", action: "restart" })];
    const hook = watch([container(), container({ name: "tika" })], working);
    // Both changed while their jobs ran: nothing moves yet.
    const changed = [container({ containerId: "bbbbbbbbbbbb" }), container({ name: "tika", startedAt: 9_000 })];
    hook.rerender({ containers: changed, jobs: working });
    expect(hook.result.current.motions.size).toBe(0);

    hook.rerender({
      containers: changed,
      jobs: [
        job({ status: "failed" }),
        job({ id: "j2", containerName: "tika", action: "restart", status: "succeeded" }),
      ],
    });
    expect([...hook.result.current.motions]).toEqual([
      ["jellyfin", "failed"],
      ["tika", "restarted"],
    ]);
  });

  it("moves a row whose job ended before its report came when the report comes, and only then", () => {
    const restarting = [job({ action: "restart" })];
    const hook = watch([container()], restarting);
    const restarted = [job({ action: "restart", status: "succeeded" })];
    hook.rerender({ containers: [container()], jobs: restarted });
    expect(hook.result.current.motions.size).toBe(0);

    hook.rerender({ containers: [container({ startedAt: 9_000 })], jobs: restarted });
    expect([...hook.result.current.motions]).toEqual([["jellyfin", "restarted"]]);
    act(() => vi.advanceTimersByTime(MOTION_MILLISECONDS));
    hook.rerender({ containers: [container({ startedAt: 9_000, restartCount: 1 })], jobs: restarted });
    expect(hook.result.current.motions.size).toBe(0);
  });

  it("keeps a row whose job went well at work until the report shows its outcome, a few seconds at most", () => {
    const starting = [job({ action: "start" })];
    const hook = watch([container({ state: "exited" })], starting);
    const started = [job({ action: "start", status: "succeeded" })];
    hook.rerender({ containers: [container({ state: "exited" })], jobs: started });
    expect([...hook.result.current.awaiting.keys()]).toEqual(["jellyfin"]);
    expect(hook.result.current.motions.size).toBe(0);

    hook.rerender({ containers: [container()], jobs: started });
    expect(hook.result.current.awaiting.size).toBe(0);
    expect([...hook.result.current.motions]).toEqual([["jellyfin", "started"]]);

    // A start of one already running changes nothing a report shows: the row is let go all the same.
    const again = [job({ id: "j2", action: "start" })];
    hook.rerender({ containers: [container()], jobs: again });
    hook.rerender({ containers: [container()], jobs: [job({ id: "j2", action: "start", status: "succeeded" })] });
    expect([...hook.result.current.awaiting.keys()]).toEqual(["jellyfin"]);
    act(() => vi.advanceTimersByTime(AWAIT_REPORT_MILLISECONDS));
    expect(hook.result.current.awaiting.size).toBe(0);
  });

  it("holds a row its job works on when a report catches the container gone, and moves it once as the job ends", () => {
    const updating = [job()];
    const hook = watch([container(), container({ name: "tika" })], updating);
    // The update renamed the old container and has not made the new one yet.
    hook.rerender({ containers: [container({ name: "tika" })], jobs: updating });
    expect(hook.result.current.motions.size).toBe(0);
    expect(hook.result.current.held).toEqual([container()]);

    const replaced = [container({ containerId: "bbbbbbbbbbbb" }), container({ name: "tika" })];
    hook.rerender({ containers: replaced, jobs: updating });
    expect(hook.result.current.held).toEqual([]);
    hook.rerender({ containers: replaced, jobs: [job({ status: "succeeded" })] });
    expect([...hook.result.current.motions]).toEqual([["jellyfin", "updated"]]);
  });

  it("fades a removed container's row once its removal is done, not while it runs", () => {
    const removing = [job({ action: "remove" })];
    const hook = watch([container()], removing);
    hook.rerender({ containers: [], jobs: removing });
    expect(hook.result.current.ghosts).toEqual([]);
    expect(hook.result.current.held).toEqual([container()]);

    hook.rerender({ containers: [], jobs: [job({ action: "remove", status: "succeeded" })] });
    expect(hook.result.current.ghosts).toEqual([container()]);
    expect([...hook.result.current.motions]).toEqual([["jellyfin", "removed"]]);
    expect(hook.result.current.held).toEqual([]);
  });

  it("keeps quiet about what a job's own steps change, and still shows what changed on its own", () => {
    const updating = [job()];
    const hook = watch([container(), container({ name: "tika" })], updating);
    // The update stops the old container and starts a new one under the name; tika crashes meanwhile.
    hook.rerender({
      containers: [
        container({ containerId: "bbbbbbbbbbbb" }),
        container({ name: "tika", state: "exited", problem: "crashed" }),
        container({ name: "jellyfin-autoheal-old", state: "exited" }),
      ],
      jobs: updating,
    });
    expect([...hook.result.current.motions]).toEqual([
      ["tika", "failed"],
      ["jellyfin-autoheal-old", "appeared"],
    ]);
  });
});
