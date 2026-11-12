import { UPDATE_GROUP_LABEL } from "./update-group.js";
import { describe, expect, it, vi } from "vitest";
import { JOB_OUTCOMES, OUTCOME_TEXT_LIMIT, STACK_OUTCOMES } from "../shared/constants.js";
import type {
  ContainerJob,
  ContainerSettings,
  ImageJob,
  NetworkCreationJob,
  NetworkRemovalJob,
  VolumeCreationJob,
  VolumeRemovalJob,
} from "../shared/protocol.js";
import { OperationCoordinator } from "./operation-coordinator.js";
import { ContainerJobs, type ContainerJobsDependencies } from "./container-jobs.js";
import type { SettingsWrite } from "./stacks.js";
import type { ContainerSummary, DockerNetwork, DockerVolume, ImageSummary } from "./docker-client.js";
import { exitedContainer } from "../../test/fakes/fake-docker-engine.js";

const job = (overrides: Partial<ContainerJob>): ContainerJob => ({
  id: "j1",
  containerName: "paperless",
  action: "restart",
  requestedBy: "admin",
  expiresAt: Date.now() + 60_000,
  ...overrides,
});

const imageJob = (images: string[]): ImageJob => ({
  id: "j2",
  containerName: "",
  action: "remove_images",
  images,
  requestedBy: "admin",
  expiresAt: Date.now() + 60_000,
});

// What the host's Docker holds: images in use, one kept for rolling back, and three no container uses.
const BUILT = 1_760_000_000;
const IMAGES: ImageSummary[] = [
  { Id: "sha256:paperless", RepoTags: ["paperless:2"], Size: 500_000_000, Created: BUILT },
  { Id: "sha256:paperless-before", RepoTags: ["paperless:2-autoheal-previous"], Size: 480_000_000, Created: BUILT },
  { Id: "sha256:stopped", RepoTags: ["yt-dlp-web-custom:latest"], Size: 300_000_000, Created: BUILT },
  { Id: "sha256:old-tika", RepoTags: ["tika:2", "apache/tika:2"], Size: 12_000_000, Created: BUILT },
  { Id: "sha256:dangling", RepoTags: ["<none>:<none>"], Size: 8_000_000, Created: BUILT },
  { Id: "sha256:taken-meanwhile", RepoTags: ["whoami:1"], Size: 4_150_000, Created: BUILT },
];
const CONTAINERS: ContainerSummary[] = [
  { Id: "c1", Names: ["/paperless"], ImageID: "sha256:paperless", State: "running", Status: "Up" },
  { Id: "c2", Names: ["/yt-dlp-web"], ImageID: "sha256:stopped", State: "exited", Status: "Exited (0)" },
];

function jobsWith(
  overrides: {
    dryRun?: boolean;
    logs?: string;
    missing?: boolean;
    running?: boolean;
    failRestart?: boolean;
    updateOutcome?: string;
    clearBuildCache?: boolean;
    containerAccess?: boolean;
    editRefusal?: string;
    stacks?: ContainerJobsDependencies["stacks"];
    // What the control plane holds for an edit job: none when it restarted meanwhile.
    settings?: ContainerSettings | null;
    // The containers that run inside the job's container's network.
    dependents?: string[];
    onUpdate?: () => Promise<void>;
    networks?: DockerNetwork[];
    summaries?: ContainerSummary[];
    volumes?: DockerVolume[];
    // Null: Docker could not count them.
    sizes?: ReadonlyMap<string, number> | null;
  } = {},
) {
  const calls: string[] = [];
  const updateOptions: { allowWithoutCheckpoint?: boolean }[] = [];
  const container = exitedContainer("paperless", {
    Config: { Image: "paperless:2", Env: ["PAPERLESS_DBPASS=hunter2-but-longer"] },
  });
  const dependencies: ContainerJobsDependencies = {
    docker: {
      inspect: async (name) =>
        overrides.missing
          ? null
          : {
              ...container,
              Id: name,
              Name: `/${name}`,
              State: { ...container.State, Running: overrides.running ?? false },
            },
      restart: async (name) => {
        calls.push(`restart ${name}`);
        if (overrides.failRestart) {
          throw new Error("Docker answered HTTP 500");
        }
      },
      start: async (name) => void calls.push(`start ${name}`),
      stop: async (name) => void calls.push(`stop ${name}`),
      removeStopped: async (name) => void calls.push(`removed ${name}`),
      pause: async (name) => void calls.push(`pause ${name}`),
      unpause: async (name) => void calls.push(`unpause ${name}`),
      logs: async () => overrides.logs ?? "",
      allEnvironmentEntries: async () => ["DATABASE_URL=postgres://paperless:s3cr3t-password@db/paperless"],
      containerSummaries: async () => overrides.summaries ?? CONTAINERS,
      images: async () => IMAGES,
      networks: async () => overrides.networks ?? [],
      createNetwork: async ({ name }) => {
        if (name === "taken") throw new Error("Docker answered HTTP 409: network taken already exists");
        calls.push(`create network ${name}`);
        return { Name: name, IPAM: { Config: [{ Subnet: "192.168.128.0/20" }] } };
      },
      removeNetwork: async (name) => {
        if (name === "busy") throw new Error("Docker answered HTTP 403: network busy has active endpoints");
        calls.push(`remove network ${name}`);
      },
      connect: async (network, name) => void calls.push(`connect ${name} to ${network}`),
      allVolumes: async () => overrides.volumes ?? [],
      volumeSizes: async () => {
        if (overrides.sizes === null) throw new Error("Docker answered HTTP 500");
        return overrides.sizes ?? new Map();
      },
      createVolume: async (name, _labels, options) => {
        if (name === "taken") throw new Error("Docker answered HTTP 409");
        calls.push(`create volume ${name} ${JSON.stringify(options)}`);
      },
      removeVolume: async (name) => {
        if (name === "stuck") throw new Error("Docker answered HTTP 409: volume is in use");
        calls.push(`remove volume ${name}`);
      },
      removeImage: async (reference) => {
        if (reference === "whoami:1") {
          throw new Error("Docker answered HTTP 409: image is being used by running container");
        }
        calls.push(`remove ${reference}`);
      },
      pruneBuildCache: async () => {
        calls.push("clear build cache");
        return 1_822_000_000;
      },
    },
    updater: {
      update: async (name, undoIfUnhealthy, _steps, options) => {
        await overrides.onUpdate?.();
        updateOptions.push(options ?? {});
        return {
          succeeded: true,
          outcome: overrides.updateOutcome ?? `updated ${name}${undoIfUnhealthy ? ", undone if unhealthy" : ""}`,
        };
      },
      rollBack: async (name) => ({ succeeded: true, outcome: `rolled back ${name}` }),
      recreate: async (name) => ({ succeeded: true, outcome: `recreated ${name}` }),
      dependentsOf: async () => overrides.dependents ?? [],
      editRefusal: async () => overrides.editRefusal ?? null,
      edit: async (name, settings) => ({
        succeeded: true,
        outcome: `edited ${name}: ${settings.environment.map((entry) => entry.name).join(",")}`,
      }),
    },
    ...(overrides.stacks === undefined ? {} : { stacks: overrides.stacks }),
    settingsOf: async (jobId) => {
      calls.push(`settings of ${jobId}`);
      if (overrides.settings === null || overrides.settings === undefined) {
        throw new Error("404");
      }
      return overrides.settings;
    },
    updates: { checkAll: async () => ({ images: 12, available: 3, unknown: 1 }) },
    guard: {
      noteKill: () => {},
      persisted: async () => {},
      rollbackOf: async () => null,
      operations: new OperationCoordinator(),
      hold: (name) => void calls.push(`held ${name}`),
      release: (name) => void calls.push(`released ${name}`),
    },
    settings: {
      containerAccess: overrides.containerAccess ?? true,
      dryRun: overrides.dryRun ?? false,
      protectedContainers: new Set(["npm"]),
      selfContainerName: "autoheal",
    },
    reportInventory: () => void calls.push("reported"),
    reportProgress: async (jobId, progress) => void calls.push(`progress ${jobId} ${progress.phase}`),
    clearBuildCache: () => overrides.clearBuildCache ?? false,
    // Given to Ollama: its failed updates are undone at once.
    undoesFailedUpdate: (name) => name === "radicale",
  };
  return { jobs: new ContainerJobs(dependencies), calls, updateOptions, dependencies };
}

describe("ContainerJobs", () => {
  it("refuses reviewed scope drift after waiting for the atomic operation lease", async () => {
    let updates = 0;
    const fixture = jobsWith({
      onUpdate: async () => {
        updates++;
      },
    });
    const preview = await fixture.jobs.preview("paperless", "update");
    if (!preview.ok) throw new Error("preview failed");
    const blocker = await fixture.dependencies.guard.operations.acquire(["name:paperless"]);
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fixture.dependencies.reportProgress = async (_id, progress) => {
      if (progress.phase === "waiting") entered();
    };
    const running = fixture.jobs.run(job({ action: "update", expectedResourcesFingerprint: preview.fingerprint }));
    await waiting;
    const inspect = fixture.dependencies.docker.inspect;
    fixture.dependencies.docker.inspect = async (name) => {
      const value = await inspect(name);
      return value ? { ...value, Id: `${value.Id}-new` } : value;
    };
    blocker.release();
    const result = await running;
    expect(result.succeeded).toBe(false);
    expect(result.outcome).toContain("reviewed operation scope changed");
    expect(updates).toBe(0);
  });

  it("previews exactly the coordinator resource set and refuses a drifted instance before mutation", async () => {
    let updates = 0;
    const fixture = jobsWith({
      dependents: ["client"],
      onUpdate: async () => {
        updates++;
      },
    });
    const preview = await fixture.jobs.preview("paperless", "update");
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error("preview failed");
    expect(preview.members.map((member) => member.name)).toContain("client");
    expect(fixture.calls).toEqual([]);
    const inspect = fixture.dependencies.docker.inspect;
    fixture.dependencies.docker.inspect = async (name) => {
      const details = await inspect(name);
      return details ? { ...details, Id: `${details.Id}-changed` } : null;
    };
    const result = await fixture.jobs.run(job({ action: "update", expectedResourcesFingerprint: preview.fingerprint }));
    expect(result.succeeded).toBe(false);
    expect(result.outcome).toContain("reviewed operation scope changed");
    expect(updates).toBe(0);
  });
  it("checks reviewed scope again after a slow pull while allowing its own admitted replacement IDs", async () => {
    const fixture = jobsWith();
    const preview = await fixture.jobs.preview("paperless", "update");
    if (!preview.ok) throw new Error("preview failed");
    const inspect = fixture.dependencies.docker.inspect;
    let changed = false;
    fixture.dependencies.docker.inspect = async (name) => {
      const details = await inspect(name);
      return details && changed ? { ...details, Id: `${details.Id}-changed` } : details;
    };
    fixture.dependencies.updater.update = async (_name, _undo, _steps, options) => {
      changed = true; // Another actor changed the workload while pulling the image.
      return { succeeded: (await options?.authorize?.()) === true, outcome: "not admitted" };
    };
    expect(
      (await fixture.jobs.run(job({ action: "update", expectedResourcesFingerprint: preview.fingerprint }))).succeeded,
    ).toBe(false);
    changed = false;
    fixture.dependencies.updater.update = async (_name, _undo, _steps, options) => {
      expect(await options?.authorize?.()).toBe(true);
      changed = true; // The admitted operation now creates its own replacement.
      expect(await options?.authorize?.()).toBe(true);
      return { succeeded: true, outcome: "updated" };
    };
    expect(
      (await fixture.jobs.run(job({ action: "update", expectedResourcesFingerprint: preview.fingerprint }))).succeeded,
    ).toBe(true);
  });
  it("refuses a protected member discovered only through the full locked group", async () => {
    const fixture = jobsWith({ dependents: ["client"] });
    fixture.dependencies.settings.protectedContainers = new Set(["client"]);
    const preview = await fixture.jobs.preview("paperless", "update");
    expect(preview).toMatchObject({
      ok: true,
      members: expect.arrayContaining([{ name: "client", protected: true }]),
      refusals: ["The affected lock set includes protected containers."],
    });
  });

  it("refuses delegated work without a current authorizer, on rejection or on loss of connectivity", async () => {
    for (const authorizeOperator of [
      undefined,
      async () => false,
      async () => {
        throw new Error("offline");
      },
    ]) {
      const fixture = jobsWith();
      fixture.dependencies.authorizeOperator = authorizeOperator;
      expect((await fixture.jobs.run(job({ operatorUserId: "operator" }))).succeeded).toBe(false);
      expect(fixture.calls).not.toContain("restart paperless");
    }
  });

  it("authorizes actual full group scopes after waiting and refuses revoked permissions without mutation", async () => {
    let updates = 0;
    let permitted = true;
    const fixture = jobsWith({
      dependents: ["client"],
      onUpdate: async () => {
        updates += 1;
      },
    });
    const targets: unknown[] = [];
    fixture.dependencies.authorizeOperator = async (id, members) => {
      expect(id).toBe("j1");
      targets.push(members);
      return permitted;
    };
    const inspect = fixture.dependencies.docker.inspect;
    fixture.dependencies.docker.inspect = async (name) => {
      const details = await inspect(name);
      return details === null
        ? null
        : {
            ...details,
            Config: {
              ...details.Config,
              Labels: { "com.docker.compose.project": name === "client" ? "client-stack" : "app-stack" },
            },
          };
    };
    expect((await fixture.jobs.run(job({ action: "update", operatorUserId: "operator" }))).succeeded).toBe(true);
    expect(targets).toContainEqual([
      { name: "paperless", composeProject: "app-stack" },
      { name: "client", composeProject: "client-stack" },
    ]);
    const blocker = await fixture.dependencies.guard.operations.acquire(["name:paperless"]);
    let queued!: () => void;
    const waiting = new Promise<void>((resolve) => {
      queued = resolve;
    });
    fixture.dependencies.reportProgress = async (_id, progress) => {
      if (progress.phase === "waiting") queued();
    };
    const run = fixture.jobs.run(job({ action: "update", operatorUserId: "operator" }));
    await waiting;
    permitted = false;
    blocker.release();
    expect((await run).succeeded).toBe(false);
    expect(updates).toBe(1);
  });

  describe("a delegated update whose provider's namespace gains a container after it was admitted", () => {
    // Another Docker client starts one in the provider's namespace, then the updater looks and acts.
    const updatingWith = (joinsMeanwhile: boolean) => {
      const dependents: string[] = [];
      const stopped: string[] = [];
      const fixture = jobsWith({ dependents });
      fixture.dependencies.authorizeOperator = async () => true;
      fixture.dependencies.updater.update = async (name, _undo, _steps, options) => {
        if (joinsMeanwhile) dependents.push("intruder");
        if (!(await options?.authorize?.())) return { succeeded: false, outcome: "refused" };
        stopped.push(...dependents, name);
        return { succeeded: true, outcome: `updated ${name}` };
      };
      return { fixture, stopped };
    };

    it("stops nothing, as the operator was granted only what the job was admitted on", async () => {
      const { fixture, stopped } = updatingWith(true);

      const result = await fixture.jobs.run(job({ action: "update", operatorUserId: "operator" }));

      expect(result.succeeded).toBe(false);
      expect(stopped).toEqual([]);
    });

    it("goes ahead when nothing joined", async () => {
      const { fixture, stopped } = updatingWith(false);

      expect((await fixture.jobs.run(job({ action: "update", operatorUserId: "operator" }))).succeeded).toBe(true);
      expect(stopped).toEqual(["paperless"]);
    });
  });

  it("rechecks a delegated log read before reading its data", async () => {
    const fixture = jobsWith({ logs: "private-log" });
    fixture.dependencies.authorizeOperator = async () => false;
    const result = await fixture.jobs.run(job({ action: "logs", operatorUserId: "operator" }));
    expect(result.succeeded).toBe(false);
    expect(result.output).toBeNull();
  });

  it("checks maintenance on automatic jobs and their full affected group, while allowing explicit manual actions", async () => {
    let updates = 0;
    const { jobs, dependencies } = jobsWith({
      dependents: ["client"],
      onUpdate: async () => {
        updates += 1;
      },
    });
    dependencies.maintenanceHeld = (name) => name === "client";
    const refused = await jobs.run(job({ action: "update", automatic: true }));
    expect(refused.succeeded).toBe(false);
    expect(refused.outcome).toContain("maintenance");
    expect(updates).toBe(0);
    dependencies.maintenanceHeld = () => true;
    expect((await jobs.run(job({ action: "restart", automatic: true }))).succeeded).toBe(false);
    expect((await jobs.run(job({ action: "restart" }))).succeeded).toBe(true);
  });

  it("queues a dependent restart until the provider update releases the whole group", async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { jobs, calls } = jobsWith({
      dependents: ["dependent"],
      onUpdate: async () => {
        entered();
        await barrier;
      },
    });
    const provider = jobs.run(job({ action: "update", containerName: "provider" }));
    await started;
    const dependent = jobs.run(job({ action: "restart", containerName: "dependent" }));
    // A read-only job supplies a deterministic turn boundary without sleeps.
    await jobs.run(job({ action: "logs", containerName: "unrelated" }));
    await jobs.run(job({ action: "restart", containerName: "independent" }));
    expect(calls).toContain("restart independent");
    const overlapped = calls.includes("restart dependent");
    release();
    await Promise.all([provider, dependent]);
    expect(overlapped).toBe(false);
    expect(calls).toContain("restart dependent");
  });

  it("revalidates a group after waiting and refuses a newly discovered protected dependent", async () => {
    const fixture = jobsWith();
    const operations = fixture.dependencies.guard.operations;
    const blocker = await operations.acquire(["name:provider"]);
    let queued!: () => void;
    const waiting = new Promise<void>((resolve) => {
      queued = resolve;
    });
    fixture.dependencies.reportProgress = async (_id, progress) => {
      if (progress.phase === "waiting") {
        queued();
      }
    };
    const run = fixture.jobs.run(job({ action: "update", containerName: "provider" }));
    await waiting;
    fixture.dependencies.updater.dependentsOf = async () => ["npm"];
    blocker.release();
    expect((await run).outcome).toContain("protected");
    expect(fixture.updateOptions).toEqual([]);
    expect(fixture.calls).not.toContain("held provider");
  });

  it("releases every group resource after a failed operation", async () => {
    const fixture = jobsWith({
      dependents: ["dependent"],
      onUpdate: async () => {
        throw new Error("failed update");
      },
    });
    expect((await fixture.jobs.run(job({ action: "update", containerName: "provider" }))).succeeded).toBe(false);
    expect((await fixture.jobs.run(job({ action: "restart", containerName: "dependent" }))).succeeded).toBe(true);
    const lease = fixture.dependencies.guard.operations.tryAcquire(["name:provider", "name:dependent"]);
    expect(lease).not.toBeNull();
    lease!.release();
  });
  it("defaults to required checkpointing and forwards only explicit human-update permission", async () => {
    const { jobs, updateOptions } = jobsWith();
    await jobs.run(job({ action: "update" }));
    await jobs.run(job({ action: "update", allowWithoutCheckpoint: true }));
    expect(updateOptions).toEqual([{ allowWithoutCheckpoint: false }, { allowWithoutCheckpoint: true }]);
  });
  it("removes the images no container uses, by each name, and keeps each container's previous one", async () => {
    const { jobs, calls } = jobsWith();

    expect(await jobs.run(job({ containerName: "", action: "prune_images" }))).toEqual({
      succeeded: true,
      outcome: "Removed 2 images (20 MB). 1 image could not be removed.",
      output: null,
    });
    expect(calls).toEqual(["remove tika:2", "remove apache/tika:2", "remove sha256:dangling", "reported"]);
  });

  describe("volumes", () => {
    const removal = (names: string[], evenWithData = false): VolumeRemovalJob => ({
      id: "j5",
      containerName: "",
      action: "remove_volumes",
      removal: { names, evenWithData },
      requestedBy: "admin",
      expiresAt: Date.now() + 60_000,
    });
    const creation = (name: string, share: VolumeCreationJob["volume"]["share"] = null): VolumeCreationJob => ({
      id: "j6",
      containerName: "",
      action: "create_volume",
      volume: { name, share },
      requestedBy: "admin",
      expiresAt: Date.now() + 60_000,
    });
    const nameless = { "com.docker.volume.anonymous": "" };
    const volumes: DockerVolume[] = [
      { Name: "empty", Labels: nameless },
      { Name: "full", Labels: nameless },
      { Name: "used", Labels: nameless },
      { Name: "stuck", Labels: nameless },
      { Name: "autoheal-guard-370" },
      { Name: "records", Labels: { "autoheal.result.journal": "1" } },
    ];
    const sizes = new Map([
      ["empty", 0],
      ["full", 1_200],
      ["used", 0],
      ["stuck", 0],
      ["autoheal-guard-370", 0],
      ["records", 0],
    ]);
    const summaries: ContainerSummary[] = [
      {
        Id: "c1",
        Names: ["/app"],
        State: "exited",
        Status: "exited",
        Mounts: [{ Type: "volume", Name: "used", Destination: "/data" }],
      },
    ];

    it("without a yes removes only what it finds empty now, whatever the report said", async () => {
      const { jobs, calls } = jobsWith({ volumes, sizes, summaries });

      const { outcome, succeeded } = await jobs.run(removal(["empty", "full", "used", "gone"]));

      expect(succeeded).toBe(true);
      expect(outcome).toBe(
        "Removed empty. Kept full: it is not empty, so it needs a person's yes. Kept used: app still uses it.",
      );
      expect(calls).toEqual(["remove volume empty", "reported"]);
    });

    it("does not call empty what it could not count", async () => {
      const { jobs, calls } = jobsWith({ volumes, sizes: null, summaries });

      expect((await jobs.run(removal(["empty"]))).outcome).toContain("Kept empty: it is not empty");
      expect(calls.filter((call) => call.startsWith("remove volume"))).toEqual([]);
    });

    it("removes data only on a person's yes, and passes on Docker's words", async () => {
      const { jobs, calls } = jobsWith({ volumes, sizes, summaries });

      expect(await jobs.run(removal(["full"], true))).toMatchObject({ succeeded: true, outcome: "Removed full." });
      expect(calls).toContain("remove volume full");
      const failed = await jobs.run(removal(["stuck"], true));
      expect(failed.succeeded).toBe(false);
      expect(failed.outcome).toContain("Could not remove stuck. Docker answered HTTP 409");
    });

    it("never removes Autoheal's own records, by name or by label, even on a yes", async () => {
      const { jobs, calls } = jobsWith({ volumes, sizes, summaries });

      const { outcome } = await jobs.run(removal(["autoheal-guard-370", "records"], true));

      expect(outcome).toContain("autoheal-guard-370 holds Autoheal's own records");
      expect(outcome).toContain("records holds Autoheal's own records");
      expect(calls.filter((call) => call.startsWith("remove volume"))).toEqual([]);
    });

    it("creates one here, or on a share, and changes nothing on a host that only watches", async () => {
      const { jobs, calls } = jobsWith();

      expect((await jobs.run(creation("media"))).outcome).toBe("Created media.");
      await jobs.run(creation("nas", { kind: "nfs", address: "192.168.10.5", path: "/export/media" }));
      await jobs.run(creation("smb", { kind: "smb", address: "nas.local", path: "/media" }));

      expect(calls.filter((call) => call.startsWith("create volume"))).toEqual([
        "create volume media {}",
        'create volume nas {"type":"nfs","o":"addr=192.168.10.5,rw","device":":/export/media"}',
        'create volume smb {"type":"cifs","o":"addr=nas.local,guest","device":"//nas.local/media"}',
      ]);
      expect((await jobs.run(creation("taken"))).outcome).toContain("Could not create taken");
      const watching = jobsWith({ dryRun: true, volumes, sizes });
      expect((await watching.jobs.run(creation("media"))).succeeded).toBe(false);
      expect((await watching.jobs.run(removal(["empty"]))).succeeded).toBe(false);
      expect(watching.calls).toEqual([]);
    });
  });

  describe("networks", () => {
    const removalJob = (names: string[], evenIfStoppedNeedIt = false): NetworkRemovalJob => ({
      id: "j3",
      containerName: "",
      action: "remove_networks",
      removal: { names, evenIfStoppedNeedIt },
      requestedBy: "admin",
      expiresAt: Date.now() + 60_000,
    });
    const creationJob = (name: string, containers: string[] = []): NetworkCreationJob => ({
      id: "j4",
      containerName: "",
      action: "create_network",
      network: { name, driver: "bridge", internal: false, subnet: null, parent: null, containers },
      requestedBy: "admin",
      expiresAt: Date.now() + 60_000,
    });
    const on = (name: string, State: string, network: string): ContainerSummary => ({
      Id: name,
      Names: [`/${name}`],
      State,
      Status: State,
      NetworkSettings: { Networks: { [network]: { IPAddress: "" } } },
    });
    const networks: DockerNetwork[] = ["empty", "busy", "kept", "bridge", "self"].map((Name) => ({ Name }));
    const summaries = [on("runs", "running", "busy"), on("old", "exited", "kept"), on("autoheal", "running", "self")];

    it("removes what is free, keeps what a stopped container needs, and passes on Docker's own words", async () => {
      const { jobs, calls } = jobsWith({ networks, summaries });

      const result = await jobs.run(removalJob(["empty", "kept", "busy", "gone"]));

      expect(result.succeeded).toBe(false);
      expect(result.outcome).toBe(
        "Removed empty. Kept kept: old would not start again without it. Could not remove busy. Docker answered HTTP 403: network busy has active endpoints",
      );
      expect(calls).toEqual(["remove network empty", "reported"]);
    });

    it("removes one a stopped container needs only when a person said so", async () => {
      const { jobs, calls } = jobsWith({ networks, summaries });

      expect(await jobs.run(removalJob(["kept"], true))).toMatchObject({ succeeded: true, outcome: "Removed kept." });
      expect(calls).toContain("remove network kept");
    });

    it("never removes Docker's own, or the network it stands on, whatever it is asked", async () => {
      const { jobs, calls } = jobsWith({ networks, summaries });

      const { outcome } = await jobs.run(removalJob(["bridge", "self"], true));

      expect(outcome).toContain("bridge belongs to Docker or Autoheal");
      expect(outcome).toContain("self belongs to Docker or Autoheal");
      expect(calls.filter((call) => call.startsWith("remove network"))).toEqual([]);
    });

    it("creates one with the containers chosen, says where, and skips what the host keeps to itself", async () => {
      const { jobs, calls } = jobsWith();

      const result = await jobs.run(creationJob("media", ["radarr", "npm", "autoheal"]));

      expect(result).toEqual({
        succeeded: true,
        outcome:
          "Created media, with radarr on it. Could not put npm on it. This host keeps it to itself. Could not put autoheal on it. This host keeps it to itself.",
        output: "192.168.128.0/20",
      });
      expect(calls).toEqual(["create network media", "connect radarr to media", "reported"]);
    });

    it("says why when Docker will not create it, and changes nothing on a host that only watches", async () => {
      expect(await jobsWith().jobs.run(creationJob("taken"))).toMatchObject({
        succeeded: false,
        outcome: "Could not create taken. Docker answered HTTP 409: network taken already exists",
      });
      const watching = jobsWith({ dryRun: true, networks, summaries });
      expect((await watching.jobs.run(creationJob("media"))).succeeded).toBe(false);
      expect((await watching.jobs.run(removalJob(["empty"]))).succeeded).toBe(false);
      expect(watching.calls).toEqual([]);
    });
  });

  it("removes only the ticked images still unused, a kept one too, and says how many stayed", async () => {
    const { jobs, calls } = jobsWith();
    const ticked = ["sha256:paperless-before", "sha256:dangling", "sha256:taken-meanwhile", "sha256:paperless"];

    expect(await jobs.run(imageJob(ticked))).toEqual({
      succeeded: true,
      outcome: "Removed 2 images (488 MB). 2 images stayed: in use again, or gone already.",
      output: null,
    });
    expect(calls).toEqual(["remove paperless:2-autoheal-previous", "remove sha256:dangling", "reported"]);

    const watching = jobsWith({ dryRun: true });
    expect((await watching.jobs.run(imageJob(ticked))).outcome).toBe("DRY RUN: would remove 3 images (492 MB).");
    expect(watching.calls).toEqual([]);
  });

  it("clears the build cache too when the host's page says so, and only says what it would do in dry-run", async () => {
    const live = jobsWith({ clearBuildCache: true });
    expect((await live.jobs.run(job({ containerName: "", action: "prune_images" }))).outcome).toBe(
      "Removed 2 images (20 MB). Cleared 1.8 GB of build cache. 1 image could not be removed.",
    );
    expect(live.calls.slice(-2)).toEqual(["clear build cache", "reported"]);

    const watching = jobsWith({ dryRun: true, clearBuildCache: true });
    expect(await watching.jobs.run(job({ containerName: "", action: "prune_images" }))).toEqual({
      succeeded: false,
      outcome: "DRY RUN: would remove 3 images (24 MB) and clear the build cache.",
      output: null,
    });
    expect(watching.calls).toEqual([]);
  });

  it("recreates, and undoes a failed update at once only for a container given to Ollama", async () => {
    const { jobs, calls } = jobsWith();
    expect((await jobs.run(job({ action: "recreate" }))).outcome).toBe("recreated paperless");
    expect((await jobs.run(job({ action: "update" }))).outcome).toBe("updated paperless");
    expect((await jobs.run(job({ containerName: "radicale", action: "update" }))).outcome).toBe(
      "updated radicale, undone if unhealthy",
    );
    expect(calls.filter((call) => call.startsWith("held"))).toEqual([
      "held paperless",
      "held paperless",
      "held radicale",
    ]);
  });

  it("restarts, keeping healing away from the container until it is done", async () => {
    const { jobs, calls } = jobsWith();
    expect(await jobs.run(job({}))).toEqual({ succeeded: true, outcome: "Restarted paperless.", output: null });
    expect(calls).toEqual(["held paperless", "restart paperless", "released paperless"]);
  });

  it("changes a container's settings with those its job names, fetched once, where the host lets people reach inside", async () => {
    const settings: ContainerSettings = {
      environment: [{ name: "TZ", value: "Europe/Lisbon" }],
      labels: [],
      ports: [],
      mounts: [],
      restart: { policy: "unless-stopped", retries: 0 },
    };
    const { jobs, calls } = jobsWith({ settings });
    expect((await jobs.run(job({ id: "j-edit", action: "edit" }))).outcome).toBe("edited paperless: TZ");
    expect(calls).toEqual(["held paperless", "settings of j-edit", "released paperless"]);

    // The control plane restarted before the runner fetched them: nothing to apply.
    expect((await jobsWith({ settings: null }).jobs.run(job({ action: "edit" }))).outcome).toBe(
      "The settings to apply were lost: the dashboard restarted before this host's runner fetched them. Change them again.",
    );
    const refused = jobsWith({ settings, containerAccess: false });
    expect((await refused.jobs.run(job({ action: "edit" }))).outcome).toBe(
      "Refused: this host's CONTAINER_ACCESS is not on.",
    );
    expect(refused.calls).toEqual([]);
  });

  it("pauses and unpauses, keeping healing away meanwhile, and never a protected container", async () => {
    const { jobs, calls } = jobsWith();
    expect(await jobs.run(job({ action: "pause" }))).toEqual({
      succeeded: true,
      outcome: "Paused paperless.",
      output: null,
    });
    expect(await jobs.run(job({ action: "unpause" }))).toEqual({
      succeeded: true,
      outcome: "Unpaused paperless.",
      output: null,
    });
    expect((await jobs.run(job({ action: "pause", containerName: "npm" }))).succeeded).toBe(false);
    expect(calls).toEqual([
      "held paperless",
      "pause paperless",
      "released paperless",
      "held paperless",
      "unpause paperless",
      "released paperless",
    ]);
  });

  it("removes a container, a running one stopped first, never in dry-run or one the host protects", async () => {
    const stopped = jobsWith();
    expect(await stopped.jobs.run(job({ action: "remove" }))).toEqual({
      succeeded: true,
      outcome: "Removed paperless.",
      output: null,
    });
    expect(stopped.calls).toEqual(["held paperless", "removed paperless", "released paperless"]);

    const running = jobsWith({ running: true });
    expect(await running.jobs.run(job({ action: "remove" }))).toEqual({
      succeeded: true,
      outcome: "Removed paperless.",
      output: null,
    });
    expect(running.calls).toEqual(["held paperless", "stop paperless", "removed paperless", "released paperless"]);
    const dryRun = jobsWith({ dryRun: true });
    expect((await dryRun.jobs.run(job({ action: "remove" }))).succeeded).toBe(false);
    expect((await dryRun.jobs.run(job({ action: "remove", containerName: "npm" }))).outcome).toBe(
      "Refused: npm is protected on this host.",
    );
    expect(dryRun.calls.filter((call) => call.startsWith("removed"))).toEqual([]);
  });

  it("holds every container of a group away from healing while it updates, and refuses one with a protected member", async () => {
    const { jobs, calls } = jobsWith({ dependents: ["qbittorrent", "prowlarr"] });
    expect((await jobs.run(job({ action: "update", containerName: "gluetun" }))).outcome).toBe("updated gluetun");
    expect(calls).toEqual([
      "held gluetun",
      "held qbittorrent",
      "held prowlarr",
      "released gluetun",
      "released qbittorrent",
      "released prowlarr",
    ]);
    const guarded = jobsWith({ dependents: ["qbittorrent", "npm"] });
    expect((await guarded.jobs.run(job({ action: "roll_back", containerName: "gluetun" }))).outcome).toBe(
      "Refused: npm shares gluetun's network and is protected on this host.",
    );
    expect(guarded.calls).toEqual([]);
  });

  it("never changes the runner itself or a protected container, whoever asks", async () => {
    const { jobs, calls } = jobsWith();
    expect((await jobs.run(job({ containerName: "autoheal", action: "stop" }))).outcome).toBe(
      "Refused: the runner does not act on its own container.",
    );
    expect((await jobs.run(job({ containerName: "npm", action: "update" }))).outcome).toBe(
      "Refused: npm is protected on this host.",
    );
    expect((await jobs.run(job({ containerName: "paperless-autoheal-old", action: "update" }))).outcome).toBe(
      "Refused: paperless-autoheal-old is what an update of paperless kept aside. Roll paperless back to it, or remove it.",
    );
    expect((await jobs.run(job({ containerName: "paperless-autoheal-old", action: "start" }))).succeeded).toBe(false);
    expect(calls).toEqual([]);
  });

  it("only says what it would do in dry-run, and nothing for a container that is gone", async () => {
    expect((await jobsWith({ dryRun: true }).jobs.run(job({ action: "update" }))).outcome).toBe(
      "DRY RUN: would update paperless.",
    );
    expect((await jobsWith({ missing: true }).jobs.run(job({}))).outcome).toBe(
      "paperless is not on this host any more.",
    );
  });

  it("turns a failed action into an answer that says why", async () => {
    const result = await jobsWith({ failRestart: true }).jobs.run(job({}));
    expect(result).toEqual({
      succeeded: false,
      outcome: "Could not restart paperless: Docker answered HTTP 500",
      output: null,
    });
  });

  it("retains failed group recovery details in masked job output after releasing its holds", async () => {
    const { jobs, dependencies, calls } = jobsWith({ dependents: ["client"] });
    dependencies.docker.allEnvironmentEntries = async () => ["PAPERLESS_DBPASS=hunter2-but-longer"];
    const recovery = JSON.stringify({
      phase: "dependent-stop-failed",
      stopped: [{ name: "client", id: "original-id" }],
      restartFailures: [{ name: "client", error: "synthetic failure hunter2-but-longer" }],
    });
    dependencies.updater.update = async () => ({
      succeeded: false,
      outcome: "Could not update paperless: stopping client failed.",
      output: recovery,
    });
    const result = await jobs.run(job({ action: "update" }));
    expect(result).toMatchObject({ succeeded: false, output: expect.stringContaining("original-id") });
    expect(result.output).toContain("dependent-stop-failed");
    expect(result.output).not.toContain("hunter2-but-longer");
    expect(calls).toContain("released paperless");
    expect(calls).toContain("released client");
    const lease = dependencies.guard.operations.tryAcquire(["name:paperless", "name:client"]);
    expect(lease).not.toBeNull();
    lease?.release();
  });

  it.each(["restart", "remove", "update"] as const)(
    "refuses %s of a member while its group rollback point is retained",
    async (action) => {
      const { jobs, dependencies, calls } = jobsWith({});
      const inspect = dependencies.docker.inspect;
      const group = {
        version: 1,
        provider: { name: "paperless", id: "old-provider", running: true },
        dependents: [{ name: "client", id: "old-client", running: true }],
      };
      dependencies.docker.inspect = async (name) => {
        const details = (await inspect(name))!;
        if (name === "paperless")
          return { ...details, Config: { ...details.Config, Labels: { [UPDATE_GROUP_LABEL]: JSON.stringify(group) } } };
        if (name === "old-provider") return { ...details, Name: "/paperless-autoheal-old" };
        if (name === "client") return { ...details, HostConfig: { NetworkMode: "container:old-provider" } };
        return details;
      };
      const result = await jobs.run(job({ containerName: "client", action }));
      expect(result.succeeded).toBe(false);
      expect(result.outcome).toContain("retained update group");
      expect(calls.some((call) => call.startsWith("held ") || call.startsWith(`${action} `))).toBe(false);
    },
  );

  it("reserves potential shared-data writers while an update may need automatic rollback", async () => {
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { jobs, dependencies } = jobsWith({
      onUpdate: async () => {
        started();
        await blocked;
      },
    });
    const inspect = dependencies.docker.inspect;
    dependencies.docker.inspect = async (name) => ({
      ...(await inspect(name))!,
      Mounts: [{ Type: "volume", Name: "shared-data", Destination: "/data", RW: true }],
    });
    dependencies.docker.containerSummaries = async () => [
      { Id: "writer", Names: ["/writer"], State: "exited", Status: "Exited" },
    ];
    const update = jobs.run(job({ action: "update", undoIfUnhealthy: true }));
    await entered;
    expect(dependencies.guard.operations.tryAcquire(["name:writer", "id:writer"])).toBeNull();
    release();
    await update;
    const lease = dependencies.guard.operations.tryAcquire(["name:writer", "id:writer"]);
    expect(lease).not.toBeNull();
    lease?.release();
  });

  describe("installing a person's own files", () => {
    const OWN = { own: true as const, folder: "/srv/wiki", compose: "services: {}\n", env: "" };
    const RETRY = { composeSha256: "a".repeat(64), envSha256: "b".repeat(64) };
    const installing = (retry: typeof RETRY | null) => {
      const fixture = jobsWith({});
      const installed: string[] = [];
      Object.assign(fixture.dependencies, {
        installSpecOf: async () => ({ ...OWN, retry }),
        installs: {
          installOwn: async () => {
            installed.push("own");
            return { succeeded: true, outcome: "Up.", logsOf: null };
          },
        },
      });
      return { fixture, installed };
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

    it("waits its turn for a retry, while something else is changing a container", async () => {
      const { fixture, installed } = installing(RETRY);
      const update = await fixture.dependencies.guard.operations.acquire(["name:wiki-1"]);
      const running = fixture.jobs.run(job({ action: "install", containerName: "wiki" }));
      await settle();
      expect(installed).toEqual([]);
      update.release();
      expect((await running).succeeded).toBe(true);
      expect(installed).toEqual(["own"]);
    });

    it("holds off other changes while a retry runs", async () => {
      const { fixture, installed } = installing(RETRY);
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      (fixture.dependencies.installs as unknown as { installOwn: () => Promise<unknown> }).installOwn = async () => {
        installed.push("own");
        await finished;
        return { succeeded: true, outcome: "Up.", logsOf: null };
      };
      const running = fixture.jobs.run(job({ action: "install", containerName: "wiki" }));
      await settle();
      expect(installed).toEqual(["own"]);
      let entered = false;
      const other = fixture.dependencies.guard.operations.acquire(["name:wiki-1"]).then((held) => {
        entered = true;
        held.release();
      });
      await settle();
      expect(entered).toBe(false);
      finish();
      await running;
      await other;
      expect(entered).toBe(true);
    });

    it("does not wait for a first install, which touches nothing that exists", async () => {
      const { fixture, installed } = installing(null);
      const update = await fixture.dependencies.guard.operations.acquire(["name:wiki-1"]);
      expect((await fixture.jobs.run(job({ action: "install", containerName: "wiki" }))).succeeded).toBe(true);
      expect(installed).toEqual(["own"]);
      update.release();
    });
  });

  describe("an edit of a Compose container", () => {
    const SETTINGS = {
      environment: [{ name: "TZ", value: "UTC" }],
      labels: [],
      ports: [],
      mounts: [],
      restart: { policy: "no" as const, retries: 0 },
    };
    const stacksAnswering = (write: SettingsWrite) => ({
      run: async () => ({ succeeded: true, outcome: "", output: null }),
      membersOf: async () => [],
      applySettings: vi.fn(async () => write),
      changeTag: async () => ({ succeeded: true, outcome: "", output: null }),
    });

    it("goes through its file when that can be written", async () => {
      const stacks = stacksAnswering({ written: true, result: { succeeded: true, outcome: "in its file" } });
      const { jobs } = jobsWith({ settings: SETTINGS, stacks });
      expect((await jobs.run(job({ action: "edit" }))).outcome).toBe("in its file");
    });

    it("changes the container alone when it cannot, and says so", async () => {
      const stacks = stacksAnswering({ written: false, reason: "its ports are on one line" });
      const { jobs } = jobsWith({ settings: SETTINGS, stacks });
      expect((await jobs.run(job({ action: "edit" }))).outcome).toBe(
        `edited paperless: TZ ${STACK_OUTCOMES.fileNotChanged("its ports are on one line")}`,
      );
    });

    it("says nothing of a file a container does not have", async () => {
      const stacks = stacksAnswering({ written: false, reason: null });
      const { jobs } = jobsWith({ settings: SETTINGS, stacks });
      expect((await jobs.run(job({ action: "edit" }))).outcome).toBe("edited paperless: TZ");
    });

    it("leaves the file alone for someone whose reach is one container", async () => {
      const stacks = stacksAnswering({ written: true, result: { succeeded: true, outcome: "in its file" } });
      const { jobs } = jobsWith({ settings: SETTINGS, stacks });
      await jobs.run(job({ action: "edit", operatorUserId: "operator" }));
      expect(stacks.applySettings).not.toHaveBeenCalled();
    });

    it("keeps every refusal an edit has, before any file is touched", async () => {
      const stacks = stacksAnswering({ written: false, reason: null });
      const { jobs } = jobsWith({ settings: SETTINGS, stacks, editRefusal: "refused" });
      expect((await jobs.run(job({ action: "edit" }))).outcome).toBe("refused");
      expect(stacks.applySettings).not.toHaveBeenCalled();
    });
  });

  it.each(["start", "restart", "unpause", "update", "recreate", "remove", "edit"] as const)(
    "blocks %s during persisted rollback recovery",
    async (action) => {
      const { jobs, dependencies, calls } = jobsWith({});
      dependencies.guard.rollbackOf = async () => ({
        version: 1,
        id: "00000000-0000-4000-8000-000000000001",
        owner: "paperless",
        phase: "prepared",
        at: null,
        members: [{ name: "paperless", id: "original", replacementId: "replacement", running: true, restore: true }],
      });
      const result = await jobs.run(job({ action }));
      expect(result.succeeded).toBe(false);
      expect(result.outcome).toContain("data recovery for paperless is incomplete");
      expect(calls.filter((call) => call.startsWith("held "))).toEqual([]);
    },
  );

  it("allows recovery during the remove/rename name gap", async () => {
    const { jobs, dependencies } = jobsWith({ missing: true });
    dependencies.guard.rollbackOf = async () => ({
      version: 1,
      id: "00000000-0000-4000-8000-000000000001",
      owner: "paperless",
      phase: "prepared",
      at: null,
      members: [{ name: "paperless", id: "original", replacementId: "replacement", running: true, restore: true }],
    });
    expect((await jobs.run(job({ action: "roll_back" }))).outcome).toBe("rolled back paperless");
  });

  it("cuts an outcome to what the control plane accepts, rather than have the answer refused", async () => {
    const sharing = Array.from({ length: 200 }, (_, index) => `vpn-client-${index}`).join(", ");
    const result = await jobsWith({ updateOutcome: `Refused: ${sharing} share paperless's network.` }).jobs.run(
      job({ action: "update" }),
    );
    expect(result.outcome).toHaveLength(OUTCOME_TEXT_LIMIT);
  });

  it("returns logs with the secrets of every container masked, newest lines kept", async () => {
    const logs = "connecting to postgres://paperless:s3cr3t-password@db/paperless\nusing hunter2-but-longer\n";
    const result = await jobsWith({ logs }).jobs.run(job({ action: "logs", containerName: "npm" }));
    expect(result.succeeded).toBe(true);
    expect(result.output).not.toContain("s3cr3t-password");
    expect(result.output).not.toContain("hunter2-but-longer");
  });

  it("checks every image for updates and reports the inventory at once", async () => {
    const { jobs, calls } = jobsWith();
    const result = await jobs.run(job({ action: "check_updates", containerName: "" }));
    expect(result.outcome).toBe("Checked 12 images: 3 with an update, 1 that could not be checked.");
    expect(calls).toEqual(["reported"]);
  });
});

describe("rollout proof and post-pull admission", () => {
  it("requires current rollout authorization after preparation, then lets an admitted safety settlement finish", async () => {
    const fixture = jobsWith();
    let held = false;
    let checks = 0;
    fixture.dependencies.authorizeOperator = async () => {
      checks++;
      return !held;
    };
    fixture.dependencies.updater.update = async (_name, _undo, _steps, options) => {
      held = true;
      return { succeeded: await options!.authorize!(), outcome: "prepared" };
    };
    const rollout = {
      id: "a1c09362-d48c-4b7f-a331-6d47c8a8dc96",
      targetReference: `example/paperless@sha256:${"a".repeat(64)}`,
      expectedSourceContainerId: "paperless",
      expectedPlatform: "linux/amd64",
      requireStateless: true as const,
    };
    expect((await fixture.jobs.run(job({ action: "update", automatic: true, rollout }))).succeeded).toBe(false);
    expect(checks).toBe(1);
    held = false;
    checks = 0;
    fixture.dependencies.updater.update = async (_name, _undo, _steps, options) => {
      const admitted = await options!.authorize!();
      held = true;
      return { succeeded: admitted && (await options!.authorize!()), outcome: "settled" };
    };
    expect((await fixture.jobs.run(job({ action: "update", automatic: true, rollout }))).succeeded).toBe(true);
    expect(checks).toBe(1);
  });
  it("reports missing mount/platform evidence as unknown and distinguishes writable from stateless mounts", async () => {
    const fixture = jobsWith();
    const unknown = await fixture.jobs.preview("paperless", "update");
    expect(unknown).toMatchObject({ ok: true, rolloutSafety: { writableData: "unknown", platform: null } });
    const inspect = fixture.dependencies.docker.inspect;
    fixture.dependencies.docker.inspect = async (name) => {
      const value = await inspect(name);
      return value ? { ...value, Image: "old-image", HostConfig: {}, Mounts: [] } : null;
    };
    fixture.dependencies.docker.inspectImage = async () => ({ Id: "old-image", Os: "linux", Architecture: "amd64" });
    expect(await fixture.jobs.preview("paperless", "update")).toMatchObject({
      ok: true,
      rolloutSafety: { writableData: "none", platform: "linux/amd64" },
    });
    fixture.dependencies.docker.inspect = async (name) => {
      const value = await inspect(name);
      return value
        ? { ...value, HostConfig: {}, Mounts: [{ Type: "volume", Name: "data", Destination: "/data", RW: true }] }
        : null;
    };
    expect(await fixture.jobs.preview("paperless", "update")).toMatchObject({
      ok: true,
      rolloutSafety: { writableData: "present" },
    });
  });

  describe("a restore's result", () => {
    const restored = (result: object) => {
      const { jobs, dependencies } = jobsWith({});
      dependencies.backups = { run: async () => result } as never;
      return jobs.run(
        job({ action: "restore_container", backup: { target: { container: "paperless", stack: null } } } as never),
      );
    };

    it("carries the name of the safety copy it made", async () => {
      const COPY = "20261102T000000Z";
      const result = await restored({ succeeded: true, outcome: "Restored.", recoveryBackupId: COPY });
      expect(result).toMatchObject({ succeeded: true, outcome: "Restored.", recoveryBackupId: COPY });
    });

    it("names none when it made none", async () => {
      const result = await restored({ succeeded: false, outcome: "Nothing was changed." });
      expect(result).toMatchObject({ succeeded: false, outcome: "Nothing was changed." });
      expect(result).not.toHaveProperty("recoveryBackupId");
    });
  });
});

describe("a newer version handed to the agent", () => {
  it("has its Compose files change the tag, with the data kept by the host's copies, holding the project meanwhile", async () => {
    const changeTag = vi.fn(async () => ({ succeeded: true, outcome: "moved", output: null }));
    const stacks = {
      run: async () => ({ succeeded: true, outcome: "", output: null }),
      membersOf: async () => ["paperless", "paperless-db"],
      applySettings: async () => ({ written: false as const, reason: null }),
      changeTag,
    };
    const { jobs, calls, dependencies } = jobsWith({ stacks });
    const checkpoints = { take: vi.fn(), restore: vi.fn(), discard: vi.fn() };
    dependencies.checkpoints = checkpoints as never;
    dependencies.docker.inspect = async () =>
      ({ Config: { Labels: { "com.docker.compose.project": "paperless" } } }) as never;

    const result = await jobs.run({ ...job({}), action: "change_tag", tag: "2.1" } as never);

    expect(result).toMatchObject({ succeeded: true, outcome: "moved" });
    expect(changeTag).toHaveBeenCalledWith("paperless", "2.1", checkpoints, expect.anything());
    expect(calls).toEqual(
      expect.arrayContaining(["held paperless", "held paperless-db", "released paperless", "released paperless-db"]),
    );
  });

  it("is refused by a delegated operator, and where the host keeps no copies", async () => {
    const stacks = {
      run: async () => ({ succeeded: true, outcome: "", output: null }),
      membersOf: async () => [],
      applySettings: async () => ({ written: false as const, reason: null }),
      changeTag: vi.fn(),
    };
    const { jobs } = jobsWith({ stacks });
    const asOperator = await jobs.run({ ...job({ operatorUserId: "u1" }), action: "change_tag", tag: "2.1" } as never);
    expect(asOperator.succeeded).toBe(false);
    const withoutCopies = await jobs.run({ ...job({}), action: "change_tag", tag: "2.1" } as never);
    expect(withoutCopies).toMatchObject({ succeeded: false, outcome: JOB_OUTCOMES.checkpointUnavailable });
    expect(stacks.changeTag).not.toHaveBeenCalled();
  });
});
