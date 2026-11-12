import { describe, expect, it, vi } from "vitest";
import {
  COMPOSE_DEPENDS_ON_LABEL,
  COMPOSE_PROJECT_LABEL,
  COMPOSE_SERVICE_LABEL,
  JOB_ACTION,
  RUNNER_MESSAGES,
} from "../shared/constants.js";
import {
  BACKUP_TEXT,
  CONTAINER_BACKUP,
  COPY_COMMAND,
  type BackupJobDetails,
  type BackupManifest,
} from "../shared/container-backups.js";
import type { Readable, Writable } from "node:stream";
import { manifestSeal } from "./backup-manifest-seal.js";
import { ContainerBackups, type ContainerBackupsDependencies } from "./container-backups.js";
import { OperationCoordinator } from "./operation-coordinator.js";

const GIB = 1024 ** 3;
const SHA = "a".repeat(64);
const KEY = { recipient: "r".repeat(50), sealedKey: "s".repeat(50) };
const RESTORE_ID = "20261001T000000Z";
const HOST = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f";
// This host's own folder within the backup folder, as a person browsing it sees it.
const OWN = `_host_${HOST}`;

interface FakeContainer {
  image?: string;
  mounts?: { type: string; source: string; target: string; rw?: boolean }[];
  running?: boolean;
  project?: string;
  service?: string;
  dependsOn?: string;
  stopTimeout?: number;
}

type Handler = (input: unknown) => object;

/** A Docker engine in memory, and a helper whose answers each test can change. */
function setup(
  fleet: Record<string, FakeContainer>,
  {
    sizes,
    free = 100 * GIB,
    answers = {},
    dryRun = false,
    faults = {},
  }: {
    sizes?: (number | null)[];
    free?: number;
    answers?: Record<string, Handler>;
    dryRun?: boolean;
    // Containers Docker refuses each of these for.
    faults?: { stop?: readonly string[]; start?: readonly string[]; policyBack?: readonly string[] };
  } = {},
) {
  const events: string[] = [];
  // Everything the helper was asked: the command, its arguments, and what it was given on stdin.
  const asked: { what: string; args: readonly string[]; input: unknown }[] = [];
  const helperMounts: unknown[] = [];
  const running = new Map(Object.entries(fleet).map(([name, one]) => [name, one.running !== false]));
  const policies = new Map(Object.keys(fleet).map((name) => [name, "always"]));
  const volumes = new Map<string, Record<string, string>>();
  const helperAnswers: Record<string, Handler> = {
    [COPY_COMMAND.measure]: () => ({ sizes: sizes ?? [1000, 1000, 1000], freeBytes: free }),
    [COPY_COMMAND.capture]: () => ({ bytes: 10, sha256: SHA, sourceBytes: 1000, singleFile: false }),
    [COPY_COMMAND.store]: () => ({ bytes: 10, sha256: SHA, sourceBytes: 1000 }),
    [COPY_COMMAND.verify]: () => ({}),
    [COPY_COMMAND.finish]: () => ({ copyError: null }),
    [COPY_COMMAND.list]: () => ({ manifests: [] }),
    [COPY_COMMAND.empty]: () => ({}),
    [COPY_COMMAND.restore]: () => ({}),
    [COPY_COMMAND.discard]: () => ({}),
    ...answers,
  };
  const details = (name: string) => {
    const one = fleet[name]!;
    return {
      Id: `id-${name}`,
      Name: `/${name}`,
      Image: `sha256:${one.image ?? name}`,
      Config: {
        Image: one.image ?? `${name}:1`,
        ...(one.stopTimeout === undefined ? {} : { StopTimeout: one.stopTimeout }),
        Labels: {
          ...(one.project === undefined ? {} : { [COMPOSE_PROJECT_LABEL]: one.project }),
          ...(one.service === undefined ? {} : { [COMPOSE_SERVICE_LABEL]: one.service }),
          ...(one.dependsOn === undefined
            ? {}
            : { [COMPOSE_DEPENDS_ON_LABEL]: `${one.dependsOn}:service_started:false` }),
        },
      },
      // Docker always says which it is; without it a wait for one that is down has nothing to stop it.
      State: { Running: running.get(name) === true, Status: running.get(name) === true ? "running" : "exited" },
      HostConfig: { RestartPolicy: { Name: policies.get(name), MaximumRetryCount: 0 } },
      Mounts: (one.mounts ?? []).map((mount) => ({
        Type: mount.type,
        Name: mount.source,
        Source: mount.source,
        Destination: mount.target,
        RW: mount.rw !== false,
      })),
    };
  };
  const read = async (input: Readable | undefined) => {
    if (input === undefined) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(Buffer.from(chunk as Buffer));
    const text = Buffer.concat(chunks).toString();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  };
  const docker = {
    containerSummaries: async () => Object.keys(fleet).map((name) => ({ Id: name, Labels: {} })),
    inspect: async (name: string) => (name in fleet ? details(name) : null),
    create: async (_name: string, specification: { HostConfig: { Mounts: unknown[] } }) => {
      helperMounts.push(...specification.HostConfig.Mounts);
      return "helper";
    },
    start: async (name: string) => {
      if (name.startsWith(CONTAINER_BACKUP.containerPrefix)) return;
      if (faults.start?.includes(name)) throw new Error(`cannot start ${name}`);
      events.push(`start ${name}`);
      running.set(name, true);
    },
    stop: async (name: string, _grace?: number) => {
      if (faults.stop?.includes(name)) throw new Error(`cannot stop ${name}`);
      events.push(`stop ${name}`);
      running.set(name, false);
    },
    remove: async () => undefined,
    setRestartPolicy: async (name: string, policy: { Name: string }) => {
      if (policy.Name !== "no" && faults.policyBack?.includes(name))
        throw new Error(`cannot set the policy of ${name}`);
      events.push(`policy ${name} ${policy.Name}`);
      policies.set(name, policy.Name);
    },
    volumes: async () => [...volumes.values()].map((Labels, index) => ({ Name: `v${index}`, Labels })),
    createVolume: async (name: string, labels: Record<string, string>) => {
      volumes.set(name, labels);
    },
    removeVolume: async (name: string) => {
      volumes.delete(name);
    },
    streamCommand: async (
      reference: string,
      command: readonly string[],
      { input, output }: { input?: Readable; output: Writable },
    ) => {
      const given = await read(input);
      if (!reference.startsWith(CONTAINER_BACKUP.containerPrefix)) {
        const line = command.join(" ");
        if (line.includes("pg_isready")) {
          output.end();
          return { exitCode: 0, stderr: "" };
        }
        if (line.includes("pg_database")) output.write("app\n");
        if (line.includes("pg_dumpall")) {
          events.push(`dump ${reference}`);
          output.write(Buffer.from("SQL"));
        }
        if (line.includes("psql -X -q")) events.push(`feed ${reference}`);
        const fault = helperAnswers.databaseFault?.(line) as { exitCode: number; stderr: string } | undefined;
        output.end();
        return fault ?? { exitCode: 0, stderr: "" };
      }
      const what = command[4] ?? "";
      asked.push({ what, args: command.slice(5), input: given });
      if (what === COPY_COMMAND.reveal) {
        output.end(Buffer.from(JSON.stringify({ projects: [], files: [] })));
        return { exitCode: 0, stderr: "" };
      }
      events.push(what);
      try {
        const answer = helperAnswers[what]!(given);
        output.end(`${JSON.stringify({ ok: true, ...answer })}\n`);
        return { exitCode: 0, stderr: "" };
      } catch (error) {
        output.end(`${JSON.stringify({ ok: false, message: (error as Error).message })}\n`);
        return { exitCode: 1, stderr: "" };
      }
    },
  };
  const guard = {
    hold: vi.fn(),
    release: vi.fn(),
    persisted: async () => undefined,
    operations: new OperationCoordinator(),
  };
  const backups = new ContainerBackups({
    docker,
    stacks: null,
    guard,
    settings: { protectedContainers: new Set(["guarded"]), selfContainerName: "autoheal", dryRun },
    helperImage: async () => "sha256:self",
    openKey: async () => IDENTITY,
    reportProgress: async () => undefined,
    sleep: async () => undefined,
  } as unknown as ContainerBackupsDependencies);
  return { backups, docker, events, asked, helperMounts, running, policies, volumes, guard };
}

const job = (over: Partial<BackupJobDetails> = {}): BackupJobDetails => ({
  target: { container: "app", stack: null },
  directory: "/var/backups/autoheal",
  copyDirectory: null,
  include: [],
  key: KEY,
  restoreId: null,
  hostId: HOST,
  ...over,
});
const backUp = (context: ReturnType<typeof setup>, over?: Partial<BackupJobDetails>) =>
  context.backups.run("job-1", JOB_ACTION.backupContainer, job(over));
const restore = (context: ReturnType<typeof setup>, over?: Partial<BackupJobDetails>) =>
  context.backups.run("job-1", JOB_ACTION.restoreContainer, job({ restoreId: RESTORE_ID, ...over }));

const FOLDER = { type: "bind" as const, source: "/srv/app", target: "/config" };
const APP: FakeContainer = { mounts: [FOLDER] };
const failing = (message: string) => () => {
  throw new Error(message);
};

const manifest = (member: Partial<BackupManifest["members"][number]> = {}): BackupManifest => ({
  format: CONTAINER_BACKUP.format,
  id: RESTORE_ID,
  createdAt: 1,
  target: { container: "app", stack: null },
  why: "asked",
  members: [
    {
      name: "app",
      image: "app:1",
      imageId: "sha256:app:1",
      method: "files",
      mounts: [{ ...FOLDER, file: "data-0.tar.age", singleFile: false, sourceBytes: 1000 }],
      dump: null,
      ...member,
    },
  ],
  hasSettings: false,
  leftOut: [],
  files: [{ file: "data-0.tar.age", bytes: 10, sha256: SHA, isTar: true }],
});
const IDENTITY = "AGE-SECRET-KEY";
const sealed = (one: BackupManifest): BackupManifest => ({ ...one, seal: manifestSeal(one, IDENTITY) });
const unchecked = (one: BackupManifest) => ({ [COPY_COMMAND.read]: () => ({ manifest: one, key: "c2VhbGVk" }) });
const readable = (one = manifest()) => ({ [COPY_COMMAND.read]: () => ({ manifest: sealed(one), key: "c2VhbGVk" }) });
// What the helper was given for each time it was asked this.
const inputsOf = (context: ReturnType<typeof setup>, what: string) =>
  context.asked.filter((one) => one.what === what).map(({ input }) => input as Record<string, unknown>);

describe("backing up", () => {
  it("stops it, copies, starts it again, and only then checks and keeps it", async () => {
    const context = setup({ app: APP });
    const { succeeded, outcome } = await backUp(context);
    expect(succeeded).toBe(true);
    expect(outcome).toContain("Backup saved");
    expect(context.events).toEqual(["measure", "stop app", "store", "capture", "start app", "verify", "finish"]);
    expect(context.volumes.size).toBe(0);
    expect(context.guard.release).toHaveBeenCalledWith("app");
  });

  it("does not touch its restart policy: a plain stop does not set one off", async () => {
    const context = setup({ app: APP });
    await backUp(context);
    expect(context.events.some((event) => event.startsWith("policy"))).toBe(false);
  });

  it.each([COPY_COMMAND.capture, COPY_COMMAND.store])("starts it again when %s fails", async (step) => {
    const context = setup({ app: APP }, { answers: { [step]: failing("disk full") } });
    const { succeeded } = await backUp(context);
    expect(succeeded).toBe(false);
    expect(context.running.get("app")).toBe(true);
    expect(context.events).not.toContain("finish");
    expect(context.volumes.size).toBe(0);
  });

  it("is not kept if it does not read back, though the app is already running again", async () => {
    const context = setup({ app: APP }, { answers: { [COPY_COMMAND.verify]: failing("bad copy") } });
    const { succeeded, outcome } = await backUp(context);
    expect(succeeded).toBe(false);
    expect(outcome).toContain("bad copy");
    expect(context.running.get("app")).toBe(true);
    expect(context.events).not.toContain("finish");
  });

  it("stops whatever shares a copied folder too, and nothing else", async () => {
    const context = setup({
      app: APP,
      sharer: { mounts: [{ type: "bind", source: "/srv/app/cache", target: "/c" }] },
      other: { mounts: [{ type: "bind", source: "/srv/other", target: "/c" }] },
    });
    await backUp(context);
    expect(context.events).toContain("stop sharer");
    expect(context.events).not.toContain("stop other");
    expect(context.events).toContain("start sharer");
  });

  it("does not count a shared media library as sharing, while it is left out", async () => {
    const media = { type: "bind", source: "/mnt/media", target: "/media" };
    const context = setup(
      {
        app: { mounts: [FOLDER, media] },
        neighbour: { mounts: [media] },
      },
      { sizes: [1000, 60 * GIB] },
    );
    await backUp(context);
    expect(context.events).not.toContain("stop neighbour");
    expect(context.events.filter((event) => event === COPY_COMMAND.capture)).toHaveLength(1);
  });

  it("copies a large folder only when ticked, and stops what shares it then", async () => {
    const media = { type: "bind", source: "/mnt/media", target: "/media" };
    const context = setup(
      { app: { mounts: [FOLDER, media] }, neighbour: { mounts: [media] } },
      { sizes: [1000, 60 * GIB], free: 100 * GIB },
    );
    await backUp(context, { include: ["/mnt/media"] });
    expect(context.events).toContain("stop neighbour");
    expect(context.events.filter((event) => event === COPY_COMMAND.capture)).toHaveLength(2);
  });

  it("refuses what will not fit, before stopping anything", async () => {
    const context = setup({ app: APP }, { sizes: [2 * GIB], free: GIB });
    const { succeeded, outcome } = await backUp(context, { include: ["/srv/app"] });
    expect(succeeded).toBe(false);
    expect(outcome).toContain("only");
    expect(context.events).not.toContain("stop app");
  });

  it("leaves out a folder it could not measure, rather than guessing", async () => {
    const context = setup(
      { app: { mounts: [FOLDER, { type: "bind", source: "/srv/big", target: "/b" }] } },
      { sizes: [1000, null] },
    );
    await backUp(context);
    expect(context.events.filter((event) => event === COPY_COMMAND.capture)).toHaveLength(1);
  });

  it("never copies the host's own folders", async () => {
    const context = setup({
      app: {
        mounts: [
          FOLDER,
          { type: "bind", source: "/etc/app", target: "/e" },
          { type: "bind", source: "/var/run/docker.sock", target: "/s" },
        ],
      },
    });
    const { preview } = await context.backups.answer({
      id: "1",
      kind: "preview",
      target: job().target,
      directory: job().directory,
      hostId: HOST,
    });
    expect(preview?.mounts.map(({ source }) => source)).toEqual(["/srv/app"]);
  });

  it.each([
    ["autoheal", BACKUP_TEXT.self],
    ["guarded", BACKUP_TEXT.protected("guarded")],
  ])("refuses %s", async (name, words) => {
    const context = setup({ [name]: APP });
    const { succeeded, outcome } = await backUp(context, { target: { container: name, stack: null } });
    expect(succeeded).toBe(false);
    expect(outcome).toBe(words);
    expect(context.events.some((event) => event.startsWith("stop"))).toBe(false);
  });

  it("refuses stopping a protected container that shares its folder", async () => {
    const context = setup({ app: APP, guarded: APP });
    const { outcome } = await backUp(context);
    expect(outcome).toBe(BACKUP_TEXT.protected("guarded"));
    expect(context.events.some((event) => event.startsWith("stop"))).toBe(false);
  });

  it("changes nothing on a dry-run host", async () => {
    const context = setup({ app: APP }, { dryRun: true });
    expect((await backUp(context)).outcome).toBe(BACKUP_TEXT.dryRun);
    expect(context.events).toEqual([]);
  });

  it("says there is nothing to save, for a container with no data", async () => {
    expect((await backUp(setup({ app: {} }))).outcome).toBe(BACKUP_TEXT.nothing);
  });

  it("does one at a time on a host", async () => {
    const context = setup({ app: APP });
    const first = backUp(context);
    expect((await backUp(context)).outcome).toBe(BACKUP_TEXT.otherRun);
    await first;
  });

  describe("a database", () => {
    const DATABASE: FakeContainer = {
      image: "postgres:16",
      mounts: [{ type: "bind", source: "/srv/pg", target: "/var/lib/postgresql/data" }],
    };
    const target = { container: "db", stack: null };

    it("uses its own tool, and is not stopped", async () => {
      const context = setup({ db: DATABASE });
      const { succeeded } = await backUp(context, { target });
      expect(succeeded).toBe(true);
      expect(context.events).toContain("dump db");
      expect(context.events).not.toContain("stop db");
      expect(context.events).not.toContain(COPY_COMMAND.capture);
    });

    it("is copied as files when it is not running, as its tool cannot be asked", async () => {
      const context = setup({ db: { ...DATABASE, running: false } });
      await backUp(context, { target });
      expect(context.events).not.toContain("dump db");
      expect(context.events).toContain(COPY_COMMAND.capture);
    });

    it("fails plainly when its dump fails, and keeps nothing", async () => {
      const context = setup(
        { db: DATABASE },
        {
          answers: {
            databaseFault: ((line: string) =>
              line.includes("pg_dumpall")
                ? { exitCode: 1, stderr: "no such role" }
                : { exitCode: 0, stderr: "" }) as unknown as Handler,
          },
        },
      );
      const { succeeded, outcome } = await backUp(context, { target });
      expect(succeeded).toBe(false);
      expect(outcome).toContain("no such role");
      expect(context.events).not.toContain("finish");
    });

    it("fails plainly when the stream of its dump was cut short, and keeps nothing", async () => {
      const context = setup({ db: DATABASE });
      const streamCommand = context.docker.streamCommand;
      context.docker.streamCommand = async (reference, command, options) => {
        if (!command.join(" ").includes("pg_dumpall")) return streamCommand(reference, command, options);
        // What the Docker client does with a piece left unfinished: it ends the output, then says so.
        options.output.end(Buffer.from("SQL, only the first part of it"));
        throw new Error(RUNNER_MESSAGES.execStreamCutShort);
      };

      const { succeeded, outcome } = await backUp(context, { target });

      expect(succeeded).toBe(false);
      expect(outcome).toContain(RUNNER_MESSAGES.execStreamCutShort);
      expect(context.events).not.toContain("finish");
    });

    it("leaves other databases to stop, copy and start, until each is proven", async () => {
      const context = setup({ db: { ...DATABASE, image: "mariadb:11" } });
      await backUp(context, { target });
      expect(context.events).not.toContain("dump db");
      expect(context.events).toContain("stop db");
    });
  });

  it("backs a stack up as one: app stopped first, database dumped running, app started after", async () => {
    const context = setup({
      web: { project: "wiki", service: "web", dependsOn: "db", mounts: [FOLDER] },
      db: {
        project: "wiki",
        service: "db",
        image: "postgres:16",
        mounts: [{ type: "bind", source: "/srv/pg", target: "/data" }],
      },
    });
    const { succeeded } = await backUp(context, { target: { container: null, stack: "wiki" } });
    expect(succeeded).toBe(true);
    const order = (event: string) => context.events.indexOf(event);
    expect(order("stop web")).toBeLessThan(order("dump db"));
    expect(order("dump db")).toBeLessThan(order("start web"));
    expect(context.events).not.toContain("stop db");
  });

  it("stops what depends on another first, and starts it last", async () => {
    const context = setup({
      web: { project: "s", service: "web", dependsOn: "cache", mounts: [FOLDER] },
      cache: { project: "s", service: "cache", mounts: [{ type: "bind", source: "/srv/cache", target: "/c" }] },
    });
    await backUp(context, { target: { container: null, stack: "s" } });
    const order = (event: string) => context.events.indexOf(event);
    expect(order("stop web")).toBeLessThan(order("stop cache"));
    expect(order("start cache")).toBeLessThan(order("start web"));
  });
});

describe("what a backup or restore holds while it runs", () => {
  const SHARED = { type: "bind" as const, source: "/srv/shared", target: "/data" };
  const NESTED = { type: "bind" as const, source: "/srv/shared/media", target: "/media" };
  const OTHER = { type: "bind" as const, source: "/srv/other", target: "/data" };
  const nameKey = (name: string) => [`name:${name}`];
  const FLEET: Record<string, FakeContainer> = {
    app: { mounts: [SHARED] },
    neighbour: { mounts: [SHARED] },
    nested: { mounts: [NESTED] },
    stopped: { mounts: [SHARED], running: false },
    unrelated: { mounts: [OTHER] },
  };
  const answersDuring = (
    step: string,
    what: (operations: OperationCoordinator) => void,
    getContext: () => ReturnType<typeof setup>,
  ) => ({
    [step]: () => {
      what(getContext().guard.operations as unknown as OperationCoordinator);
      return step === COPY_COMMAND.capture ? { bytes: 10, sha256: SHA, sourceBytes: 1000, singleFile: false } : {};
    },
  });

  it.each([
    ["backup", COPY_COMMAND.capture, backUp, {}],
    [
      "restore",
      COPY_COMMAND.restore,
      restore,
      readable(manifest({ mounts: [{ ...SHARED, file: "data-0.tar.age", singleFile: false, sourceBytes: 1 }] })),
    ],
  ] as const)(
    "during a %s, makes manual work on every writer of its data wait, and nothing else",
    async (_kind, step, go, extra) => {
      const busy: Record<string, boolean> = {};
      const context: ReturnType<typeof setup> = setup(FLEET, {
        answers: {
          ...extra,
          ...answersDuring(
            step,
            (operations) => {
              for (const name of Object.keys(FLEET)) {
                const lease = operations.tryAcquire(nameKey(name));
                busy[name] = lease === null;
                lease?.release();
              }
            },
            () => context,
          ),
        },
      });
      const { succeeded } = await go(context);
      expect(succeeded).toBe(true);
      expect(busy).toEqual({ app: true, neighbour: true, nested: true, stopped: true, unrelated: false });
    },
  );

  it("lets a queued manual start on a neighbour run only once the backup has ended", async () => {
    let manual: Promise<unknown> = Promise.resolve();
    const context: ReturnType<typeof setup> = setup(FLEET, {
      answers: answersDuring(
        COPY_COMMAND.capture,
        (operations) => {
          manual = operations.containers(
            async () => ({ resources: nameKey("neighbour") }),
            async () => {
              context.events.push("manual neighbour");
            },
          );
        },
        () => context,
      ),
    });
    await backUp(context);
    await manual;
    const order = (event: string) => context.events.lastIndexOf(event);
    expect(order("manual neighbour")).toBeGreaterThan(order("start neighbour"));
    expect(order("manual neighbour")).toBeGreaterThan(order("start app"));
  });

  it("looks again after waiting, so a writer that appeared meanwhile is held and stopped too", async () => {
    const fleet: Record<string, FakeContainer> = { app: { mounts: [SHARED] }, neighbour: { mounts: [SHARED] } };
    const context = setup(fleet);
    const operations = context.guard.operations as unknown as OperationCoordinator;
    const held = await operations.acquire(nameKey("neighbour"));
    const running = backUp(context);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(context.events).toEqual([]);

    fleet.late = { mounts: [SHARED] };
    context.running.set("late", true);
    context.policies.set("late", "always");
    held.release();
    expect((await running).succeeded).toBe(true);
    expect(context.events).toContain("stop late");
  });

  it("counts a writer of a parent folder, up to the host's root", async () => {
    const busy: Record<string, boolean> = {};
    const fleet: Record<string, FakeContainer> = {
      app: { mounts: [NESTED] },
      parent: { mounts: [SHARED] },
      root: { mounts: [{ type: "bind", source: "/", target: "/host" }] },
      readOnly: { mounts: [{ ...SHARED, rw: false }] },
    };
    const context: ReturnType<typeof setup> = setup(fleet, {
      answers: answersDuring(
        COPY_COMMAND.capture,
        (operations) => {
          for (const name of Object.keys(fleet)) {
            const lease = operations.tryAcquire(nameKey(name));
            busy[name] = lease === null;
            lease?.release();
          }
        },
        () => context,
      ),
    });
    await backUp(context);
    expect(busy).toEqual({ app: true, parent: true, root: true, readOnly: false });
  });

  it("refuses a restore of a member the job does not hold, before anything is touched", async () => {
    const stackTarget = { container: null, stack: "wiki" };
    const FOLDER_OF = (source: string) => ({ type: "bind" as const, source, target: "/data" });
    const member = (name: string, source: string) => ({
      name,
      image: `${name}:1`,
      imageId: null,
      method: "files" as const,
      mounts: [{ ...FOLDER_OF(source), file: `data-${name}.tar.age`, singleFile: false, sourceBytes: 1 }],
      dump: null,
    });
    const backup: BackupManifest = {
      ...manifest(),
      target: stackTarget,
      members: [member("web", "/srv/web"), member("left", "/srv/left")],
      files: [
        { file: "data-web.tar.age", bytes: 1, sha256: SHA, isTar: true },
        { file: "data-left.tar.age", bytes: 1, sha256: SHA, isTar: true },
      ],
    };
    const context = setup(
      {
        web: { project: "wiki", service: "web", mounts: [FOLDER_OF("/srv/web")] },
        // Still on the host, but no longer part of the project, so nothing here leases it.
        left: { mounts: [FOLDER_OF("/srv/left")] },
      },
      { answers: readable(backup) },
    );
    const { succeeded, outcome } = await restore(context, { target: stackTarget });
    expect(succeeded).toBe(false);
    expect(outcome).toBe(BACKUP_TEXT.notHeld("left"));
    expect(context.events.filter((event) => event.startsWith("stop "))).toEqual([]);
    expect(context.helperMounts).toEqual([]);
  });
});

describe("when stopping fails partway", () => {
  // Stopped last to first: "c" goes first, then "b", then "a".
  const SHARED = { type: "bind" as const, source: "/srv/shared", target: "/data" };
  const inOrder = (dependsOn?: string): FakeContainer => ({ mounts: [SHARED], ...(dependsOn ? { dependsOn } : {}) });
  const FLEET: Record<string, FakeContainer> = {
    a: inOrder(),
    b: inOrder("a"),
    c: inOrder("b"),
    idle: { mounts: [SHARED], running: false },
  };
  const target = { container: "a", stack: null };
  const shared = manifest({
    name: "a",
    mounts: [{ ...SHARED, file: "data-0.tar.age", singleFile: false, sourceBytes: 1 }],
  });
  const sharedBackup = { ...shared, target };
  const journals = (context: ReturnType<typeof setup>) =>
    [...context.volumes.values()].map(
      (labels) => JSON.parse(labels[CONTAINER_BACKUP.journalRecord]!) as { stopped: { name: string }[] },
    );

  it("starts what it had stopped, and only that, and says everything is running", async () => {
    const context = setup(FLEET, { faults: { stop: ["b"] } });
    const { succeeded, outcome } = await backUp(context, { target });

    expect(succeeded).toBe(false);
    expect(context.events).toContain("stop c");
    expect(context.events).toContain("start c");
    expect(context.running.get("c")).toBe(true);
    expect(context.events).not.toContain("stop a");
    expect(context.events).not.toContain("start a");
    expect(context.events).not.toContain("start idle");
    expect(context.running.get("idle")).toBe(false);
    expect(outcome).toBe(BACKUP_TEXT.failedRunning("cannot stop b"));
    expect(journals(context)).toEqual([]);
  });

  it("names what would not start, and keeps the record of it", async () => {
    const context = setup(FLEET, { faults: { stop: ["a"], start: ["c"] } });
    const { outcome } = await backUp(context, { target });

    expect(context.events).toContain("start b");
    expect(context.running.get("b")).toBe(true);
    expect(context.running.get("c")).toBe(false);
    expect(outcome).toBe(BACKUP_TEXT.failedStopped("cannot stop a", "c"));
    expect(journals(context).map(({ stopped }) => stopped.map(({ name }) => name))).toEqual([["c"]]);
  });

  it("does the same after the copy, when a backup is otherwise fine", async () => {
    const context = setup(FLEET, { faults: { start: ["b"] } });
    const { succeeded, outcome } = await backUp(context, { target });
    expect(succeeded).toBe(false);
    expect(outcome).toContain(BACKUP_TEXT.notStarted("b"));
    expect(journals(context).map(({ stopped }) => stopped.map(({ name }) => name))).toEqual([["b"]]);
  });

  it("gives a restore's stopped members their policies back, and leaves no policy altered", async () => {
    const context = setup(FLEET, { answers: readable(sharedBackup), faults: { stop: ["b"] } });
    const { succeeded, outcome } = await restore(context, { target });

    expect(succeeded).toBe(false);
    expect(outcome).toBe(BACKUP_TEXT.restoreRefused("cannot stop b"));
    expect(context.running.get("c")).toBe(true);
    for (const name of ["a", "b", "c"]) expect(context.policies.get(name)).toBe("always");
    expect(context.events).not.toContain(COPY_COMMAND.restore);
    expect(journals(context)).toEqual([]);
  });

  it("says when a restore that was refused left something stopped", async () => {
    const context = setup(FLEET, { answers: readable(sharedBackup), faults: { stop: ["a"], start: ["c"] } });
    const { outcome } = await restore(context, { target });
    expect(outcome).toContain(BACKUP_TEXT.restoreRefused("cannot stop a"));
    expect(outcome).toContain(BACKUP_TEXT.notStarted("c"));
    expect(journals(context).map(({ stopped }) => stopped.map(({ name }) => name))).toEqual([["c"]]);
  });

  it("still starts it when only its policy would not go back, and keeps it on record", async () => {
    const context = setup(FLEET, {
      answers: readable(sharedBackup),
      faults: { stop: ["a"], policyBack: ["c"] },
    });
    const { outcome } = await restore(context, { target });

    expect(context.running.get("c")).toBe(true);
    expect(context.policies.get("c")).toBe("no");
    expect(outcome).toContain(BACKUP_TEXT.notStarted("c"));
    expect(journals(context).map(({ stopped }) => stopped.map(({ name }) => name))).toEqual([["c"]]);
  });

  it("will not start a different container that has taken the name", async () => {
    const context = setup(FLEET, { faults: { stop: ["b"] } });
    const { docker } = context;
    const inspect = docker.inspect;
    docker.inspect = async (name: string) => {
      const details = await inspect(name);
      return name === "c" && context.events.includes("stop c") && details !== null
        ? { ...details, Id: "a-new-container" }
        : details;
    };
    const { outcome } = await backUp(context, { target });
    expect(context.events).not.toContain("start c");
    expect(outcome).toBe(BACKUP_TEXT.failedStopped("cannot stop b", "c"));
  });

  it("does not count something as started when it did not stay up", async () => {
    const context = setup(FLEET, { faults: { stop: ["b"] } });
    const { docker } = context;
    const start = docker.start;
    docker.start = async (name: string) => {
      await start(name);
      if (name === "c") context.running.set("c", false);
    };
    const { outcome } = await backUp(context, { target });
    expect(outcome).toBe(BACKUP_TEXT.failedStopped("cannot stop b", "c"));
  });

  it("tries again on starting, and keeps what still will not start", async () => {
    const failing = setup(FLEET, { faults: { stop: ["a"], start: ["b", "c"] } });
    await backUp(failing, { target });
    expect(
      journals(failing)[0]!
        .stopped.map(({ name }) => name)
        .toSorted(),
    ).toEqual(["b", "c"]);

    const later = setup(FLEET, { faults: { start: ["c"] } });
    for (const [name, labels] of failing.volumes) later.volumes.set(name, labels);
    later.running.set("b", false);
    later.running.set("c", false);
    await later.backups.recover();
    expect(later.running.get("b")).toBe(true);
    expect(journals(later).map(({ stopped }) => stopped.map(({ name }) => name))).toEqual([["c"]]);
  });
});

describe("restoring", () => {
  it("checks the backup first, takes a safety copy, puts it back, and restores its policy", async () => {
    const sealedIds: string[] = [];
    const answers = {
      ...readable(),
      [COPY_COMMAND.finish]: (input: { manifest: BackupManifest }) => {
        sealedIds.push(input.manifest.id);
        return { copyError: null };
      },
    } as Record<string, Handler>;
    const context = setup({ app: APP }, { answers });
    const { succeeded, outcome, recoveryBackupId } = await restore(context);
    expect(succeeded).toBe(true);
    expect(outcome).toContain("Restored to");
    // The copy this restore made of what was there, by its own name.
    expect(sealedIds).toHaveLength(1);
    expect(recoveryBackupId).toBe(sealedIds[0]);
    const order = (event: string) => context.events.indexOf(event);
    expect(order(COPY_COMMAND.verify)).toBeLessThan(order("stop app"));
    expect(order("stop app")).toBeLessThan(order(COPY_COMMAND.capture));
    expect(order(COPY_COMMAND.capture)).toBeLessThan(order(COPY_COMMAND.restore));
    expect(order(COPY_COMMAND.restore)).toBeLessThan(order("start app"));
    expect(context.policies.get("app")).toBe("always");
    expect(context.volumes.size).toBe(0);
  });

  describe("what a backup's manifest alone may not decide", () => {
    const LIVE = { ...FOLDER };
    const untouched = (context: ReturnType<typeof setup>) => {
      expect(context.helperMounts).toEqual([]);
      for (const event of context.events) {
        expect(event).not.toMatch(/^(stop|policy) /);
        expect([COPY_COMMAND.empty, COPY_COMMAND.restore, COPY_COMMAND.capture, COPY_COMMAND.verify]).not.toContain(
          event,
        );
      }
    };
    const refused = async (answers: Record<string, Handler>, fleet: Record<string, FakeContainer> = { app: APP }) => {
      const context = setup(fleet, { answers });
      const result = await restore(context);
      expect(result.succeeded).toBe(false);
      return { context, outcome: result.outcome };
    };
    const original = sealed(manifest());
    const firstMember = original.members[0]!;
    const firstMount = firstMember.mounts[0]!;
    const changes: [string, BackupManifest][] = [
      ["a mount's source", { ...original, members: [{ ...firstMember, mounts: [{ ...firstMount, source: "/etc" }] }] }],
      ["a mount's type", { ...original, members: [{ ...firstMember, mounts: [{ ...firstMount, type: "volume" }] }] }],
      [
        "a mount's target",
        { ...original, members: [{ ...firstMember, mounts: [{ ...firstMount, target: "/other" }] }] },
      ],
      [
        "which file a mount comes from",
        {
          ...original,
          members: [{ ...firstMember, mounts: [{ ...firstMount, file: "data-1.tar.age" }] }],
        },
      ],
      ["the member", { ...original, members: [{ ...firstMember, name: "other" }] }],
      ["a checksum", { ...original, files: [{ ...original.files[0]!, sha256: "b".repeat(64) }] }],
      ["the list of files", { ...original, files: [] }],
      ["what it says is left out", { ...original, leftOut: ["/srv/else"] }],
    ];

    it.each(changes)("refuses a changed %s before anything is mounted, stopped or written", async (_what, changed) => {
      const { context, outcome } = await refused(unchecked(changed), { app: APP, other: APP });
      expect(outcome).toBe(BACKUP_TEXT.sealBroken);
      untouched(context);
    });

    it("refuses a seal made with any other key", async () => {
      const forged = { ...manifest(), seal: manifestSeal(manifest(), "AGE-SECRET-KEY-OF-SOMEONE-ELSE") };
      const { context, outcome } = await refused(unchecked(forged));
      expect(outcome).toBe(BACKUP_TEXT.sealBroken);
      untouched(context);
    });

    it("refuses one with its seal taken off", async () => {
      const { seal: _seal, ...bare } = original;
      const { context, outcome } = await refused(unchecked(bare));
      expect(outcome).toBe(BACKUP_TEXT.sealBroken);
      untouched(context);
    });

    it("refuses a soundly sealed manifest moved here from another backup", async () => {
      const others: BackupManifest[] = [
        { ...manifest(), id: "20200101T000000Z" },
        { ...manifest(), target: { container: "other", stack: null } },
      ];
      for (const other of others) {
        const { context, outcome } = await refused(unchecked(sealed(other)), { app: APP, other: APP });
        expect(outcome).toBe(BACKUP_TEXT.sealBroken);
        untouched(context);
      }
    });

    it("refuses one made before manifests were sealed, and says how to restore it instead", async () => {
      const older = { ...manifest(), format: CONTAINER_BACKUP.unsealedFormat } as BackupManifest;
      const { context, outcome } = await refused(unchecked(older));
      expect(outcome).toBe(BACKUP_TEXT.notSealed);
      untouched(context);
    });

    it("refuses where the container no longer keeps that data, even with a sound seal", async () => {
      const moved = { app: { mounts: [{ ...LIVE, source: "/srv/moved" }] } };
      for (const fleet of [moved, { app: { mounts: [{ ...LIVE, type: "volume" }] } }, { app: { mounts: [] } }]) {
        const { context, outcome } = await refused(readable(), fleet);
        expect(outcome).toBe(BACKUP_TEXT.mountChanged("app", LIVE.target));
        untouched(context);
      }
    });

    it("refuses a mount now read-only, and a host folder even if the container has it", async () => {
      const readOnly = await refused(readable(), { app: { mounts: [{ ...LIVE, rw: false }] } });
      expect(readOnly.outcome).toBe(BACKUP_TEXT.mountChanged("app", LIVE.target));

      const system = { ...LIVE, source: "/etc" };
      const onSystem = manifest({
        mounts: [{ ...system, type: "bind", file: "data-0.tar.age", singleFile: false, sourceBytes: 1 }],
      });
      const host = await refused(readable(onSystem), { app: { mounts: [system] } });
      expect(host.outcome).toBe(BACKUP_TEXT.mountChanged("app", LIVE.target));
      untouched(host.context);
    });

    it("seals what it makes, so that backup restores, and lists the older kind as such", async () => {
      let stored: BackupManifest | null = null;
      const making = setup(
        { app: APP },
        {
          answers: {
            [COPY_COMMAND.finish]: (input) => {
              stored = (input as { manifest: BackupManifest }).manifest;
              return { copyError: null };
            },
          },
        },
      );
      expect((await backUp(making)).succeeded).toBe(true);
      const made = stored! as BackupManifest;
      expect(made.format).toBe(CONTAINER_BACKUP.format);
      expect(made.seal).toMatch(/^[a-f0-9]{64}$/);

      const context = setup(
        { app: APP },
        {
          answers: unchecked({ ...made, id: RESTORE_ID, seal: manifestSeal({ ...made, id: RESTORE_ID }, IDENTITY) }),
        },
      );
      expect((await restore(context)).succeeded).toBe(true);
      expect(context.helperMounts).toContainEqual(expect.objectContaining({ Source: FOLDER.source, ReadOnly: false }));

      const listed = setup(
        { app: APP },
        {
          answers: {
            [COPY_COMMAND.list]: () => ({
              manifests: [
                { manifest: sealed(manifest()), sizeBytes: 1 },
                { manifest: { ...manifest(), format: CONTAINER_BACKUP.unsealedFormat }, sizeBytes: 1 },
              ],
            }),
          },
        },
      );
      const answer = await listed.backups.answer({
        id: "r",
        kind: "list",
        target: { container: "app", stack: null },
        directory: "/var/backups/autoheal",
        hostId: HOST,
      });
      expect(answer.backups?.map(({ unsealed }) => unsealed).toSorted()).toEqual([false, true]);
    });
  });

  it("keeps the backup it is restoring through the safety copy's clean-up", async () => {
    const seen: unknown[] = [];
    const context = setup(
      { app: APP },
      {
        answers: {
          ...readable(),
          [COPY_COMMAND.finish]: (input) => {
            seen.push(input);
            return { copyError: null };
          },
        },
      },
    );
    await restore(context);
    expect(seen[0]).toMatchObject({ protect: RESTORE_ID });
  });

  it("changes nothing when the backup is gone", async () => {
    const context = setup({ app: APP }, { answers: { [COPY_COMMAND.read]: failing("no such file") } });
    const { succeeded, outcome } = await restore(context);
    expect(succeeded).toBe(false);
    expect(outcome).toBe(BACKUP_TEXT.gone);
    expect(context.events.some((event) => event.startsWith("stop"))).toBe(false);
  });

  it("stops nothing when the backup does not read", async () => {
    const context = setup({ app: APP }, { answers: { ...readable(), [COPY_COMMAND.verify]: failing("corrupt") } });
    const { succeeded } = await restore(context);
    expect(succeeded).toBe(false);
    expect(context.events.some((event) => event.startsWith("stop"))).toBe(false);
  });

  it("refuses a container that is no longer there", async () => {
    const context = setup({ other: APP }, { answers: readable() });
    const { outcome } = await restore(context, { target: { container: "app", stack: null } });
    expect(outcome).toBe(BACKUP_TEXT.notThere("app"));
  });

  it("starts it again, unchanged, if the safety copy cannot be made", async () => {
    const context = setup({ app: APP }, { answers: { ...readable(), [COPY_COMMAND.capture]: failing("disk full") } });
    const { succeeded, outcome, recoveryBackupId } = await restore(context);
    expect(succeeded).toBe(false);
    expect(recoveryBackupId).toBeUndefined();
    expect(outcome).toContain("Nothing was changed");
    expect(context.events).not.toContain(COPY_COMMAND.restore);
    expect(context.running.get("app")).toBe(true);
    expect(context.policies.get("app")).toBe("always");
  });

  it("leaves it stopped, and says so, if data was half-way when it failed", async () => {
    const context = setup({ app: APP }, { answers: { ...readable(), [COPY_COMMAND.restore]: failing("disk gone") } });
    const { succeeded, outcome } = await restore(context);
    expect(succeeded).toBe(false);
    expect(outcome).toContain("stay stopped");
    expect(context.running.get("app")).toBe(false);
    expect(context.policies.get("app")).toBe("no");
    expect(context.backups.isBlocked("app")).toBe(true);
    expect(context.volumes.size).toBe(1);
  });

  it("restoring again after that clears it", async () => {
    let fails = true;
    const context = setup(
      { app: APP },
      {
        answers: {
          ...readable(),
          [COPY_COMMAND.restore]: () => {
            if (fails) throw new Error("disk gone");
            return {};
          },
        },
      },
    );
    await restore(context);
    fails = false;
    const { succeeded } = await restore(context);
    expect(succeeded).toBe(true);
    expect(context.backups.isBlocked("app")).toBe(false);
    expect(context.running.get("app")).toBe(true);
    expect(context.policies.get("app")).toBe("always");
  });

  describe("retrying a restore that left its data half-written", () => {
    const SHARED = { type: "bind" as const, source: "/srv/app", target: "/config" };
    const FLEET: Record<string, FakeContainer> = { app: { mounts: [SHARED] }, neighbour: { mounts: [SHARED] } };
    const phases = (context: ReturnType<typeof setup>) => {
      const seen: string[] = [];
      const { createVolume } = context.docker;
      context.docker.createVolume = async (name: string, labels: Record<string, string>) => {
        seen.push((JSON.parse(labels[CONTAINER_BACKUP.journalRecord]!) as { phase: string }).phase);
        await createVolume(name, labels);
      };
      return seen;
    };
    // This runner gone, and another started on the same Docker: only what is on the host carries over.
    const restarted = async (before: ReturnType<typeof setup>, fleet: Record<string, FakeContainer> = FLEET) => {
      const later = setup(fleet);
      for (const [name, labels] of before.volumes) later.volumes.set(name, labels);
      for (const name of Object.keys(fleet)) {
        later.running.set(name, before.running.get(name) === true);
        later.policies.set(name, before.policies.get(name) ?? "always");
      }
      await later.backups.recover();
      return later;
    };
    const failingFirst = (extra: Record<string, Handler> = {}) => {
      const state = { failRestore: true };
      const context = setup(FLEET, {
        answers: {
          ...readable(),
          [COPY_COMMAND.restore]: () => {
            if (state.failRestore) throw new Error("disk gone");
            return {};
          },
          ...extra,
        },
      });
      return { context, state };
    };

    it("stays blocked at every durable step of the retry, until it has finished", async () => {
      const { context, state } = failingFirst();
      await restore(context);
      const seen = phases(context);
      state.failRestore = false;
      expect((await restore(context)).succeeded).toBe(true);

      expect(seen.at(-1)).toBe("activating");
      expect(seen.slice(0, -1).length).toBeGreaterThan(0);
      expect(seen.slice(0, -1).every((phase) => phase === "writing")).toBe(true);
    });

    it("starts nothing if the runner dies as the retry begins, and keeps the block", async () => {
      const { context, state } = failingFirst();
      await restore(context);
      state.failRestore = false;
      // What is on the host the moment the retry's first record lands, before the old one goes.
      let atThatMoment: Map<string, Record<string, string>> | null = null;
      const { createVolume } = context.docker;
      context.docker.createVolume = async (name: string, labels: Record<string, string>) => {
        await createVolume(name, labels);
        atThatMoment ??= new Map(context.volumes);
      };
      await restore(context);

      const crashed = setup(FLEET);
      for (const [name, labels] of atThatMoment!) crashed.volumes.set(name, labels);
      for (const name of Object.keys(FLEET)) {
        crashed.running.set(name, false);
        crashed.policies.set(name, "no");
      }
      await crashed.backups.recover();
      expect(crashed.backups.isBlocked("app")).toBe(true);
      expect(crashed.running.get("app")).toBe(false);
      expect(crashed.running.get("neighbour")).toBe(false);
      expect(crashed.events.filter((event) => event.startsWith("start "))).toEqual([]);
    });

    it("starts nothing if the retry fails before it writes, and the block carries on", async () => {
      const { context, state } = failingFirst();
      await restore(context);
      state.failRestore = false;
      context.docker.stop = async () => {
        throw new Error("Docker went away");
      };
      // Something new to stop, so the retry fails after its record is made, before it writes.
      context.running.set("neighbour", true);
      const { succeeded, outcome } = await restore(context);

      expect(succeeded).toBe(false);
      expect(outcome).toContain("stay stopped");
      expect(context.running.get("app")).toBe(false);
      expect(context.backups.isBlocked("app")).toBe(true);
      const later = await restarted(context);
      expect(later.backups.isBlocked("app")).toBe(true);
      expect(later.events.filter((event) => event.startsWith("start "))).toEqual([]);
    });

    it("keeps the block when the retry is refused outright, as nothing changed", async () => {
      const state = { failRestore: true, broken: false };
      const good = sealed(manifest());
      const context = setup(FLEET, {
        answers: {
          [COPY_COMMAND.read]: () => ({
            manifest: state.broken ? { ...good, leftOut: ["changed"] } : good,
            key: "c2VhbGVk",
          }),
          [COPY_COMMAND.restore]: () => {
            if (state.failRestore) throw new Error("disk gone");
            return {};
          },
        },
      });
      await restore(context);
      state.broken = true;
      expect((await restore(context)).outcome).toBe(BACKUP_TEXT.sealBroken);
      expect(context.backups.isBlocked("app")).toBe(true);
      expect(context.running.get("app")).toBe(false);
    });

    it("takes no safety copy of data known to be half-written, so nothing can be put back to it", async () => {
      const { context, state } = failingFirst();
      await restore(context);
      state.failRestore = false;
      context.events.length = 0;
      const { recoveryBackupId } = await restore(context);
      expect(recoveryBackupId).toBeUndefined();
      expect(context.events).not.toContain(COPY_COMMAND.capture);
      expect(context.events).toContain(COPY_COMMAND.restore);
    });

    it("starts each original once when the retry succeeds, with its policy back", async () => {
      const { context, state } = failingFirst();
      await restore(context);
      state.failRestore = false;
      context.events.length = 0;
      expect((await restore(context)).succeeded).toBe(true);

      for (const name of ["app", "neighbour"]) {
        expect(context.events.filter((event) => event === `start ${name}`)).toHaveLength(1);
        expect(context.policies.get(name)).toBe("always");
      }
      expect(context.backups.isBlocked("app")).toBe(false);
      expect(context.volumes.size).toBe(0);
    });

    it("succeeds after a runner restart too, picking up what the first attempt stopped", async () => {
      const { context } = failingFirst();
      await restore(context);
      const later = setup(FLEET, { answers: readable() });
      for (const [name, labels] of context.volumes) later.volumes.set(name, labels);
      for (const name of Object.keys(FLEET)) {
        later.running.set(name, false);
        later.policies.set(name, "no");
      }
      await later.backups.recover();
      expect(later.events.filter((event) => event.startsWith("start "))).toEqual([]);

      expect((await restore(later)).succeeded).toBe(true);
      expect(later.running.get("app")).toBe(true);
      expect(later.policies.get("app")).toBe("always");
      expect(later.backups.isBlocked("app")).toBe(false);
    });

    it("will not start a different container that took the name, and keeps it on record", async () => {
      const { context, state } = failingFirst();
      await restore(context);
      state.failRestore = false;
      const { inspect } = context.docker;
      context.docker.inspect = async (name: string) => {
        const details = await inspect(name);
        return name === "neighbour" && details !== null ? { ...details, Id: "a-new-container" } : details;
      };
      const { succeeded, outcome } = await restore(context);
      expect(succeeded).toBe(false);
      expect(context.running.get("neighbour")).toBe(false);
      expect(context.events).not.toContain("start neighbour");
      expect(outcome).toContain("neighbour");
    });

    it("stays blocked when a dump will not load in a retry, rather than putting back half-written data", async () => {
      const DB: FakeContainer = { image: "postgres:16", mounts: [{ ...SHARED, source: "/srv/pg", target: "/data" }] };
      const target = { container: "db", stack: null };
      const dumped = {
        ...manifest({
          name: "db",
          image: "postgres:16",
          method: "dump",
          mounts: [],
          dump: { file: "dump-0.sql.age", databases: ["app"] },
        }),
        target,
      };
      const state = { fail: true };
      const context = setup(
        { db: DB },
        {
          answers: {
            ...readable(dumped),
            // The first time the dump fails and so does putting the old data back, which leaves it half-way.
            [COPY_COMMAND.restore]: () => {
              if (state.fail) throw new Error("disk gone");
              return {};
            },
            databaseFault: ((line: string) =>
              line.includes("psql -X -q")
                ? { exitCode: 1, stderr: 'ERROR: syntax error at or near "x"' }
                : { exitCode: 0, stderr: "" }) as unknown as Handler,
          },
        },
      );
      await restore(context, { target });
      expect(context.backups.isBlocked("db")).toBe(true);
      state.fail = false;
      context.events.length = 0;
      const { succeeded, outcome } = await restore(context, { target });

      expect(succeeded).toBe(false);
      expect(outcome).toContain("stay stopped");
      expect(context.backups.isBlocked("db")).toBe(true);
      expect(context.running.get("db")).toBe(false);
      expect(context.events).not.toContain(COPY_COMMAND.restore);
    });
  });

  describe("a database's dump", () => {
    const DATABASE: FakeContainer = {
      image: "postgres:16",
      mounts: [{ type: "bind", source: "/srv/pg", target: "/data" }],
    };
    const target = { container: "db", stack: null };
    const dumped = {
      ...manifest({
        name: "db",
        image: "postgres:16",
        method: "dump",
        mounts: [],
        dump: { file: "dump-0.sql.age", databases: ["app"] },
      }),
      target,
    };

    it("safety first, then empties it, starts it, feeds it, and checks its databases", async () => {
      const context = setup({ db: DATABASE }, { answers: readable(dumped) });
      const { succeeded } = await restore(context, { target });
      expect(succeeded).toBe(true);
      const order = (event: string) => context.events.indexOf(event);
      expect(order("stop db")).toBeLessThan(order(COPY_COMMAND.capture));
      expect(order(COPY_COMMAND.capture)).toBeLessThan(order(COPY_COMMAND.empty));
      expect(order(COPY_COMMAND.empty)).toBeLessThan(order("start db"));
      expect(order("start db")).toBeLessThan(order("feed db"));
      expect(context.policies.get("db")).toBe("always");
    });

    it("passes over its dump saying a role is already there", async () => {
      const harmless = ((line: string) =>
        line.includes("psql -X -q")
          ? { exitCode: 0, stderr: 'ERROR:  role "postgres" already exists\nERROR:  database "wiki" already exists' }
          : { exitCode: 0, stderr: "" }) as unknown as Handler;
      const context = setup({ db: DATABASE }, { answers: { ...readable(dumped), databaseFault: harmless } });
      expect((await restore(context, { target })).succeeded).toBe(true);
    });

    it("puts the old database back when the dump will not load", async () => {
      const fault = ((line: string) =>
        line.includes("psql -X -q")
          ? { exitCode: 0, stderr: "ERROR:  syntax error at line 3" }
          : { exitCode: 0, stderr: "" }) as unknown as Handler;
      const context = setup({ db: DATABASE }, { answers: { ...readable(dumped), databaseFault: fault } });
      const { succeeded, outcome, recoveryBackupId } = await restore(context, { target });
      expect(succeeded).toBe(false);
      expect(outcome).toContain("syntax error");
      // It is already back as it was: there is nothing to go back from.
      expect(recoveryBackupId).toBeUndefined();
      expect(context.events).toContain(COPY_COMMAND.restore);
      expect(context.running.get("db")).toBe(true);
      expect(context.policies.get("db")).toBe("always");
      expect(context.backups.isBlocked("db")).toBe(false);
      expect(context.volumes.size).toBe(0);
    });

    it("puts the old database back from the copy in this host's own folder", async () => {
      const fault = ((line: string) =>
        line.includes("psql -X -q")
          ? { exitCode: 0, stderr: "ERROR:  syntax error at line 3" }
          : { exitCode: 0, stderr: "" }) as unknown as Handler;
      const context = setup({ db: DATABASE }, { answers: { ...readable(dumped), databaseFault: fault } });
      await restore(context, { target });
      const [safety] = inputsOf(context, COPY_COMMAND.finish) as { manifest: BackupManifest }[];
      expect(inputsOf(context, COPY_COMMAND.restore).map(({ folder }) => folder)).toEqual([
        `${OWN}/db/${safety!.manifest.id}`,
      ]);
    });

    it("leaves it stopped if even the old database cannot be put back", async () => {
      const fault = ((line: string) =>
        line.includes("psql -X -q")
          ? { exitCode: 3, stderr: "ERROR:  broken" }
          : { exitCode: 0, stderr: "" }) as unknown as Handler;
      const context = setup(
        { db: DATABASE },
        { answers: { ...readable(dumped), databaseFault: fault, [COPY_COMMAND.restore]: failing("disk gone") } },
      );
      const { outcome, recoveryBackupId } = await restore(context, { target });
      expect(outcome).toContain("stay stopped");
      expect(context.backups.isBlocked("db")).toBe(true);
      // Stopped on data it could not finish with: its copy of what was there is still the way back.
      expect(recoveryBackupId).toMatch(/^\d{8}T\d{6}Z$/);
    });

    describe("with several databases, when a later one will not load", () => {
      const stack = { container: null, stack: "pair" };
      const database = (source: string, running = false): FakeContainer => ({
        image: "postgres:16",
        project: "pair",
        service: source,
        running,
        mounts: [{ type: "bind", source: `/srv/${source}`, target: "/data" }],
      });
      const dumpOf = (name: string, index: number) => ({
        name,
        image: "postgres:16",
        imageId: null,
        method: "dump" as const,
        mounts: [],
        dump: { file: `dump-${index}.sql.age`, databases: ["app"] },
      });
      const backup: BackupManifest = {
        ...manifest(),
        target: stack,
        members: [dumpOf("first", 0), dumpOf("second", 1)],
        files: [
          { file: "dump-0.sql.age", bytes: 1, sha256: SHA, isTar: false },
          { file: "dump-1.sql.age", bytes: 1, sha256: SHA, isTar: false },
        ],
      };
      // The first feed goes in, the second does not.
      const secondFails = () => {
        let feeds = 0;
        return ((line: string) => {
          if (!line.includes("psql -X -q")) return { exitCode: 0, stderr: "" };
          feeds += 1;
          return feeds === 2 ? { exitCode: 3, stderr: "ERROR:  broken" } : { exitCode: 0, stderr: "" };
        }) as unknown as Handler;
      };
      const scene = (answers: Record<string, Handler> = {}) => {
        const context: ReturnType<typeof setup> = setup(
          { first: database("first"), second: database("second") },
          { answers: { ...readable(backup), databaseFault: secondFails(), ...answers } },
        );
        return context;
      };

      it("stops every database before writing any safety copy back", async () => {
        const runningAtWrite: boolean[] = [];
        const context: ReturnType<typeof setup> = scene({
          [COPY_COMMAND.restore]: () => {
            runningAtWrite.push(context.running.get("first") === true, context.running.get("second") === true);
            return {};
          },
        });
        const { succeeded, outcome } = await restore(context, { target: stack });

        expect(succeeded).toBe(false);
        expect(outcome).toContain("broken");
        expect(context.events).toContain("start first");
        expect(context.events).toContain("stop first");
        const order = (event: string) => context.events.indexOf(event);
        expect(order("stop first")).toBeLessThan(order(COPY_COMMAND.restore));
        expect(order("stop second")).toBeLessThan(order(COPY_COMMAND.restore));
        expect(runningAtWrite.length).toBeGreaterThan(0);
        expect(runningAtWrite).not.toContain(true);
        expect(context.backups.isBlocked("first")).toBe(false);
      });

      const refusingToStop = (context: ReturnType<typeof setup>, name: string) => {
        const { stop } = context.docker;
        context.docker.stop = async (who: string) => {
          if (who === name) throw new Error(`cannot stop ${who}`);
          await stop(who);
        };
      };

      it("writes nothing back and stays blocked when a database will not stop, and names it", async () => {
        const context = scene();
        refusingToStop(context, "first");
        const { succeeded, outcome } = await restore(context, { target: stack });

        expect(succeeded).toBe(false);
        expect(context.events).not.toContain(COPY_COMMAND.restore);
        expect(context.backups.isBlocked("first")).toBe(true);
        expect(context.backups.isBlocked("second")).toBe(true);
        expect(outcome).toContain("stay stopped");
        expect(outcome).toContain(BACKUP_TEXT.stillRunning("first"));
        expect(context.volumes.size).toBe(1);
      });

      it("treats a stop that seemed to work as uncertain if it is still running", async () => {
        const context = scene();
        context.docker.stop = async () => undefined;
        await restore(context, { target: stack });
        expect(context.events).not.toContain(COPY_COMMAND.restore);
        expect(context.backups.isBlocked("first")).toBe(true);
      });

      it("treats a container that is no longer the same one as uncertain", async () => {
        const context = scene();
        const { inspect } = context.docker;
        // Replaced after the job took its look, once it has started the first one.
        context.docker.inspect = async (name: string) => {
          const details = await inspect(name);
          const replaced = name === "first" && details !== null && context.events.includes("start first");
          return replaced ? { ...details, Id: "a-new-container" } : details;
        };
        const { outcome } = await restore(context, { target: stack });
        expect(context.events).not.toContain(COPY_COMMAND.restore);
        expect(outcome).toContain(BACKUP_TEXT.stillRunning("first"));
      });

      it("leaves no database running when the restore gives up another way", async () => {
        const noRecipe: FakeContainer = { ...database("second"), image: "unknown:1" };
        const context = setup({ first: database("first"), second: noRecipe }, { answers: readable(backup) });
        const { succeeded, outcome } = await restore(context, { target: stack });
        expect(succeeded).toBe(false);
        expect(context.events).toContain("start first");
        expect(context.running.get("first")).toBe(false);
        expect(context.backups.isBlocked("first")).toBe(true);
        expect(outcome).not.toContain(BACKUP_TEXT.stillRunning("first"));
      });

      it("uses each container's own stop grace", async () => {
        const OWN_GRACE = 77;
        const graces = new Map<string, number>();
        const context = setup(
          { first: { ...database("first"), stopTimeout: OWN_GRACE }, second: database("second") },
          { answers: { ...readable(backup), databaseFault: secondFails() } },
        );
        const { stop } = context.docker;
        context.docker.stop = async (name: string, grace?: number) => {
          graces.set(name, grace!);
          await stop(name);
        };
        await restore(context, { target: stack });
        expect(graces.get("first")).toBe(OWN_GRACE);
      });
    });

    it("notices a database that did not come back", async () => {
      const missing = {
        ...manifest({ ...dumped.members[0]!, dump: { file: "dump-0.sql.age", databases: ["app", "lost"] } }),
        target,
      };
      const context = setup({ db: DATABASE }, { answers: readable(missing) });
      const { outcome } = await restore(context, { target });
      expect(outcome).toContain("lost");
    });
  });
});

describe("a stack's Compose files", () => {
  const PROJECT = "wiki";
  const WEB: FakeContainer = { project: PROJECT, service: "web", mounts: [FOLDER] };
  const COMPOSE = "/srv/wiki/compose.yaml";
  const saved = {
    projects: [PROJECT],
    files: [{ path: COMPOSE, kind: "compose", text: "image: wiki:1" }],
    containers: [],
  };

  const withStacks = (
    currentText: string,
    saveError: string | null = null,
    fleet: Record<string, FakeContainer> = { web: WEB },
    backup: BackupManifest = manifestWithSettings(),
  ) => {
    const context = setup(fleet, { answers: readable(backup) });
    const answer = vi.fn(async ({ kind }: { kind: string }) =>
      kind === "save"
        ? { error: saveError }
        : {
            error: null,
            files: {
              project: PROJECT,
              folder: "/srv/wiki",
              builds: false,
              files: [{ path: COMPOSE, kind: "compose", text: currentText, hash: "h", hasPrevious: false }],
            },
          },
    );
    // Compose really brings its project's containers up; the stub does the same, or nothing runs after it.
    const run = vi.fn(async () => {
      context.events.push("stack up");
      for (const name of Object.keys(fleet)) await context.docker.start(name);
      return { succeeded: true, outcome: "", output: null };
    });
    const backups = context.backups as unknown as {
      dependencies: { stacks: unknown; docker: Record<string, unknown> };
    };
    backups.dependencies.stacks = { answer, run };
    const original = backups.dependencies.docker.streamCommand as (...args: unknown[]) => Promise<unknown>;
    backups.dependencies.docker.streamCommand = async (
      reference: string,
      command: readonly string[],
      options: { input?: Readable; output: Writable },
    ) => {
      if (command[4] !== COPY_COMMAND.reveal) return original(reference, command, options);
      options.output.end(Buffer.from(JSON.stringify(saved)));
      return { exitCode: 0, stderr: "" };
    };
    return { context, answer, run };
  };
  const manifestWithSettings = () => ({
    ...manifest({ name: "web", image: "wiki:1" }),
    hasSettings: true,
    target: { container: "web", stack: null },
  });
  const target = { container: "web", stack: null };

  // A second service of the same stack, with its own data: nothing of this restore belongs to it.
  const SIBLING: FakeContainer = {
    project: PROJECT,
    service: "api",
    mounts: [{ type: "bind", source: "/srv/api", target: "/config" }],
  };

  describe("when the restore is of one service and the stack has others", () => {
    it("leaves the files alone, brings nothing up, and says which service kept it from happening", async () => {
      const { context, answer, run } = withStacks("image: wiki:2", null, { web: WEB, api: SIBLING });

      const { succeeded, outcome } = await restore(context, { target });

      expect(succeeded).toBe(true);
      // Its own data came back; the stack's shared files did not move, and nothing was brought up from them.
      expect(answer).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "save" }));
      expect(run).not.toHaveBeenCalled();
      expect(outcome).toContain(BACKUP_TEXT.settingsWiderThanRestore(PROJECT, "api"));
      // The sibling was never touched: not stopped, not started, left running as it was.
      expect(context.events).not.toContain("stop api");
      expect(context.events).not.toContain("start api");
      expect(context.running.get("api")).toBe(true);
    });

    it("names every other service of the stack, not only the first", async () => {
      const worker: FakeContainer = { ...SIBLING, service: "worker", mounts: [] };
      const made = withStacks("image: wiki:2", null, { web: WEB, api: SIBLING, worker });

      const { outcome } = await restore(made.context, { target });

      expect(outcome).toContain(BACKUP_TEXT.settingsWiderThanRestore(PROJECT, "api, worker"));
      expect(made.context.events).not.toContain("stop worker");
    });

    it("still puts them back when the restore covers the whole stack", async () => {
      // A backup of the stack itself: both services are in it, so putting the files back covers both.
      const both = manifest({ name: "web", image: "wiki:1" });
      const wholeStack = {
        ...both,
        hasSettings: true,
        target: { container: null, stack: PROJECT },
        members: [both.members[0]!, { ...both.members[0]!, name: "api", image: "api:1", mounts: [], dump: null }],
      };
      const { context, answer, run } = withStacks("image: wiki:2", null, { web: WEB, api: SIBLING }, wholeStack);

      const { outcome } = await restore(context, { target: { container: null, stack: PROJECT } });

      expect(answer).toHaveBeenCalledWith(expect.objectContaining({ kind: "save" }));
      expect(run).toHaveBeenCalledWith(JOB_ACTION.stackUp, { project: PROJECT, removeData: false });
      expect(outcome).not.toContain("restore the whole stack");
    });

    it("refuses the files when the backup itself has no copy of a service the stack now runs", async () => {
      // A backup of the stack from before api joined it. Putting the files back would recreate api from them.
      const onlyWeb = {
        ...manifest({ name: "web", image: "wiki:1" }),
        hasSettings: true,
        target: { container: null, stack: PROJECT },
      };
      const made = withStacks("image: wiki:2", null, { web: WEB, api: SIBLING }, onlyWeb);

      const { outcome } = await restore(made.context, { target: { container: null, stack: PROJECT } });

      expect(made.answer).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "save" }));
      expect(outcome).toContain(BACKUP_TEXT.settingsWiderThanRestore(PROJECT, "api"));
    });

    it("leaves them alone for a sibling sharing this one's data, which the job holds but nobody asked about", async () => {
      const neighbour: FakeContainer = { project: PROJECT, service: "api", mounts: [FOLDER] };
      const { context, answer, run } = withStacks("image: wiki:2", null, { web: WEB, api: neighbour });

      const { outcome } = await restore(context, { target });

      expect(answer).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "save" }));
      expect(run).not.toHaveBeenCalled();
      expect(outcome).toContain(BACKUP_TEXT.settingsWiderThanRestore(PROJECT, "api"));
    });
  });

  describe("what starts on the data that just came back", () => {
    const order = (context: ReturnType<typeof setup>) =>
      context.events.filter((event) => /^(start|stop) |^stack up$/.test(event));

    it("comes up from the backup's own Compose, never from the image it was running", async () => {
      const { context } = withStacks("image: wiki:2");

      const { succeeded } = await restore(context, { target });

      expect(succeeded).toBe(true);
      // Stopped, then brought up by Compose from the files this data belongs with. Nothing started in between:
      // a start here would be the newer image writing to older data.
      expect(order(context)).toEqual(["stop web", "stack up", "start web"]);
    });

    it("comes up from Compose too when its files are already the backup's, as what runs may not be", async () => {
      const { context, run } = withStacks("image: wiki:1");

      const { succeeded } = await restore(context, { target });

      expect(succeeded).toBe(true);
      expect(run).toHaveBeenCalledTimes(1);
      expect(order(context)).toEqual(["stop web", "stack up", "start web"]);
    });

    it("keeps it stopped when its files could not come back, rather than start what runs now on this data", async () => {
      const { context, run } = withStacks("image: wiki:2", "the host keeps these to itself");

      const { succeeded, outcome } = await restore(context, { target });

      // The data was written, and nothing started on it afterwards: neither the image that runs now nor Compose.
      expect(context.events).toContain(COPY_COMMAND.restore);
      expect(order(context)).toEqual(["stop web"]);
      expect(run).not.toHaveBeenCalled();
      expect(succeeded).toBe(false);
      expect(outcome).toContain(BACKUP_TEXT.keptStoppedForSettings("web"));
      expect(outcome).not.toContain(BACKUP_TEXT.restoredNotUp("web"));
      expect(context.backups.isBlocked("web")).toBe(true);
    });

    it("finishes when restored again once its files can come back, and only Compose starts it", async () => {
      const made = withStacks("image: wiki:2", "the host keeps these to itself");
      await restore(made.context, { target });
      const reading = made.answer.getMockImplementation()!;
      made.answer.mockImplementation(async (request) => (request.kind === "save" ? { error: null } : reading(request)));
      made.context.events.length = 0;

      const { succeeded } = await restore(made.context, { target });

      expect(succeeded).toBe(true);
      expect(order(made.context)).toEqual(["stack up", "start web"]);
      expect(made.context.backups.isBlocked("web")).toBe(false);
      expect(
        [...made.context.volumes.keys()].filter((name) => name.startsWith(CONTAINER_BACKUP.journalPrefix)),
      ).toEqual([]);
    });

    // A runner that dies while the data is back but not yet under its own files, and the one started after it.
    const afterCrash = async (left: Map<string, Record<string, string>>, running: boolean) => {
      const later = setup({ web: WEB });
      for (const [name, labels] of left) later.volumes.set(name, labels);
      later.running.set("web", running);
      later.policies.set("web", "no");
      await later.backups.recover();
      return later;
    };

    it.each([
      ["before Compose brings it up", false],
      ["after Compose brought it up, before it was looked at", true],
    ])("starts nothing on its own when the runner dies %s, and keeps the block", async (_when, composeRan) => {
      const made = withStacks("image: wiki:2");
      let left: Map<string, Record<string, string>> | null = null;
      made.run.mockImplementation(async () => {
        if (!composeRan) left = new Map(made.context.volumes);
        made.context.events.push("stack up");
        await made.context.docker.start("web");
        if (composeRan) left = new Map(made.context.volumes);
        return { succeeded: true, outcome: "", output: null };
      });
      await restore(made.context, { target });

      const later = await afterCrash(left!, composeRan);

      expect(later.backups.isBlocked("web")).toBe(true);
      expect(later.events.filter((event) => /^(start|policy) /.test(event))).toEqual([]);
      expect(later.running.get("web")).toBe(composeRan);
    });

    it("comes up from Compose when restored again after a runner died with the files back, before Compose", async () => {
      const made = withStacks("image: wiki:2");
      let left: Map<string, Record<string, string>> | null = null;
      made.run.mockImplementation(async () => {
        left = new Map(made.context.volumes);
        throw new Error("the runner went down here");
      });
      await restore(made.context, { target });
      // The next runner, on a host where the cut-off restore had already put the backup's files back.
      const later = withStacks("image: wiki:1");
      for (const [name, labels] of left!) later.context.volumes.set(name, labels);
      later.context.running.set("web", false);
      later.context.policies.set("web", "no");
      await later.context.backups.recover();

      const { succeeded } = await restore(later.context, { target });

      expect(order(later.context)).toEqual(["stack up", "start web"]);
      expect(succeeded).toBe(true);
      expect(later.context.backups.isBlocked("web")).toBe(false);
    });

    it("leaves it stopped and says it is not back when Compose could not bring it up", async () => {
      const { context, run } = withStacks("image: wiki:2");
      run.mockImplementation(async () => {
        context.events.push("stack up");
        return { succeeded: false, outcome: "no such image wiki:1", output: null };
      });

      const { succeeded, outcome } = await restore(context, { target });

      // Not started on its current image to paper over it: left as it is, with the safety copy still there.
      expect(order(context)).toEqual(["stop web", "stack up"]);
      expect(context.running.get("web")).toBe(false);
      expect(succeeded).toBe(false);
      expect(outcome).toContain(BACKUP_TEXT.restoredNotUp("web"));
    });

    it("says a container of no stack keeps the settings and image it runs now", async () => {
      const standalone = {
        ...manifest({ name: "app", image: "app:1" }),
        hasSettings: true,
        target: { container: "app", stack: null },
      };
      const context = setup({ app: APP }, { answers: readable(standalone) });
      const backups = context.backups as unknown as {
        dependencies: { stacks: unknown; docker: Record<string, unknown> };
      };
      backups.dependencies.stacks = { answer: vi.fn(), run: vi.fn() };
      const original = backups.dependencies.docker.streamCommand as (...args: unknown[]) => Promise<unknown>;
      backups.dependencies.docker.streamCommand = async (
        reference: string,
        command: readonly string[],
        options: { input?: Readable; output: Writable },
      ) => {
        if (command[4] !== COPY_COMMAND.reveal) return original(reference, command, options);
        options.output.end(Buffer.from(JSON.stringify({ projects: [], files: [], containers: [{ name: "app" }] })));
        return { exitCode: 0, stderr: "" };
      };

      const { succeeded, outcome } = await restore(context, { target: { container: "app", stack: null } });

      expect(succeeded).toBe(true);
      expect(outcome).toContain(BACKUP_TEXT.ownSettingsNotRestored("app"));
    });
  });

  it("are put back only when they differ, and it comes up from them", async () => {
    const { context, answer, run } = withStacks("image: wiki:2");
    const { succeeded } = await restore(context, { target });
    expect(succeeded).toBe(true);
    expect(answer).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "save", files: [{ path: COMPOSE, text: "image: wiki:1", hash: "h" }] }),
    );
    expect(run).toHaveBeenCalledWith(JOB_ACTION.stackUp, { project: PROJECT, removeData: false });
  });

  it("are left alone when they are the same, and the stack still comes up from them", async () => {
    const { context, answer, run } = withStacks("image: wiki:1");
    await restore(context, { target });
    expect(answer).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "save" }));
    expect(run).toHaveBeenCalledWith(JOB_ACTION.stackUp, { project: PROJECT, removeData: false });
  });

  it("say so if they could not be, and the restore does not pass for having the data back", async () => {
    const { context } = withStacks("image: wiki:2", "the host keeps these to itself");

    const { succeeded, outcome } = await restore(context, { target });

    // The data really is back, and the outcome says so; what was asked for is not all there, so it is not finished.
    expect(outcome).toContain("left as they are");
    expect(outcome).toContain("did not finish");
    expect(succeeded).toBe(false);
  });

  describe("a part of the restore that was asked for and did not happen", () => {
    // Compose answers that it failed without throwing, and leaves the container running all the same.
    const composeRefuses = (made: ReturnType<typeof withStacks>) =>
      made.run.mockImplementation(async () => {
        made.context.events.push("stack up");
        await made.context.docker.start("web");
        return { succeeded: false, outcome: "no such image wiki:1", output: null };
      });

    it("fails the restore and says which stack and why, though its container runs", async () => {
      const made = withStacks("image: wiki:2");
      composeRefuses(made);

      const { succeeded, outcome } = await restore(made.context, { target });

      expect(made.context.running.get("web")).toBe(true);
      expect(succeeded).toBe(false);
      expect(outcome).toContain(BACKUP_TEXT.stackNotUp(PROJECT, "no such image wiki:1"));
    });

    it("stays on record and leaves its containers alone, so a restart still finds it", async () => {
      const made = withStacks("image: wiki:2");
      composeRefuses(made);
      await restore(made.context, { target });

      expect(made.context.backups.isBlocked("web")).toBe(true);
      // What a runner coming up again reads: the record is still there, and marked as unfinished.
      const kept = [...made.context.volumes.entries()].filter(([name]) =>
        name.startsWith(CONTAINER_BACKUP.journalPrefix),
      );
      expect(kept).toHaveLength(1);
      const record = JSON.parse(kept[0]![1][CONTAINER_BACKUP.journalRecord]!) as { phase: string };
      expect(record.phase).toBe("incomplete");
    });

    it("is cleared by a restore that does finish, which closes the record and lets go of them", async () => {
      const made = withStacks("image: wiki:2");
      composeRefuses(made);
      await restore(made.context, { target });
      expect(made.context.backups.isBlocked("web")).toBe(true);

      made.run.mockImplementation(async () => {
        made.context.events.push("stack up");
        await made.context.docker.start("web");
        return { succeeded: true, outcome: "", output: null };
      });
      const { succeeded } = await restore(made.context, { target });

      expect(succeeded).toBe(true);
      expect(made.context.backups.isBlocked("web")).toBe(false);
      expect(
        [...made.context.volumes.keys()].filter((name) => name.startsWith(CONTAINER_BACKUP.journalPrefix)),
      ).toEqual([]);
    });

    it("keeps the record when a member did not come back, even with every phase answered", async () => {
      const made = withStacks("image: wiki:2");
      made.run.mockImplementation(async () => {
        made.context.events.push("stack up");
        return { succeeded: true, outcome: "", output: null };
      });

      const { succeeded, outcome } = await restore(made.context, { target });

      expect(succeeded).toBe(false);
      expect(outcome).toContain(BACKUP_TEXT.restoredNotUp("web"));
      expect(made.context.backups.isBlocked("web")).toBe(true);
    });
  });
});

describe("on a backup folder several hosts share", () => {
  const UNFINISHED = new RegExp(`^${OWN}/app/\\${CONTAINER_BACKUP.unfinishedPrefix}\\d{8}T\\d{6}Z$`);
  const onlyIn = (folder: string) => ({
    [COPY_COMMAND.read]: (input: unknown) => {
      if ((input as { folder: string }).folder !== folder) throw new Error("no such file");
      return { manifest: sealed(manifest()), key: "c2VhbGVk" };
    },
  });

  it("makes, checks and keeps a backup in this host's own folder, and lets go of old ones only there", async () => {
    const context = setup({ app: APP });
    expect((await backUp(context)).succeeded).toBe(true);
    const [captured] = inputsOf(context, COPY_COMMAND.capture);
    expect(captured!.folder).toMatch(UNFINISHED);
    const stored = context.asked.filter(({ what }) => what === COPY_COMMAND.store).map(({ args }) => args[0]);
    expect(stored).toEqual([captured!.folder]);
    expect(inputsOf(context, COPY_COMMAND.verify)).toMatchObject([{ folder: captured!.folder }]);
    expect(inputsOf(context, COPY_COMMAND.finish)).toMatchObject([
      { parent: `${OWN}/app`, unfinished: captured!.folder },
    ]);
  });

  it("lists this host's own folder and the one every host shared before, for it and for its stack", async () => {
    const context = setup({ app: { ...APP, project: "pair" } });
    await context.backups.answer({
      id: "r",
      kind: "list",
      target: { container: "app", stack: null },
      directory: "/var/backups/autoheal",
      hostId: HOST,
    });
    expect(inputsOf(context, COPY_COMMAND.list)).toEqual([
      { folders: [`${OWN}/app`, "app", `${OWN}/_stack_pair`, "_stack_pair"] },
    ]);
  });

  it.each([
    ["this host's own folder", `${OWN}/app/${RESTORE_ID}`],
    ["the folder every host shared before", `app/${RESTORE_ID}`],
  ])("restores a backup from %s, and keeps its safety copy in its own", async (_where, folder) => {
    const context = setup({ app: APP }, { answers: onlyIn(folder) });
    expect((await restore(context)).succeeded).toBe(true);
    expect(inputsOf(context, COPY_COMMAND.restore)).toMatchObject([{ folder }]);
    expect(inputsOf(context, COPY_COMMAND.finish)).toMatchObject([{ parent: `${OWN}/app`, protect: RESTORE_ID }]);
  });

  it("keeps to the folder it always used when an older dashboard names no host", async () => {
    const context = setup({ app: APP });
    expect((await backUp(context, { hostId: undefined })).succeeded).toBe(true);
    expect(inputsOf(context, COPY_COMMAND.finish)).toMatchObject([{ parent: "app" }]);
  });
});

describe("after a crash", () => {
  it("clears away a helper left running", async () => {
    const context = setup({ app: APP });
    const dependencies = (context.backups as unknown as { dependencies: { docker: Record<string, unknown> } })
      .dependencies;
    const removed: string[] = [];
    dependencies.docker.containerSummaries = async () => [
      { Id: "left-behind", Labels: { [CONTAINER_BACKUP.helperLabel]: "1" } },
      { Id: "app", Labels: {} },
    ];
    dependencies.docker.remove = async (id: string) => {
      removed.push(id);
    };
    await context.backups.recover();
    expect(removed).toEqual(["left-behind"]);
  });

  it("starts what a backup had stopped", async () => {
    const context = setup({ app: { ...APP, running: false } });
    await context.volumes.set("x", {
      [CONTAINER_BACKUP.journalRecord]: JSON.stringify({
        id: "job",
        revision: 0,
        kind: "backup",
        phase: "stopped",
        stopped: [{ id: "id-app", name: "app", policy: null }],
      }),
    });
    await context.backups.recover();
    expect(context.running.get("app")).toBe(true);
    expect(context.backups.isBlocked("app")).toBe(false);
  });

  it("leaves what a restore was writing to stopped, and blocked", async () => {
    const context = setup({ app: { ...APP, running: false } });
    await context.volumes.set("x", {
      [CONTAINER_BACKUP.journalRecord]: JSON.stringify({
        id: "job",
        revision: 1,
        kind: "restore",
        phase: "writing",
        stopped: [{ id: "id-app", name: "app", policy: { Name: "always", MaximumRetryCount: 0 } }],
      }),
    });
    await context.backups.recover();
    expect(context.running.get("app")).toBe(false);
    expect(context.backups.isBlocked("app")).toBe(true);
  });
});
