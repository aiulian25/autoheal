import { describe, expect, it, vi } from "vitest";
import { APPLICATION_BOOT_DRILL, APPLICATION_BOOT_TEXT } from "../shared/application-backups.js";
import { HOST_HELPER } from "../shared/constants.js";
import { bootOnClones, type BootDrillDependencies } from "./application-boot-drill.js";

const TASK = "11111111-1111-4111-8111-111111111111";
const NAME = `${APPLICATION_BOOT_DRILL.containerPrefix}${TASK}`;
const TEST_SECRET = "only-for-this-drill";
const INPUT = {
  taskId: TASK,
  imageId: "sha256:backed-up",
  user: "1000:1000",
  volumes: [{ source: "clone-0", target: "/data" }],
  recipe: { readySeconds: 10, environment: [{ name: "APP_PASSWORD", value: TEST_SECRET }] },
};

type Specification = {
  Image: string;
  User: string;
  Env: string[];
  Labels: Record<string, string>;
  HostConfig: Record<string, unknown> & { Mounts: unknown[]; CapAdd: string[] };
};

function stage(state: object = { Running: true }, overrides: Partial<Record<string, unknown>> = {}) {
  let there = false;
  let now = 0;
  const created: Specification[] = [];
  const held: string[] = [];
  const docker = {
    inspectImage: vi.fn(async () => ({ Id: INPUT.imageId })),
    create: vi.fn(async (_name: string, specification: Specification) => {
      created.push(specification);
      there = true;
      return "id";
    }),
    start: vi.fn(async () => undefined),
    inspect: vi.fn(async () => (there ? { State: state } : null)),
    logs: vi.fn(async () => `starting\npassword is ${TEST_SECRET}\ncorrupt database\n`),
    remove: vi.fn(async () => {
      there = false;
    }),
    ...overrides,
  };
  const guard = {
    hold: vi.fn((name: string) => void held.push(`hold ${name} there=${there}`)),
    release: vi.fn((name: string) => void held.push(`release ${name} there=${there}`)),
    persisted: vi.fn(async () => undefined),
  };
  const dependencies = {
    docker,
    guard,
    wait: async () => undefined,
    clock: () => (now += 3000),
  } as unknown as BootDrillDependencies;
  return { dependencies, docker, guard, created, held };
}

describe("starting a backed-up application on its restored copy", () => {
  it("says only that one stayed up without a health check, keeping what it logged, masked", async () => {
    const { dependencies, docker } = stage();
    const evidence = await bootOnClones(dependencies, INPUT);
    expect(evidence).toMatchObject({
      imageId: INPUT.imageId,
      readySeconds: 10,
      readiness: "stayed-running",
      problem: null,
    });
    expect(evidence.logs).toContain("corrupt database");
    expect(evidence.logs).not.toContain(TEST_SECRET);
    expect(docker.remove).toHaveBeenCalledWith(NAME);
  });

  it("counts a passing health check as healthy", async () => {
    const { dependencies } = stage({ Running: true, Health: { Status: "healthy" } });
    const evidence = await bootOnClones(dependencies, INPUT);
    expect(evidence.readiness).toBe("healthy");
    expect(evidence.logs).toBeNull();
  });

  it("fails one that stops, keeping its last lines with the test value masked, and still removes it", async () => {
    const { dependencies, docker } = stage({ Running: false, ExitCode: 3 });
    const evidence = await bootOnClones(dependencies, INPUT);
    expect(evidence.readiness).toBeNull();
    expect(evidence.problem).toBe(APPLICATION_BOOT_TEXT.stopped(3));
    expect(evidence.logs).toContain("corrupt database");
    expect(evidence.logs).not.toContain(TEST_SECRET);
    expect(docker.remove).toHaveBeenCalledOnce();
  });

  it("fails one reporting unhealthy, and one never ready within its time", async () => {
    const unhealthy = stage({ Running: true, Health: { Status: "unhealthy" } });
    expect((await bootOnClones(unhealthy.dependencies, INPUT)).problem).toBe(APPLICATION_BOOT_TEXT.unhealthy);
    const slow = stage({ Running: true, Health: { Status: "starting" } });
    expect((await bootOnClones(slow.dependencies, INPUT)).problem).toBe(APPLICATION_BOOT_TEXT.slow);
  });

  it("gets nothing of the live container but its user, and reaches no network or host path", async () => {
    const { dependencies, created } = stage();
    await bootOnClones(dependencies, INPUT);
    const [specification] = created;
    expect(specification).toMatchObject({
      Image: INPUT.imageId,
      User: INPUT.user,
      Env: [`APP_PASSWORD=${TEST_SECRET}`],
    });
    expect(specification!.HostConfig).toMatchObject({
      Mounts: [{ Type: "volume", Source: "clone-0", Target: "/data" }],
      NetworkMode: "none",
      RestartPolicy: { Name: "no" },
      CapDrop: ["ALL"],
      Memory: APPLICATION_BOOT_DRILL.memoryBytes,
      NanoCpus: APPLICATION_BOOT_DRILL.nanoCpus,
      PidsLimit: APPLICATION_BOOT_DRILL.pidsLimit,
    });
    for (const absent of ["Binds", "PortBindings", "PublishAllPorts", "Privileged", "PidMode", "IpcMode", "UTSMode"]) {
      expect(specification!.HostConfig).not.toHaveProperty(absent);
    }
    expect(specification!.HostConfig.CapAdd).not.toContain("SYS_ADMIN");
    expect(specification).not.toHaveProperty("Cmd");
    // It would empty the container's name servers, and programs that read them will not start: no network is enough.
    expect(specification).not.toHaveProperty("NetworkDisabled");
    expect(specification!.Labels[HOST_HELPER.label]).toBe(HOST_HELPER.labelValue);
    expect(specification!.Labels[APPLICATION_BOOT_DRILL.label]).toBe(TASK);
  });

  it("is held from healing until it is gone, so its stopping is never taken for a failure", async () => {
    const { dependencies, held } = stage({ Running: false, ExitCode: 1 });
    await bootOnClones(dependencies, INPUT);
    expect(held).toEqual([`hold ${NAME} there=false`, `release ${NAME} there=false`]);
  });

  it("says plainly what it could not remove", async () => {
    const { dependencies } = stage(
      {},
      {
        inspect: vi.fn(async () => ({ State: { Running: true } })),
        remove: vi.fn(async () => {
          throw new Error("device busy");
        }),
      },
    );
    expect((await bootOnClones(dependencies, INPUT)).left).toEqual([NAME]);
  });

  it("creates nothing when the backed-up image is gone or was never recorded", async () => {
    const gone = stage({}, { inspectImage: vi.fn(async () => null) });
    expect((await bootOnClones(gone.dependencies, INPUT)).problem).toBe(APPLICATION_BOOT_TEXT.imageGone);
    expect(gone.created).toEqual([]);
    const unknown = stage();
    const evidence = await bootOnClones(unknown.dependencies, { ...INPUT, imageId: null });
    expect(evidence.problem).toBe(APPLICATION_BOOT_TEXT.noImage);
    expect(unknown.created).toEqual([]);
  });

  it("reports a start Docker refuses, and removes what it created", async () => {
    const { dependencies, docker } = stage(
      {},
      {
        start: vi.fn(async () => {
          throw new Error("no such image platform");
        }),
      },
    );
    expect((await bootOnClones(dependencies, INPUT)).problem).toContain("no such image platform");
    expect(docker.remove).toHaveBeenCalledOnce();
  });
});
