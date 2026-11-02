import { describe, expect, it } from "vitest";
import { containerResources, OperationCoordinator } from "./operation-coordinator.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("runner operation ownership", () => {
  it("acquires whole sets atomically and preserves disjoint parallelism without queue jumping", async () => {
    const coordinator = new OperationCoordinator();
    const a = await coordinator.acquire(["a"]);
    let groupEntered = false;
    const group = coordinator.acquire(["b", "a", "b"]).then((lease) => {
      groupEntered = true;
      return lease;
    });
    const independent = await coordinator.acquire(["c"]);
    expect(groupEntered).toBe(false);
    expect(coordinator.tryAcquire(["b"])).toBeNull();
    a.release();
    const both = await group;
    expect(coordinator.tryAcquire(["a"])).toBeNull();
    expect(coordinator.tryAcquire(["b"])).toBeNull();
    both.release();
    independent.release();
    const free = coordinator.tryAcquire(["a", "b", "c"]);
    expect(free).not.toBeNull();
    free!.release();
  });

  it("does not let an old owner release a subsequent owner's resources", async () => {
    const coordinator = new OperationCoordinator();
    const first = await coordinator.acquire(["a"]);
    const waiting = coordinator.acquire(["a"]);
    first.release();
    const second = await waiting;
    first.release();
    expect(coordinator.tryAcquire(["a"])).toBeNull();
    second.release();
    const third = coordinator.tryAcquire(["a"]);
    expect(third).not.toBeNull();
    third!.release();
  });

  it("reserves a waiting host job against later container/healing work", async () => {
    const coordinator = new OperationCoordinator();
    const container = await coordinator.acquire(["a"]);
    const entered = deferred();
    const finish = deferred();
    const host = coordinator.host(async () => {
      entered.resolve();
      await finish.promise;
    });
    expect(coordinator.tryAcquire(["unrelated"])).toBeNull();
    container.release();
    await entered.promise;
    expect(coordinator.tryAcquire(["a"])).toBeNull();
    finish.resolve();
    await host;
    const next = coordinator.tryAcquire(["a"]);
    expect(next).not.toBeNull();
    next!.release();
  });

  it("releases and reacquires a changed graph rather than upgrading a partial lease", async () => {
    const coordinator = new OperationCoordinator();
    const blocker = await coordinator.acquire(["b"]);
    const waiting = deferred();
    let reads = 0;
    let worked = false;
    const run = coordinator.containers(
      async () => ({ resources: ++reads === 1 ? ["a"] : ["a", "b"] }),
      async () => {
        worked = true;
      },
      waiting.resolve,
    );
    await waiting.promise;
    expect(worked).toBe(false);
    blocker.release();
    await run;
    expect(worked).toBe(true);
  });

  it("releases resources after errors and bounds continuously changing discovery", async () => {
    const coordinator = new OperationCoordinator();
    await expect(
      coordinator.containers(
        async () => ({ resources: ["a"] }),
        async () => {
          throw new Error("failed");
        },
      ),
    ).rejects.toThrow("failed");
    let version = 0;
    await expect(
      coordinator.containers(
        async () => ({ resources: [String(++version)] }),
        async () => {},
      ),
    ).rejects.toThrow("kept changing");
    const lease = coordinator.tryAcquire(["a", ...Array.from({ length: version }, (_, i) => String(i + 1))]);
    expect(lease).not.toBeNull();
    lease!.release();
  });

  it("locks canonical names and immutable IDs, including a requested alias", () => {
    expect(
      containerResources("alias", { Id: "immutable", Name: "/canonical", State: {}, Config: { Image: "app" } }),
    ).toEqual(["id:immutable", "name:alias", "name:canonical"]);
  });
});
