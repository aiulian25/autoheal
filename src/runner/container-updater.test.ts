import {
  EMPTY_TRUST_POLICY,
  PROVENANCE_STATUS,
  type ImageProvenance,
  type ImageTrustPolicy,
} from "../shared/image-provenance.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { ContainerSummary, ImageDetails } from "./docker-client.js";
import { settingsOf } from "./container-settings.js";
import { ContainerUpdater, recreateSpecification, type UpdateSteps } from "./container-updater.js";
import type { ContainerDetails, NetworkEndpoint } from "./incident-report.js";
import type { PullLine } from "./update-progress.js";
import {
  EDIT_OUTCOMES,
  JOB_OUTCOMES,
  RECREATE_OUTCOMES,
  VERIFY_PROBLEMS,
  VOLUME_COPY_MESSAGES,
} from "../shared/constants.js";
import { dataMountsOf, type RestoredData, type TakenCheckpoint } from "./volume-checkpoints.js";

const OLD_IMAGE = `sha256:${"1".repeat(64)}`;
const NEW_IMAGE = `sha256:${"2".repeat(64)}`;
const REFERENCE = "ghcr.io/example/app:2";
const KEPT = "ghcr.io/example/app:2-autoheal-previous";
const ANONYMOUS = "f".repeat(64);
// What a copy too big to make says, as a model store or a media cache would.
const TOO_MUCH_DATA = JOB_OUTCOMES.checkpointSkipped(JOB_OUTCOMES.checkpointTooBig("2.0 GB"));
const completeCheckpoint = (details: ContainerDetails, outcome = ""): TakenCheckpoint => ({
  complete: true,
  containerId: details.Id ?? null,
  mounts: dataMountsOf(details),
  outcome,
});

const imageConfig = {
  Env: ["PATH=/usr/bin", "APP_VERSION=2.0.0"],
  Cmd: ["serve"],
  Entrypoint: ["/entrypoint.sh"],
  Labels: { "org.opencontainers.image.version": "2.0.0" },
  ExposedPorts: { "8080/tcp": {} },
  Volumes: { "/data": {} },
  WorkingDir: "/app",
};

function appContainer(overrides: Partial<ContainerDetails> = {}): ContainerDetails {
  const id = "abcdef123456".padEnd(64, "0");
  return {
    Id: id,
    Name: "/app",
    Image: OLD_IMAGE,
    State: { Status: "running", Running: true, ExitCode: 0 },
    Config: {
      ...imageConfig,
      Image: REFERENCE,
      Hostname: id.slice(0, 12),
      Env: [...imageConfig.Env, "TZ=Europe/Lisbon"],
      Labels: { ...imageConfig.Labels, "com.docker.compose.project": "app", "autoheal.update": "ask" },
      ExposedPorts: { ...imageConfig.ExposedPorts, "9090/tcp": {} },
    },
    HostConfig: {
      NetworkMode: "app_default",
      Binds: ["/srv/app/config:/config:rw"],
      PortBindings: { "8080/tcp": [{ HostPort: "8080" }] },
      RestartPolicy: { Name: "unless-stopped" },
    },
    NetworkSettings: {
      Networks: {
        app_default: { Aliases: ["app", "app", id.slice(0, 12)], MacAddress: "02:42:ac:11:00:02" },
        proxy: { Aliases: ["app"] },
      },
    },
    Mounts: [
      { Type: "bind", Source: "/srv/app/config", Destination: "/config", RW: true },
      {
        Type: "volume",
        Name: ANONYMOUS,
        Source: `/var/lib/docker/volumes/${ANONYMOUS}/_data`,
        Destination: "/data",
        RW: true,
      },
    ],
    ...overrides,
  };
}

/** Enough of the Docker engine for an update: containers by id or name, images by id or tag. */
class InMemoryDocker {
  readonly containers = new Map<string, ContainerDetails>();
  readonly journalVolumes = new Map<string, { Name: string; Labels: Record<string, string> }>();
  async createVolume(name: string, labels: Record<string, string>) {
    this.journalVolumes.set(name, { Name: name, Labels: labels });
  }
  async volumes(filter: string) {
    const [key, value] = filter.split("=");
    return [...this.journalVolumes.values()].filter(({ Labels }) =>
      value === undefined ? Labels[key!] !== undefined : Labels[key!] === value,
    );
  }
  async removeVolume(name: string) {
    this.journalVolumes.delete(name);
  }

  readonly images = new Map<string, ImageDetails>([[OLD_IMAGE, { Id: OLD_IMAGE, Config: imageConfig }]]);
  readonly tags = new Map<string, string>([[REFERENCE, OLD_IMAGE]]);
  readonly calls: string[] = [];
  readonly created: Record<string, unknown>[] = [];
  readonly connected: [string, string, NetworkEndpoint][] = [];
  pulledImage: string = NEW_IMAGE;
  // What Docker recorded for the image it pulled, which a signature has to be over.
  pulledDigests: string[] | null = null;
  failPull = false;
  // A prune at the moment the pull ends: the tag moved, but Docker no longer has the image it points at.
  prunedAfterPull = false;
  failCreate = false;
  readonly failStops = new Set<string>();
  readonly failStarts = new Set<string>();
  // What a container looks like once started; an update's new container can crash or stay unhealthy.
  afterStart: (container: ContainerDetails) => ContainerDetails["State"] = () => ({ Status: "running", Running: true });
  summaries: ContainerSummary[] = [];
  // What a container's logs read: the same for every one.
  logged = "";
  // A container's own health check, run by the updater instead of waiting for Docker's: what it ran, and its answer.
  readonly probed: string[][] = [];
  probePasses = false;

  add(container: ContainerDetails) {
    this.containers.set(container.Id!, structuredClone(container));
  }

  find(reference: string) {
    return [...this.containers.values()].find(
      (container) => container.Id === reference || container.Name === `/${reference}`,
    );
  }

  async inspect(reference: string) {
    const container = this.find(reference);
    return container === undefined ? null : structuredClone(container);
  }

  async inspectImage(reference: string) {
    const image = this.images.get(this.tags.get(reference) ?? reference);
    return image === undefined ? null : structuredClone(image);
  }

  async containerSummaries() {
    return this.summaries;
  }

  async logs() {
    return this.logged;
  }

  async runCommand(_reference: string, command: readonly string[]) {
    this.probed.push([...command]);
    return { exitCode: this.probePasses ? 0 : 1, stdout: "", stderr: "", truncated: false };
  }

  async pull(reference: string, onLine: (line: PullLine) => void = () => undefined) {
    this.calls.push(`pull ${reference}`);
    if (this.failPull) {
      throw new Error("manifest unknown");
    }
    onLine({ id: "4f4fb700ef54", status: "Downloading", progressDetail: { current: 512, total: 1024 } });
    this.images.set(this.pulledImage, {
      Id: this.pulledImage,
      Config: { ...imageConfig, Env: ["PATH=/usr/bin", "APP_VERSION=2.1.0"] },
      ...(this.pulledDigests === null ? {} : { RepoDigests: this.pulledDigests }),
    });
    this.tags.set(reference, this.pulledImage);
    if (this.prunedAfterPull) this.images.delete(this.pulledImage);
  }

  async create(name: string, specification: Record<string, unknown>) {
    this.calls.push(`create ${name}`);
    if (this.failCreate || this.find(name) !== undefined) {
      throw new Error(`Conflict: the name "${name}" is in use, or creation failed`);
    }
    // As Docker refuses it: a container in another's network takes that one's names.
    const networkMode = (specification.HostConfig as { NetworkMode?: string } | undefined)?.NetworkMode ?? "";
    if (networkMode.startsWith("container:") && (specification.Hostname ?? "") !== "") {
      throw new Error('Docker answered HTTP 400: {"message":"conflicting options: hostname and the network mode"}');
    }
    this.created.push(specification);
    const { HostConfig, NetworkingConfig, ...config } = specification as Record<string, never>;
    const endpoints = (NetworkingConfig as { EndpointsConfig: Record<string, NetworkEndpoint> }).EndpointsConfig;
    const id = randomBytes(32).toString("hex");
    this.containers.set(id, {
      Id: id,
      Name: `/${name}`,
      Image: this.tags.get(config.Image as string) ?? (config.Image as string),
      State: { Status: "created", Running: false },
      Config: config as unknown as ContainerDetails["Config"],
      HostConfig,
      NetworkSettings: { Networks: { ...endpoints } },
    });
    return id;
  }

  async rename(reference: string, newName: string) {
    this.calls.push(`rename ${this.find(reference)?.Name} ${newName}`);
    if (this.find(newName) !== undefined) {
      throw new Error(`Conflict: ${newName} is in use`);
    }
    this.find(reference)!.Name = `/${newName}`;
  }

  async stop(reference: string) {
    this.calls.push(`stop ${this.find(reference)?.Name}`);
    if (this.failStops.has(this.find(reference)!.Name)) {
      throw new Error("synthetic stop failure");
    }
    this.find(reference)!.State = { Status: "exited", Running: false, ExitCode: 0 };
  }

  async start(reference: string) {
    const container = this.find(reference)!;
    this.calls.push(`start ${container.Name}`);
    if (this.failStarts.has(container.Name)) {
      throw new Error("synthetic start failure");
    }
    container.State = container.Image === OLD_IMAGE ? { Status: "running", Running: true } : this.afterStart(container);
  }

  async removeStopped(reference: string) {
    const container = this.find(reference);
    this.calls.push(`removeStopped ${container?.Name}`);
    if (container?.State.Running) throw new Error("container is still running");
    if (container !== undefined) this.containers.delete(container.Id!);
  }

  async remove(reference: string) {
    const container = this.find(reference);
    this.calls.push(`remove ${container?.Name}`);
    if (container !== undefined) {
      this.containers.delete(container.Id!);
    }
  }

  async connect(network: string, container: string, endpoint: NetworkEndpoint) {
    this.connected.push([network, container, endpoint]);
  }

  async tag(source: string, repository: string, tag: string) {
    this.calls.push(`tag ${source} ${repository}:${tag}`);
    this.tags.set(`${repository}:${tag}`, this.tags.get(source) ?? source);
  }

  async removeImage(reference: string) {
    this.calls.push(`remove image ${reference}`);
    const inUse = [...this.containers.values()].some((container) => container.Image === reference);
    if (inUse || [...this.tags.values()].includes(reference)) {
      throw new Error(`Conflict: ${reference} is in use or still has a name`);
    }
    this.images.delete(reference);
  }
}

describe("recreateSpecification", () => {
  it("keeps what the person configured and drops what only came from the old image", () => {
    const { create, extraNetworks } = recreateSpecification(appContainer(), imageConfig, REFERENCE);
    expect(create).toMatchObject({
      Image: REFERENCE,
      // APP_VERSION and PATH came from the image; the new image brings its own.
      Env: ["TZ=Europe/Lisbon"],
      Labels: { "com.docker.compose.project": "app", "autoheal.update": "ask" },
      ExposedPorts: { "9090/tcp": {} },
      Volumes: {},
    });
    for (const inherited of ["Cmd", "Entrypoint", "WorkingDir", "Hostname"]) {
      expect(create).not.toHaveProperty(inherited);
    }
    expect(create.HostConfig).toMatchObject({
      PortBindings: { "8080/tcp": [{ HostPort: "8080" }] },
      // The anonymous volume at /data keeps its data: attached by name.
      Binds: ["/srv/app/config:/config:rw", `${ANONYMOUS}:/data`],
    });
    expect(create.NetworkingConfig).toEqual({
      EndpointsConfig: {
        app_default: {
          Aliases: ["app"],
          IPAMConfig: null,
          Links: null,
          MacAddress: "02:42:ac:11:00:02",
          DriverOpts: null,
        },
      },
    });
    expect(extraNetworks.map(([network]) => network)).toEqual(["proxy"]);
  });

  it("keeps settings the person changed from the image's, and a hostname they chose", () => {
    const details = appContainer();
    details.Config = {
      ...details.Config,
      Cmd: ["serve", "--verbose"],
      Hostname: "app-server",
      Env: ["APP_VERSION=1.9.0"],
    };
    const { create } = recreateSpecification(details, imageConfig, REFERENCE);
    expect(create).toMatchObject({ Cmd: ["serve", "--verbose"], Hostname: "app-server", Env: ["APP_VERSION=1.9.0"] });
  });

  it("gives a compose-declared anonymous volume its old volume back, and no networks on the host network", () => {
    const details = appContainer({
      HostConfig: { NetworkMode: "host", Mounts: [{ Type: "volume", Target: "/data" }] },
      NetworkSettings: { Networks: { host: {} } },
    });
    const { create, extraNetworks } = recreateSpecification(details, imageConfig, REFERENCE);
    expect(create.HostConfig).toMatchObject({
      Mounts: [{ Type: "volume", Target: "/data", Source: ANONYMOUS }],
      Binds: [],
    });
    expect(create.NetworkingConfig).toEqual({ EndpointsConfig: {} });
    expect(extraNetworks).toEqual([]);
  });
});

describe("ContainerUpdater", () => {
  let docker: InMemoryDocker;
  let now: number;
  let updater: ContainerUpdater;

  beforeEach(() => {
    docker = new InMemoryDocker();
    docker.add(appContainer());
    now = 0;
    updater = new ContainerUpdater(
      docker,
      async (milliseconds) => {
        now += milliseconds;
      },
      () => now,
      {
        take: async (_name, details) => completeCheckpoint(details),
        verify: async () => ({ at: null, problem: null }),
        restore: async () => ({ at: null, problem: null }),
        discard: async () => {},
      },
    );
  });

  const app = () => docker.find("app")!;
  // The image of each container started, in order: an old one started after the new one is the old version on new data.
  const startsSeen = () => {
    const started: string[] = [];
    const start = docker.start.bind(docker);
    docker.start = async (reference) => {
      started.push(docker.find(reference)!.Image!);
      await start(reference);
    };
    return started;
  };

  const desired = `ghcr.io/example/app@sha256:${"a".repeat(64)}`;
  const rollout = () => ({
    id: "a1c09362-d48c-4b7f-a331-6d47c8a8dc96",
    targetReference: desired,
    expectedSourceContainerId: app().Id!,
    expectedPlatform: "linux/amd64",
    requireStateless: true as const,
  });
  const statelessRollout = () => {
    app().Mounts = [];
    app().HostConfig = { ...app().HostConfig, Binds: [] };
    app().Config.Volumes = {};
    docker.images.set(OLD_IMAGE, {
      Id: OLD_IMAGE,
      Config: { ...imageConfig, Volumes: {} },
      Os: "linux",
      Architecture: "amd64",
    });
    const pull = docker.pull.bind(docker);
    docker.pull = async (...args) => {
      await pull(...args);
      docker.images.set(NEW_IMAGE, {
        Id: NEW_IMAGE,
        Config: { ...imageConfig, Volumes: {} },
        Os: "linux",
        Architecture: "amd64",
        RepoDigests: [desired],
      });
    };
  };
  it("pins a reviewed digest even if the mutable tag drifts, and preserves that digest in the replacement", async () => {
    statelessRollout();
    docker.tags.set(REFERENCE, "sha256:unreviewed-tag");
    const result = await updater.update("app", true, undefined, { rollout: rollout() });
    expect(result.succeeded).toBe(true);
    expect(docker.calls).toContain(`pull ${desired}`);
    expect(docker.calls).not.toContain(`pull ${REFERENCE}`);
    expect(app().Config.Image).toBe(desired);
  });
  it("refuses writable data, changed source identity, wrong digest/platform, and target-declared volumes before stopping", async () => {
    const unsafe = await updater.update("app", true, undefined, { rollout: rollout() });
    expect(unsafe.succeeded).toBe(false);
    expect(docker.calls).toEqual([]);
    statelessRollout();
    expect(
      (
        await updater.update("app", true, undefined, {
          rollout: { ...rollout(), expectedSourceContainerId: "changed" },
        })
      ).succeeded,
    ).toBe(false);
    const pull = docker.pull.bind(docker);
    for (const change of [
      { RepoDigests: [] },
      { Architecture: "arm64" },
      { Config: { Volumes: { "/new-data": {} } } },
    ]) {
      docker.pull = async (...args) => {
        await pull(...args);
        docker.images.set(NEW_IMAGE, { ...docker.images.get(NEW_IMAGE)!, ...change });
      };
      expect((await updater.update("app", true, undefined, { rollout: rollout() })).succeeded).toBe(false);
      expect(docker.calls.some((call) => call.startsWith("stop "))).toBe(false);
    }
  });

  it("rechecks delegated authority after a pull and leaves the original untouched when it was revoked", async () => {
    let authorized = true;
    const pull = docker.pull.bind(docker);
    docker.pull = async (...args) => {
      await pull(...args);
      authorized = false;
    };
    const result = await updater.update("app", false, undefined, { authorize: async () => authorized });
    expect(result.succeeded).toBe(false);
    expect(result.outcome).toContain("delegated action");
    expect(docker.calls.filter((call) => /^(stop|start|rename|create|remove) /.test(call))).toEqual([]);
    expect(docker.find("app")?.State.Running).toBe(true);
  });

  it("does not start a new image with automatic undo when writable data has no checkpoint service", async () => {
    const withoutCheckpoints = new ContainerUpdater(
      docker,
      async (milliseconds) => {
        now += milliseconds;
      },
      () => now,
    );
    const result = await withoutCheckpoints.update("app", true);
    expect(result.succeeded).toBe(false);
    expect(docker.calls).not.toContain("create app");
    expect(app()).toMatchObject({ Image: OLD_IMAGE, State: { Running: true } });
  });

  it("preserves stateless automatic updates without a checkpoint service", async () => {
    app().Mounts = [];
    const stateless = new ContainerUpdater(
      docker,
      async (milliseconds) => {
        now += milliseconds;
      },
      () => now,
    );
    expect((await stateless.update("app", true)).succeeded).toBe(true);
  });

  it("requires a checkpoint for unattended updates even when automatic undo is not requested", async () => {
    const unattended = new ContainerUpdater(
      docker,
      async (milliseconds) => {
        now += milliseconds;
      },
      () => now,
    );
    expect((await unattended.update("app")).succeeded).toBe(false);
    expect(docker.calls).not.toContain("create app");
  });

  it.each(["checkpoints off", "over size limit", "no room", "copy failed"])(
    "aborts an automatic-undo update before replacement when %s",
    async (reason) => {
      const unsafe = new ContainerUpdater(
        docker,
        async (milliseconds) => {
          now += milliseconds;
        },
        () => now,
        {
          take: async (_name, details) => ({ ...completeCheckpoint(details, reason), complete: false }),
          verify: async () => ({ at: null, problem: reason }),
          restore: async () => {
            throw new Error("must not restore");
          },
          discard: async () => {},
        },
      );
      const result = await unsafe.update("app", true);
      expect(result.succeeded).toBe(false);
      expect(result.outcome).toContain(reason);
      expect(docker.calls).not.toContain("create app");
      expect(app()).toMatchObject({ Image: OLD_IMAGE, State: { Running: true } });
    },
  );

  it("a deliberate update without automatic undo reports missing data protection and refuses downgrade", async () => {
    const manual = new ContainerUpdater(
      docker,
      async (milliseconds) => {
        now += milliseconds;
      },
      () => now,
    );
    let schemaVersion = 1;
    docker.afterStart = () => {
      schemaVersion = 2;
      return { Status: "exited", Running: false, ExitCode: 1 };
    };
    const result = await manual.update("app", false, undefined, { allowWithoutCheckpoint: true });
    expect(result.outcome).toContain("Rolling back is blocked");
    expect(schemaVersion).toBe(2);
    const before = [...docker.calls];
    expect((await manual.rollBack("app")).outcome).toContain("Refused to roll back");
    expect(docker.calls).toEqual(before);
    expect(docker.find("app-autoheal-old")?.State.Running).toBe(false);
    expect(schemaVersion).toBe(2);
  });

  describe("on a host that cannot keep data yet (an SSH host without Autoheal's image)", () => {
    const withoutCopies = () =>
      new ContainerUpdater(
        docker,
        async (milliseconds) => {
          now += milliseconds;
        },
        () => now,
        null,
        undefined,
        JOB_OUTCOMES.checkpointUnavailable,
      );

    // A host that has a copy service, whose copy of this container's data does not complete: too much of it, or the
    // copy failed. What happened to a container on a real host — refused by hand, though the dialog said it would go.
    const INCOMPLETE = "more than this host keeps for one container";
    const withIncompleteCopies = () =>
      new ContainerUpdater(
        docker,
        async (milliseconds) => {
          now += milliseconds;
        },
        () => now,
        {
          take: async (_name, details) => ({ ...completeCheckpoint(details, INCOMPLETE), complete: false }),
          verify: async () => ({ at: null, problem: null }),
          restore: async () => ({ at: null, problem: null }),
          discard: async () => {},
        },
      );

    it("updates by hand one set to undo a failed update when its data cannot be copied, as it was told it would", async () => {
      const result = await withIncompleteCopies().update("app", true, undefined, { allowWithoutCheckpoint: true });
      expect(result.succeeded).toBe(true);
      expect(result.outcome).toContain(INCOMPLETE);
      expect(app()).toMatchObject({ Image: NEW_IMAGE, State: { Running: true } });
    });

    it("does not undo by hand one whose data it could not copy, when it starts badly: the old one waits aside", async () => {
      docker.afterStart = () => ({ Status: "exited", Running: false, ExitCode: 1 });
      await withIncompleteCopies().update("app", true, undefined, { allowWithoutCheckpoint: true });
      expect(docker.find("app-autoheal-old")).toMatchObject({ Image: OLD_IMAGE });
      expect(app()).toMatchObject({ Image: NEW_IMAGE });
    });

    it("still refuses an automatic update whose data it could not copy, before anything is put in place", async () => {
      const result = await withIncompleteCopies().update("app", true);
      expect(result.succeeded).toBe(false);
      expect(result.outcome).toContain(JOB_OUTCOMES.checkpointRequired);
      expect(app()).toMatchObject({ Image: OLD_IMAGE, State: { Running: true } });
    });

    // Its data too big to copy, as a model store or a media cache: its owner chose to update it anyway (2026-11-06).
    const restored: string[] = [];
    const withTooMuchData = () =>
      new ContainerUpdater(
        docker,
        async (milliseconds) => {
          now += milliseconds;
        },
        () => now,
        {
          take: async (_name, details) => ({
            ...completeCheckpoint(details, TOO_MUCH_DATA),
            complete: false,
            oversized: true,
          }),
          verify: async () => ({ at: null, problem: VOLUME_COPY_MESSAGES.incomplete }),
          restore: async (name) => {
            restored.push(name);
            return { at: null, problem: null };
          },
          discard: async () => {},
        },
      );

    it("goes ahead with an automatic update whose data is too big to copy, saying it was not kept", async () => {
      const result = await withTooMuchData().update("app", true);
      expect(result.succeeded).toBe(true);
      expect(result.outcome).toContain("2.0 GB limit");
      expect(app()).toMatchObject({ Image: NEW_IMAGE, State: { Running: true } });
    });

    it("keeps the old one stopped and aside when the new one then starts badly: it might not read what that wrote", async () => {
      docker.afterStart = () => ({ Status: "exited", Running: false, ExitCode: 1 });
      const started = startsSeen();
      restored.length = 0;
      const tooMuch = withTooMuchData();

      const result = await tooMuch.update("app", true);

      expect(started).toEqual([NEW_IMAGE]);
      expect(docker.find("app-autoheal-old")).toMatchObject({ Image: OLD_IMAGE, State: { Running: false } });
      expect(app()).toMatchObject({ Image: NEW_IMAGE });
      expect(result).toEqual({
        succeeded: false,
        outcome: `${JOB_OUTCOMES.startedBadly("app", "the new container stopped (exit 1)", "app-autoheal-old")}${TOO_MUCH_DATA}`,
      });
      // Nor does a roll back by hand put it back over that data.
      expect(await tooMuch.rollBack("app")).toEqual({
        succeeded: false,
        outcome: JOB_OUTCOMES.rollbackRefused("app", VOLUME_COPY_MESSAGES.incomplete),
      });
      expect(started).toEqual([NEW_IMAGE]);
      expect(restored).toEqual([]);
    });

    it("refuses an automatic update of a container with data before stopping anything, saying why", async () => {
      const result = await withoutCopies().update("app");
      expect(result).toEqual({
        succeeded: false,
        outcome: JOB_OUTCOMES.refusedWithoutCheckpoint("app", JOB_OUTCOMES.checkpointUnavailable),
      });
      expect(docker.calls.filter((call) => /^(stop|create|rename)/.test(call))).toEqual([]);
      expect(app()).toMatchObject({ Image: OLD_IMAGE, State: { Running: true } });
    });

    it("updates it by hand, saying its data was not kept and why, and refuses a downgrade for that reason", async () => {
      const updater = withoutCopies();
      const result = await updater.update("app", false, undefined, { allowWithoutCheckpoint: true });
      expect(result.succeeded).toBe(true);
      expect(result.outcome).toContain(JOB_OUTCOMES.checkpointSkipped(JOB_OUTCOMES.checkpointUnavailable));
      expect(app()).toMatchObject({ Image: NEW_IMAGE, State: { Running: true } });
    });

    it("still refuses an automatic update that would undo itself", async () => {
      const result = await withoutCopies().update("app", true);
      expect(result.outcome).toBe(JOB_OUTCOMES.refusedWithoutCheckpoint("app", JOB_OUTCOMES.checkpointUnavailable));
      expect(app()).toMatchObject({ Image: OLD_IMAGE, State: { Running: true } });
    });

    it("updates by hand one set to undo a failed update, saying its data was not kept", async () => {
      const result = await withoutCopies().update("app", true, undefined, { allowWithoutCheckpoint: true });
      expect(result.succeeded).toBe(true);
      expect(result.outcome).toContain(JOB_OUTCOMES.checkpointSkipped(JOB_OUTCOMES.checkpointUnavailable));
      expect(app()).toMatchObject({ Image: NEW_IMAGE, State: { Running: true } });
    });

    it("does not undo by hand one that starts badly: the old one waits aside", async () => {
      docker.afterStart = () => ({ Status: "exited", Running: false, ExitCode: 1 });
      await withoutCopies().update("app", true, undefined, { allowWithoutCheckpoint: true });
      expect(docker.find("app-autoheal-old")).toMatchObject({ Image: OLD_IMAGE });
      expect(app()).toMatchObject({ Image: NEW_IMAGE });
    });

    it("keeps the old one aside when the new one starts badly, but will not put it back on data it never kept", async () => {
      docker.afterStart = () => ({ Status: "exited", Running: false, ExitCode: 1 });
      const updater = withoutCopies();
      await updater.update("app", false, undefined, { allowWithoutCheckpoint: true });
      expect(docker.find("app-autoheal-old")).toMatchObject({ Image: OLD_IMAGE });
      expect((await updater.rollBack("app")).outcome).toBe(
        JOB_OUTCOMES.rollbackRefused("app", JOB_OUTCOMES.checkpointUnavailable),
      );
      expect(app()).toMatchObject({ Image: NEW_IMAGE });
    });

    it("updates a container without data automatically, and rolls back one that started badly", async () => {
      app().Mounts = [];
      expect(await withoutCopies().update("app")).toMatchObject({ succeeded: true });
      expect(app()).toMatchObject({ Image: NEW_IMAGE });

      docker.add(appContainer({ Id: "0".repeat(64), Name: "/other", Mounts: [] }));
      docker.afterStart = () => ({ Status: "exited", Running: false, ExitCode: 1 });
      const updater = withoutCopies();
      expect((await updater.update("other")).succeeded).toBe(false);
      expect(await updater.rollBack("other")).toMatchObject({
        succeeded: true,
        outcome: JOB_OUTCOMES.rolledBack("other"),
      });
      expect(docker.find("other")).toMatchObject({ Image: OLD_IMAGE, State: { Running: true } });
    });
  });

  it("restores the previous data schema before starting the old image during automatic undo", async () => {
    let schemaVersion = 1;
    let snapshot = 0;
    const start = docker.start.bind(docker);
    docker.start = async (reference) => {
      if (docker.find(reference)?.Image === OLD_IMAGE) {
        expect(schemaVersion).toBe(1);
      }
      return start(reference);
    };
    docker.afterStart = () => {
      schemaVersion = 2;
      return { Status: "exited", Running: false, ExitCode: 1 };
    };
    const safe = new ContainerUpdater(
      docker,
      async (milliseconds) => {
        now += milliseconds;
      },
      () => now,
      {
        take: async (_name, details) => {
          snapshot = schemaVersion;
          return completeCheckpoint(details);
        },
        verify: async () => ({ at: 1_000, problem: null }),
        restore: async () => {
          schemaVersion = snapshot;
          return { at: 1_000, problem: null };
        },
        discard: async () => {},
      },
    );
    expect((await safe.update("app", true)).succeeded).toBe(false);
    expect(app()).toMatchObject({ Image: OLD_IMAGE, State: { Running: true } });
    expect(schemaVersion).toBe(1);
  });

  it("refuses automatic undo when a checkpoint disappears after the new image migrates data", async () => {
    let migrated = false;
    docker.afterStart = () => {
      migrated = true;
      return { Status: "exited", Running: false, ExitCode: 1 };
    };
    const safe = new ContainerUpdater(
      docker,
      async (milliseconds) => {
        now += milliseconds;
      },
      () => now,
      {
        take: async (_name, details) => completeCheckpoint(details),
        verify: async () => ({ at: 1_000, problem: migrated ? "checkpoint deleted" : null }),
        restore: async () => {
          throw new Error("must not restore");
        },
        discard: async () => {},
      },
    );
    const result = await safe.update("app", true);
    expect(result.outcome).toContain("Refused to roll back");
    expect(docker.find("app-autoheal-old")?.State.Running).toBe(false);
    expect(app().Image).toBe(NEW_IMAGE);
    expect(docker.calls).not.toContain("remove /app");
  });

  describe("when Docker's answer to the new container's start is lost", () => {
    const COPIED_AT = Date.UTC(2026, 10, 11, 3, 12);
    const LOST = "socket hang up";
    const unconfirmed = VERIFY_PROBLEMS.startUnconfirmed(LOST);
    // The data's schema: the new version moves it on to 2 as it starts, and only putting the copy back undoes that.
    let schema: number;
    let copied: number;
    let seenByOriginal: number[];
    let discarded: string[];
    let originalId: string;

    beforeEach(() => {
      schema = 1;
      seenByOriginal = [];
      discarded = [];
      originalId = app().Id!;
      docker.afterStart = () => {
        schema = 2;
        return { Status: "running", Running: true };
      };
      const start = docker.start.bind(docker);
      docker.start = async (reference) => {
        const starting = docker.find(reference)!;
        if (starting.Id === originalId) seenByOriginal.push(schema);
        await start(reference);
        if (starting.Id !== originalId) throw new Error(LOST);
      };
    });

    // A copy that can go missing once the new version runs, or fail on its way back.
    const keeping = (copy: { missing?: boolean; restore?: () => RestoredData } = {}) =>
      new ContainerUpdater(
        docker,
        async (milliseconds) => {
          now += milliseconds;
        },
        () => now,
        {
          take: async (_name, details) => {
            copied = schema;
            return completeCheckpoint(details);
          },
          verify: async () => ({
            at: COPIED_AT,
            problem: copy.missing === true && schema === 2 ? "the copy is gone" : null,
          }),
          restore: async () => {
            if (copy.restore !== undefined) return copy.restore();
            schema = copied;
            return { at: COPIED_AT, problem: null };
          },
          discard: async (name) => void discarded.push(name),
        },
      );

    it("undoes an automatic update through the roll back, so the old version starts only on the data as it was", async () => {
      const result = await keeping().update("app", true);
      expect(result.succeeded).toBe(false);
      expect(result.outcome).toBe(
        `${JOB_OUTCOMES.undone("app", unconfirmed)} ${JOB_OUTCOMES.rolledBackWithData("app", "2026-11-11 03:12 UTC")}`,
      );
      expect(seenByOriginal).toEqual([1]);
      expect(app()).toMatchObject({ Id: originalId, State: { Running: true } });
      expect(docker.find("app-autoheal-old")).toBeUndefined();
      expect(docker.calls).not.toContain("remove /app");
      expect(discarded).toEqual(["app"]);
    });

    it("keeps the old one stopped and aside with its copy when a person updates it, until they roll back", async () => {
      const updater = keeping();
      expect(await updater.update("app")).toEqual({
        succeeded: false,
        outcome: JOB_OUTCOMES.startedBadly("app", unconfirmed, "app-autoheal-old"),
      });
      expect(docker.find("app-autoheal-old")).toMatchObject({ Id: originalId, State: { Running: false } });
      expect(app()).toMatchObject({ Image: NEW_IMAGE });
      expect(discarded).toEqual([]);
      expect(seenByOriginal).toEqual([]);

      expect((await updater.rollBack("app")).succeeded).toBe(true);
      expect(seenByOriginal).toEqual([1]);
    });

    it("refuses the undo when the copy is gone, and the old version never starts on the new data", async () => {
      const result = await keeping({ missing: true }).update("app", true);
      expect(result.outcome).toContain(JOB_OUTCOMES.rollbackRefused("app", "the copy is gone"));
      expect(seenByOriginal).toEqual([]);
      expect(docker.find("app-autoheal-old")).toMatchObject({ Id: originalId, State: { Running: false } });
      expect(app()).toMatchObject({ Image: NEW_IMAGE });
      expect(discarded).toEqual([]);
    });

    it.each<[string, () => RestoredData]>([
      ["stops partway", () => ({ at: COPIED_AT, problem: "no space left on device" })],
      [
        "is cut off",
        () => {
          throw new Error("the runner stopped");
        },
      ],
    ])(
      "keeps the old version stopped when putting its data back %s, until a rebuilt runner finishes",
      async (_how, restore) => {
        await keeping({ restore }).update("app", true);
        expect(seenByOriginal).toEqual([]);
        expect(app()).toMatchObject({ Id: originalId, State: { Running: false } });
        expect(discarded).toEqual([]);

        docker.calls.length = 0;
        expect((await keeping().rollBack("app")).succeeded).toBe(true);
        expect(seenByOriginal).toEqual([1]);
        expect(docker.calls.filter((call) => call === "start /app")).toHaveLength(1);
        expect(discarded).toEqual(["app"]);
      },
    );

    it("still puts the old one back at once when something fails before the start is asked for", async () => {
      docker.connect = async () => {
        throw new Error("network proxy not found");
      };
      const result = await keeping().update("app", true);
      expect(result.outcome).toBe(JOB_OUTCOMES.restoredAfterFailure("app", "network proxy not found"));
      expect(docker.calls.filter((call) => call.startsWith("start "))).toHaveLength(1);
      expect(seenByOriginal).toEqual([1]);
      expect(app()).toMatchObject({ Id: originalId, State: { Running: true } });
      expect(discarded).toEqual(["app"]);
    });

    it("undoes a stateless update the same way, with no data to put back", async () => {
      app().Mounts = [];
      const stateless = new ContainerUpdater(
        docker,
        async (milliseconds) => {
          now += milliseconds;
        },
        () => now,
      );
      const result = await stateless.update("app", true);
      expect(result.outcome).toBe(`${JOB_OUTCOMES.undone("app", unconfirmed)} ${JOB_OUTCOMES.rolledBack("app")}`);
      expect(app()).toMatchObject({ Id: originalId, State: { Running: true } });
      expect(docker.find("app-autoheal-old")).toBeUndefined();
    });

    it("still puts the old one back at once for a recreate, which runs the image the old one does", async () => {
      expect(await keeping().recreate("app")).toEqual({
        succeeded: false,
        outcome: RECREATE_OUTCOMES.restoredAfterFailure("app", LOST),
      });
      expect(seenByOriginal).toEqual([1]);
      expect(app()).toMatchObject({ Id: originalId, State: { Running: true } });
      expect(docker.containers.size).toBe(1);
    });
  });

  describe("an update a person said yes to, by its image's digest", () => {
    const YES = `sha256:${"a".repeat(64)}`;

    it("goes ahead to the image the yes was for", async () => {
      docker.pulledDigests = [`ghcr.io/example/app@${YES}`];

      expect((await updater.update("app", false, undefined, { expectedDigest: YES })).succeeded).toBe(true);
      expect(app()).toMatchObject({ Image: NEW_IMAGE });
    });

    it("stops nothing when the tag moved to another image since the yes", async () => {
      docker.pulledDigests = [`ghcr.io/example/app@sha256:${"b".repeat(64)}`];

      const result = await updater.update("app", false, undefined, { expectedDigest: YES });

      expect(result).toEqual({ succeeded: false, outcome: JOB_OUTCOMES.notTheApprovedImage("app", REFERENCE) });
      expect(docker.calls.filter((call) => /^(stop|rename|create) /.test(call))).toEqual([]);
      expect(app()).toMatchObject({ Image: OLD_IMAGE, State: { Running: true } });
    });
  });

  it("pulls, recreates with the same settings and networks, checks it runs, then removes the old one", async () => {
    const result = await updater.update("app");
    expect(result).toEqual({
      succeeded: true,
      outcome: `Updated app to the newest ${REFERENCE}, and it is running. The image it ran before is kept as ${KEPT}.`,
    });
    expect(docker.calls).toEqual([
      `pull ${REFERENCE}`,
      "stop /app",
      "rename /app app-autoheal-old",
      "create app",
      "start /app",
      "remove /app-autoheal-old",
      `tag ${OLD_IMAGE} ${KEPT}`,
    ]);
    expect(app().Image).toBe(NEW_IMAGE);
    expect(docker.connected.map(([network, container]) => [network, container])).toEqual([["proxy", app().Id]]);
    expect(docker.containers.size).toBe(1);
    expect(docker.tags.get(KEPT)).toBe(OLD_IMAGE);
  });

  it("keeps only the last image it replaced, unless a container still runs an older one", async () => {
    const older = `sha256:${"0".repeat(64)}`;
    docker.images.set(older, { Id: older });
    docker.tags.set(KEPT, older);
    await updater.update("app");
    expect(docker.calls.at(-1)).toBe(`remove image ${older}`);
    expect(docker.images.has(older)).toBe(false);
    expect(docker.tags.get(KEPT)).toBe(OLD_IMAGE);

    // Updated again, while a container someone started from the kept image still runs it.
    docker.add({ ...appContainer(), Id: "f".repeat(64), Name: "/app-by-hand", Image: OLD_IMAGE });
    docker.pulledImage = `sha256:${"3".repeat(64)}`;
    expect(await updater.update("app")).toMatchObject({ succeeded: true });
    expect(docker.images.has(OLD_IMAGE)).toBe(true);
    expect(docker.tags.get(KEPT)).toBe(NEW_IMAGE);
  });

  it("changes a container's own settings by recreating it on the image it runs, the old one gone once it runs", async () => {
    const settings = settingsOf(appContainer(), imageConfig);
    expect(settings).toEqual({
      environment: [{ name: "TZ", value: "Europe/Lisbon" }],
      labels: [
        { name: "com.docker.compose.project", value: "app" },
        { name: "autoheal.update", value: "ask" },
      ],
      ports: [{ target: 8080, protocol: "tcp", published: 8080, address: "" }],
      mounts: [
        { kind: "bind", source: "/srv/app/config", target: "/config", readOnly: false },
        { kind: "volume", source: ANONYMOUS, target: "/data", readOnly: false },
      ],
      restart: { policy: "unless-stopped", retries: 0 },
    });

    const result = await updater.edit("app", {
      ...settings,
      environment: [
        { name: "TZ", value: "UTC" },
        { name: "DEBUG", value: "1" },
      ],
      ports: [{ target: 8080, protocol: "tcp", published: 8081, address: "127.0.0.1" }],
      mounts: [...settings.mounts, { kind: "bind", source: "/srv/app/media", target: "/media", readOnly: true }],
      restart: { policy: "on-failure", retries: 5 },
    });
    expect(result).toEqual({ succeeded: true, outcome: "Changed the settings of app, and it is running." });
    expect(docker.calls).toEqual([
      "stop /app",
      "rename /app app-autoheal-old",
      "create app",
      "start /app",
      "remove /app-autoheal-old",
    ]);
    const [created] = docker.created as { Env: string[]; Image: string; HostConfig: Record<string, unknown> }[];
    expect(created!.Image).toBe(REFERENCE);
    expect(created!.Env).toEqual(["TZ=UTC", "DEBUG=1"]);
    expect(created!.HostConfig).toMatchObject({
      PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "8081" }] },
      Binds: ["/srv/app/config:/config", `${ANONYMOUS}:/data`, "/srv/app/media:/media:ro"],
      Mounts: [],
      RestartPolicy: { Name: "on-failure", MaximumRetryCount: 5 },
      NetworkMode: "app_default",
    });
    expect(app().Image).toBe(OLD_IMAGE);
  });

  it("refuses a new mount of the host's own paths, and an edit that would be an update too", async () => {
    const settings = settingsOf(appContainer(), imageConfig);
    for (const source of ["/", "/etc", "/etc/cron.d", "/var/run/docker.sock", "/var/lib/docker/volumes"]) {
      const mounts = [...settings.mounts, { kind: "bind" as const, source, target: "/host", readOnly: true }];
      expect((await updater.edit("app", { ...settings, mounts })).outcome).toBe(
        `Refused: ${source} is the host's own (its system or Docker's socket); it can't be mounted into a container from here.`,
      );
    }
    docker.tags.set(REFERENCE, NEW_IMAGE);
    docker.images.set(NEW_IMAGE, { Id: NEW_IMAGE, Config: imageConfig });
    expect((await updater.edit("app", settings)).outcome).toBe(
      `Refused: ${REFERENCE} now names a newer image than app runs, and recreating it would update it too. Update it first.`,
    );
    expect(docker.calls).toEqual([]);
  });

  it("updates a stopped container, leaves it stopped, and says so", async () => {
    docker.containers.clear();
    docker.add(appContainer({ State: { Status: "exited", Running: false, ExitCode: 0 } }));
    const result = await updater.update("app");
    expect(result).toEqual({
      succeeded: true,
      outcome: `Updated app to the newest ${REFERENCE}; it stays stopped, as it was. The image it ran before is kept as ${KEPT}.`,
    });
    expect(docker.calls).not.toContain("start /app");
  });

  it("edits a stopped container and leaves it stopped", async () => {
    docker.containers.clear();
    docker.add(appContainer({ State: { Status: "exited", Running: false, ExitCode: 1 } }));
    const result = await updater.edit("app", settingsOf(appContainer(), imageConfig));
    expect(result).toEqual({ succeeded: true, outcome: "Changed the settings of app; it stays stopped, as it was." });
    expect(docker.calls).not.toContain("start /app");
  });

  it("waits for a health check to pass", async () => {
    let looks = 0;
    docker.afterStart = () => ({ Status: "running", Running: true, Health: { Status: "starting" } });
    const health = docker.inspect.bind(docker);
    docker.inspect = async (reference) => {
      const container = await health(reference);
      looks += 1;
      return looks > 3 && container !== null
        ? { ...container, State: { ...container.State, Health: { Status: "healthy" } } }
        : container;
    };
    expect(await updater.update("app")).toMatchObject({ succeeded: true, outcome: expect.stringContaining("healthy") });
  });

  it("counts the new container healthy once its own health check passes, not after Docker's first one", async () => {
    docker.containers.clear();
    const healthcheck = { Test: ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:8080"], Interval: 30e9 };
    docker.add(appContainer({ Config: { ...appContainer().Config, Healthcheck: healthcheck } }));
    docker.afterStart = () => ({ Status: "running", Running: true, Health: { Status: "starting" } });
    docker.probePasses = true;

    expect(await updater.update("app")).toMatchObject({ succeeded: true, outcome: expect.stringContaining("healthy") });
    expect(docker.probed).toEqual([["/bin/sh", "-c", "wget -q -O /dev/null http://127.0.0.1:8080"]]);
  });

  it("keeps waiting while the health check it runs early still fails", async () => {
    docker.containers.clear();
    docker.add(appContainer({ Config: { ...appContainer().Config, Healthcheck: { Test: ["CMD", "/healthcheck"] } } }));
    docker.afterStart = () => ({ Status: "running", Running: true, Health: { Status: "starting" } });

    expect(await updater.update("app")).toMatchObject({ succeeded: false });
    expect(docker.probed.length).toBeGreaterThan(1);
    expect(docker.probed[0]).toEqual(["/healthcheck"]);
  });

  it("does nothing when the newest image is the one it runs", async () => {
    docker.pulledImage = OLD_IMAGE;
    expect(await updater.update("app")).toEqual({
      succeeded: true,
      outcome: "app already runs the newest image behind its tag.",
    });
    expect(docker.calls).toEqual([`pull ${REFERENCE}`]);
  });

  it("says so to the update check, whose offer was wrong, when the newest image is the one it runs", async () => {
    const confirmed: [string, string][] = [];
    const telling = new ContainerUpdater(
      docker,
      async () => undefined,
      () => 0,
      undefined,
      undefined,
      undefined,
      (imageId, reference) => confirmed.push([imageId, reference]),
    );
    docker.pulledImage = OLD_IMAGE;
    await telling.update("app");
    expect(confirmed).toEqual([[OLD_IMAGE, REFERENCE]]);
  });

  it("fails, and leaves the update check's offer standing, when the image it pulled cannot be read", async () => {
    const confirmed: [string, string][] = [];
    const telling = new ContainerUpdater(
      docker,
      async () => undefined,
      () => 0,
      undefined,
      undefined,
      undefined,
      (imageId, reference) => confirmed.push([imageId, reference]),
    );
    docker.prunedAfterPull = true;
    expect(await telling.update("app")).toEqual({
      succeeded: false,
      outcome: `Could not pull ${REFERENCE}: the image was not there after the pull`,
    });
    expect(confirmed).toEqual([]);
    expect(docker.calls).toEqual([`pull ${REFERENCE}`]);
    expect(app()).toMatchObject({ Image: OLD_IMAGE, State: { Running: true } });
  });

  it("refuses containers labelled off, or pinned to a digest", async () => {
    const labelled = appContainer();
    labelled.Config.Labels = { "autoheal.update": "off" };
    docker.containers.clear();
    docker.add(labelled);
    expect((await updater.update("app")).outcome).toBe("Refused: app is labelled autoheal.update=off.");

    docker.containers.clear();
    docker.add(appContainer({ Config: { ...appContainer().Config, Image: `ghcr.io/example/app@${NEW_IMAGE}` } }));
    expect((await updater.update("app")).outcome).toContain("without a tag to follow");

    expect(docker.calls).toEqual([]);
  });

  it("refuses, before pulling, when Docker no longer has the image the container runs", async () => {
    // As Docker's containerd image store does once a build on the host takes the tag.
    docker.images.delete(OLD_IMAGE);
    docker.tags.delete(REFERENCE);
    expect(await updater.update("app")).toEqual({
      succeeded: false,
      outcome:
        "Refused: Docker here no longer has the image app runs (an image built here took over its tag), so what that image set can't be told from what you set. Recreate app the way you deployed it, for example docker compose up -d.",
    });
    expect(docker.calls).toEqual([]);
    expect(app().Image).toBe(OLD_IMAGE);
  });

  it("puts the old container back when the new one cannot even be created", async () => {
    docker.failCreate = true;
    const result = await updater.update("app");
    expect(result.succeeded).toBe(false);
    expect(result.outcome).toContain("The old container is back as it was.");
    expect(app().Image).toBe(OLD_IMAGE);
    expect(app().State.Running).toBe(true);
    expect(docker.containers.size).toBe(1);
  });

  describe("when Docker makes the new container but the first look at it fails", () => {
    const LOOK_FAILED = "connection reset by peer";
    // What a dropped connection or a busy engine does: the container is there, under the name, and unseen.
    const lookFailsOnce = () => {
      const create = docker.create.bind(docker);
      const inspect = docker.inspect.bind(docker);
      let fresh: string | null = null;
      docker.create = async (name, specification) => {
        fresh = await create(name, specification);
        return fresh;
      };
      docker.inspect = async (reference) => {
        if (reference !== fresh) return inspect(reference);
        fresh = null;
        throw new Error(LOOK_FAILED);
      };
    };

    it.each([
      ["by hand", false],
      ["with automatic undo", true],
    ])("puts the old container back under its own name, updated %s, with no new one left", async (_how, undo) => {
      lookFailsOnce();
      const originalId = app().Id!;

      const result = await updater.update("app", undo);

      expect(result.outcome).toBe(JOB_OUTCOMES.restoredAfterFailure("app", LOOK_FAILED));
      expect(app()).toMatchObject({ Id: originalId, Image: OLD_IMAGE, State: { Running: true } });
      expect(docker.containers.size).toBe(1);
    });

    it("leaves an old container that was stopped as it was, with no new one left", async () => {
      docker.containers.clear();
      docker.add(appContainer({ State: { Status: "exited", Running: false, ExitCode: 0 } }));
      lookFailsOnce();
      const originalId = app().Id!;

      await updater.update("app");

      expect(app()).toMatchObject({ Id: originalId, State: { Running: false } });
      expect(docker.containers.size).toBe(1);
    });
  });

  it("starts the old container again, under its own name, when parking it fails", async () => {
    // Taken behind the listing's back, so only the rename finds out.
    docker.add({ ...appContainer(), Id: "e".repeat(64), Name: "/app-autoheal-old", State: { Running: false } });
    const result = await updater.update("app");
    expect(result.outcome).toContain("The old container is back as it was.");
    expect(app().Image).toBe(OLD_IMAGE);
    expect(app().State.Running).toBe(true);
    expect(docker.calls.filter((call) => call.startsWith("rename"))).toEqual(["rename /app app-autoheal-old"]);
  });

  it("refuses to update while the container an earlier update kept aside is still there", async () => {
    docker.summaries = [
      { Id: "e".repeat(64), Names: ["/app-autoheal-old"], State: "exited", Status: "Exited (0)", HostConfig: {} },
    ];
    expect((await updater.update("app")).outcome).toBe(
      "Refused: app-autoheal-old, kept aside by an earlier update of app, is still there. Roll back to it, or remove it, first.",
    );
    expect(docker.calls).toEqual([]);
  });

  it("keeps the old container aside when the new one starts and fails, for a person to roll back", async () => {
    docker.afterStart = () => ({ Status: "exited", Running: false, ExitCode: 1 });
    const result = await updater.update("app");
    expect(result.succeeded).toBe(false);
    expect(result.outcome).toContain("the new container stopped (exit 1)");
    expect(docker.find("app-autoheal-old")?.Image).toBe(OLD_IMAGE);

    expect(await updater.rollBack("app")).toEqual({
      succeeded: true,
      outcome: "Rolled app back to the container it ran before the update.",
    });
    expect(app().Image).toBe(OLD_IMAGE);
    expect(app().State.Running).toBe(true);
    expect(docker.containers.size).toBe(1);
    expect((await updater.rollBack("app")).outcome).toBe("There is no app-autoheal-old to roll back to.");
  });

  it.each([undefined, 0, 37])(
    "gracefully stops a rollback replacement with grace %s before non-forced removal",
    async (grace) => {
      docker.afterStart = () => ({ Status: "exited", Running: false, ExitCode: 1 });
      await updater.update("app");
      app().State = { Status: "running", Running: true };
      app().Config.StopTimeout = grace;
      const stop = docker.stop.bind(docker);
      const timeouts: number[] = [];
      docker.stop = async (reference: string, timeout?: number) => {
        timeouts.push(timeout!);
        await stop(reference);
      };
      docker.calls.length = 0;
      expect((await updater.rollBack("app")).succeeded).toBe(true);
      expect(docker.calls.slice(0, 3)).toEqual(["stop /app", "removeStopped /app", "rename /app-autoheal-old app"]);
      expect(timeouts).toEqual([grace ?? 10]);
    },
  );

  it("retains the replacement and recovery artifacts when rollback stopping fails", async () => {
    docker.afterStart = () => ({ Status: "exited", Running: false, ExitCode: 1 });
    await updater.update("app");
    app().State = { Status: "running", Running: true };
    docker.failStops.add("/app");
    docker.calls.length = 0;
    const result = await updater.rollBack("app");
    expect(result.succeeded).toBe(false);
    expect(docker.calls).toEqual(["stop /app"]);
    expect(docker.find("app-autoheal-old")).toBeDefined();
    expect(app().Image).toBe(NEW_IMAGE);
  });

  it.each(["still running", "killed"])("does not remove or restore if shutdown is %s", async (state) => {
    docker.afterStart = () => ({ Status: "exited", Running: false, ExitCode: 1 });
    await updater.update("app");
    app().State = { Running: true, Status: "running" };
    docker.stop = async () => {
      if (state === "killed") app().State = { Running: false, Status: "exited", ExitCode: 137 };
    };
    docker.calls.length = 0;
    expect((await updater.rollBack("app")).succeeded).toBe(false);
    expect(docker.calls).toEqual([]);
    expect(docker.find("app-autoheal-old")).toBeDefined();
    expect(app().Image).toBe(NEW_IMAGE);
  });

  it("refuses rollback while another running container can write the restored data", async () => {
    docker.afterStart = () => ({ Status: "exited", Running: false, ExitCode: 1 });
    await updater.update("app");
    const writer = appContainer({ Id: "writer-id", Name: "/writer" });
    docker.add(writer);
    docker.summaries.push({ Id: "writer-id", Names: ["/writer"], State: "running", Status: "Up" });
    docker.calls.length = 0;
    const result = await updater.rollBack("app");
    expect(result.succeeded).toBe(false);
    expect(result.outcome).toContain("writer can still write restored data");
    expect(docker.calls).toEqual([]);
    expect(docker.find("app-autoheal-old")).toBeDefined();
  });

  it("waits for a SIGTERM flush marker before removing the replacement and restoring data", async () => {
    docker.afterStart = () => ({ Running: false, Status: "exited", ExitCode: 1 });
    await updater.update("app");
    const directory = mkdtempSync(join(tmpdir(), "autoheal-rollback-flush-"));
    const marker = join(directory, "flushed");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      const fs = require("node:fs");
      process.on("SIGTERM", () => { fs.writeFileSync(process.argv[1], "flushed"); process.exit(0); });
      process.stdout.write("ready");
      setInterval(() => {}, 1000);
    `,
        marker,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = once(child, "exit");
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    try {
      await Promise.race([
        once(child.stdout!, "data", { signal: AbortSignal.timeout(3000) }),
        exited.then(() => {
          throw new Error(`Signal fixture exited before readiness: ${stderr}`);
        }),
      ]);
      app().State = { Running: true, Status: "running" };
      docker.stop = async (id) => {
        child.kill("SIGTERM");
        expect((await exited)[0]).toBe(0);
        docker.find(id)!.State = { Running: false, Status: "exited", ExitCode: 0 };
      };
      const remove = docker.removeStopped.bind(docker);
      docker.removeStopped = async (id) => {
        expect(readFileSync(marker, "utf8")).toBe("flushed");
        await remove(id);
      };
      const recovery = new ContainerUpdater(
        docker,
        async () => {},
        () => now,
        {
          take: async (_name, details) => completeCheckpoint(details),
          verify: async () => ({ at: null, problem: null }),
          restore: async () => {
            expect(readFileSync(marker, "utf8")).toBe("flushed");
            expect(child.exitCode).toBe(0);
            return { at: null, problem: null };
          },
          discard: async () => {},
        },
      );
      expect((await recovery.rollBack("app")).succeeded).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // What the dashboard shows under the row as it goes: each step, and Docker's own lines while it pulls.
  const watched = () => {
    const seen: string[] = [];
    const steps: UpdateSteps = {
      enter: (phase) => seen.push(phase),
      pulled: (line) => seen.push(`${line.id} ${line.status}`),
    };
    return { seen, steps };
  };

  it("tells each step of an update as it goes, Docker's pull lines among them", async () => {
    const { seen, steps } = watched();
    await updater.update("app", false, steps);
    expect(seen).toEqual([
      "pulling",
      "4f4fb700ef54 Downloading",
      "stopping",
      "keeping_data",
      "starting",
      "checking",
      "finishing",
    ]);
  });

  it("tells when an update is undone", async () => {
    docker.afterStart = () => ({ Status: "exited", Running: false, ExitCode: 1 });
    const { seen, steps } = watched();
    await updater.update("app", true, steps);
    expect(seen.slice(-2)).toEqual(["checking", "undoing"]);
  });

  it("undoes a new container that does not come back at once, when told to, so the old one runs again", async () => {
    docker.afterStart = () => ({ Status: "exited", Running: false, ExitCode: 1 });
    docker.logged = "app 2.1.0: missing setting APP_MODE";
    expect(await updater.update("app", true)).toEqual({
      succeeded: false,
      outcome:
        "Updated app, but the new container stopped (exit 1); automatic undo was requested. " +
        "Rolled app back to the container it ran before the update.",
      output: "app 2.1.0: missing setting APP_MODE",
    });
    expect(app()).toMatchObject({ Image: OLD_IMAGE, State: { Running: true } });
    expect(docker.containers.size).toBe(1);
  });

  it("recreates a failed container from the image it runs, starts it, and removes the old one", async () => {
    docker.containers.clear();
    docker.add(appContainer({ State: { Status: "exited", Running: false, ExitCode: 1 } }));
    expect(await updater.recreate("app")).toEqual({
      succeeded: true,
      outcome: "Recreated app from its image, and it is running.",
    });
    expect(docker.calls).toEqual([
      "rename /app app-autoheal-old",
      "create app",
      "start /app",
      "remove /app-autoheal-old",
    ]);
    expect(app()).toMatchObject({ Image: OLD_IMAGE, State: { Running: true } });
    expect(docker.containers.size).toBe(1);
  });

  it("refuses to recreate a container whose tag has moved on: that would update it too", async () => {
    docker.tags.set(REFERENCE, NEW_IMAGE);
    docker.images.set(NEW_IMAGE, { Id: NEW_IMAGE, Config: imageConfig });
    expect(await updater.recreate("app")).toEqual({
      succeeded: false,
      outcome: `Refused: ${REFERENCE} now names a newer image than app runs, and recreating it would update it too.`,
    });
    expect(docker.calls).toEqual([]);
  });

  it("never starts a recreated container on an image its tag was moved to while the old one was set aside", async () => {
    const rename = docker.rename.bind(docker);
    docker.rename = async (reference, newName) => {
      docker.images.set(NEW_IMAGE, { Id: NEW_IMAGE, Config: imageConfig });
      docker.tags.set(REFERENCE, NEW_IMAGE);
      return rename(reference, newName);
    };
    const result = await updater.recreate("app");
    // A recreate keeps no copy, so what Docker may have put in its volume cannot be undone: it waits for a person.
    expect(app()).toMatchObject({ Image: OLD_IMAGE, State: { Running: false } });
    expect(docker.calls.filter((call) => call.startsWith("start "))).toEqual([]);
    expect(docker.containers.size).toBe(1);
    expect(result).toEqual({
      succeeded: false,
      outcome: RECREATE_OUTCOMES.restoredStopped("app", JOB_OUTCOMES.tagMovedMeanwhile(REFERENCE)),
    });
  });

  it("updates a stopped container and leaves it stopped", async () => {
    docker.containers.clear();
    docker.add(appContainer({ State: { Status: "exited", Running: false, ExitCode: 0 } }));
    expect((await updater.update("app")).succeeded).toBe(true);
    expect(app()).toMatchObject({ Image: NEW_IMAGE, State: { Running: false } });
    expect(docker.calls).not.toContain("stop /app");
  });

  it("says why when the pull fails, and changes nothing", async () => {
    docker.failPull = true;
    expect((await updater.update("app")).outcome).toBe(`Could not pull ${REFERENCE}: manifest unknown`);
    expect(app().Image).toBe(OLD_IMAGE);
  });

  describe("keeping its data", () => {
    const KEPT_AT = Date.UTC(2026, 9, 24, 3, 12);
    const kept = " Its data (1 mount, 38 MB) was kept first: rolling back restores it.";
    // Each step lands in the same list as Docker's calls, so the order shows.
    const checkpointsDoing = (restored: RestoredData) =>
      new ContainerUpdater(
        docker,
        async (milliseconds) => {
          now += milliseconds;
        },
        () => now,
        {
          take: async (name, details) => {
            docker.calls.push(`keep ${name}'s data`);
            return completeCheckpoint(details, kept);
          },
          verify: async () => ({ at: KEPT_AT, problem: null }),
          restore: async (name) => {
            docker.calls.push(`restore ${name}'s data`);
            return restored;
          },
          discard: async (name) => void docker.calls.push(`discard ${name}'s data`),
        },
      );

    it("keeps it once the old container stops and before the new one is made, and lets it go once the update holds", async () => {
      const updated = await checkpointsDoing({ at: KEPT_AT, problem: null }).update("app");
      expect(updated.outcome).not.toContain("Its data");
      expect(docker.calls).toEqual([
        `pull ${REFERENCE}`,
        "stop /app",
        "keep app's data",
        "rename /app app-autoheal-old",
        "create app",
        "start /app",
        "remove /app-autoheal-old",
        "discard app's data",
        `tag ${OLD_IMAGE} ${KEPT}`,
      ]);
    });

    describe("when the tag moved to another image before Docker made the new container", () => {
      const UNCHECKED = `sha256:${"f".repeat(64)}`;
      // Another pull of the same tag while the old container is set aside: Docker makes the new one with its volumes.
      beforeEach(() => {
        const rename = docker.rename.bind(docker);
        docker.rename = async (reference, newName) => {
          docker.images.set(UNCHECKED, { Id: UNCHECKED, Config: {} });
          docker.tags.set(REFERENCE, UNCHECKED);
          return rename(reference, newName);
        };
      });

      it("puts back the data kept first, as an empty volume may now hold that image's files, then the old one", async () => {
        const result = await checkpointsDoing({ at: KEPT_AT, problem: null }).update("app");

        expect(result.outcome).toBe(
          JOB_OUTCOMES.restoredAfterFailure("app", JOB_OUTCOMES.tagMovedMeanwhile(REFERENCE)),
        );
        const back = docker.calls.slice(docker.calls.indexOf("rename /app-autoheal-old app"));
        expect(back).toEqual([
          "rename /app-autoheal-old app",
          "restore app's data",
          "start /app",
          "discard app's data",
        ]);
        expect(app()).toMatchObject({ Image: OLD_IMAGE, State: { Running: true } });
      });

      it("leaves the old one stopped, and its kept data, when that data cannot go back", async () => {
        const result = await checkpointsDoing({ at: KEPT_AT, problem: "no space left on device" }).update("app");

        expect(result).toEqual({
          succeeded: false,
          outcome: JOB_OUTCOMES.restoreDataFailed(
            "app",
            `${JOB_OUTCOMES.tagMovedMeanwhile(REFERENCE)}; no space left on device`,
          ),
        });
        expect(app()).toMatchObject({ Image: OLD_IMAGE, State: { Running: false } });
        expect(docker.calls).not.toContain("discard app's data");
      });

      it("puts the old one back stopped when its data was too big to keep, as an empty volume may hold that image's files", async () => {
        const oversized = new ContainerUpdater(
          docker,
          async () => undefined,
          () => now,
          {
            take: async (_name, details) => ({ ...completeCheckpoint(details), complete: false, oversized: true }),
            verify: async () => ({ at: null, problem: null }),
            restore: async (name) => {
              docker.calls.push(`restore ${name}'s data`);
              return { at: null, problem: null };
            },
            discard: async () => {},
          },
        );

        const result = await oversized.update("app");

        expect(docker.calls).not.toContain("restore app's data");
        expect(docker.calls.filter((call) => call.startsWith("start "))).toEqual([]);
        expect(app()).toMatchObject({ Image: OLD_IMAGE, State: { Running: false } });
        expect(result).toEqual({
          succeeded: false,
          outcome: JOB_OUTCOMES.restoredStopped("app", JOB_OUTCOMES.tagMovedMeanwhile(REFERENCE)),
        });
      });

      it("puts the old one back stopped after an edit too, which keeps no copy of the data", async () => {
        const result = await updater.edit("app", settingsOf(appContainer(), imageConfig));

        expect(docker.calls.filter((call) => call.startsWith("start "))).toEqual([]);
        expect(app()).toMatchObject({ Image: OLD_IMAGE, State: { Running: false } });
        expect(result).toEqual({
          succeeded: false,
          outcome: EDIT_OUTCOMES.restoredStopped("app", JOB_OUTCOMES.tagMovedMeanwhile(REFERENCE)),
        });
      });

      it("copies nothing back for data in host folders, which Docker never fills", async () => {
        docker.containers.clear();
        docker.add(
          appContainer({ Mounts: [{ Type: "bind", Source: "/srv/app/config", Destination: "/config", RW: true }] }),
        );

        await checkpointsDoing({ at: KEPT_AT, problem: null }).update("app");

        expect(docker.calls).not.toContain("restore app's data");
        expect(app()).toMatchObject({ Image: OLD_IMAGE, State: { Running: true } });
      });
    });

    it("says it kept it when the new one starts badly, and puts it back before the old one starts again", async () => {
      docker.afterStart = () => ({ Status: "exited", Running: false, ExitCode: 1 });
      const updater = checkpointsDoing({ at: KEPT_AT, problem: null });
      expect((await updater.update("app")).outcome).toBe(
        `Updated app, but the new container stopped (exit 1). The old container is kept as app-autoheal-old: roll back from the task, or fix the new one.${kept}`,
      );
      docker.calls.length = 0;
      expect(await updater.rollBack("app")).toEqual({
        succeeded: true,
        outcome:
          "Rolled app back to the container it ran before the update, with its data as it was on 2026-10-24 03:12 UTC.",
      });
      expect(docker.calls).toEqual([
        "removeStopped /app",
        "rename /app-autoheal-old app",
        "restore app's data",
        "start /app",
        "discard app's data",
      ]);
    });

    it("resumes data restore after rename and a reconstructed updater, starting the old container once", async () => {
      docker.afterStart = () => ({ Running: false, Status: "exited", ExitCode: 1 });
      const restored = { at: KEPT_AT, problem: "synthetic copy failure" as string | null };
      await checkpointsDoing(restored).update("app");
      expect((await checkpointsDoing(restored).rollBack("app")).succeeded).toBe(false);
      expect(docker.find("app-autoheal-old")).toBeUndefined();
      expect(app().State.Running).toBe(false);
      restored.problem = null;
      docker.calls.length = 0;
      expect((await checkpointsDoing(restored).rollBack("app")).succeeded).toBe(true);
      expect(docker.calls.filter((call) => call === "start /app")).toHaveLength(1);
      expect(docker.calls.indexOf("restore app's data")).toBeLessThan(docker.calls.indexOf("start /app"));
    });

    it("does not restore again or start twice after a lost start acknowledgement", async () => {
      docker.afterStart = () => ({ Running: false, Status: "exited", ExitCode: 1 });
      await updater.update("app");
      let copies = 0;
      let lost = true;
      const start = docker.start.bind(docker);
      docker.start = async (id) => {
        await start(id);
        if (lost) {
          lost = false;
          throw new Error("lost start response");
        }
      };
      const checkpoints = {
        take: async (_name: string, details: ContainerDetails) => completeCheckpoint(details),
        verify: async () => ({ at: KEPT_AT, problem: null }),
        restore: async () => {
          copies += 1;
          return { at: KEPT_AT, problem: null };
        },
        discard: async () => {},
      };
      const resume = () =>
        new ContainerUpdater(
          docker,
          async () => {},
          () => now,
          checkpoints,
        );
      docker.calls.length = 0;
      expect((await resume().rollBack("app")).succeeded).toBe(false);
      expect(app().State.Running).toBe(true);
      expect((await resume().rollBack("app")).succeeded).toBe(true);
      expect(copies).toBe(1);
      expect(docker.calls.filter((call) => call === "start /app")).toHaveLength(1);
    });

    it("never starts an original until the restored phase is durably published", async () => {
      docker.afterStart = () => ({ Running: false, Status: "exited", ExitCode: 1 });
      await updater.update("app");
      const create = docker.createVolume.bind(docker);
      docker.createVolume = async (name, labels) => {
        if (name.endsWith("-restored")) throw new Error("phase publication failed");
        await create(name, labels);
      };
      docker.calls.length = 0;
      expect((await updater.rollBack("app")).succeeded).toBe(false);
      expect(app().State.Running).toBe(false);
      expect(docker.calls.some((call) => call.startsWith("start "))).toBe(false);
      docker.createVolume = create;
      expect(
        (
          await new ContainerUpdater(
            docker,
            async () => {},
            () => now,
            {
              take: async (_name, details) => completeCheckpoint(details),
              verify: async () => ({ at: null, problem: null }),
              restore: async () => ({ at: null, problem: null }),
              discard: async () => {},
            },
          ).rollBack("app")
        ).succeeded,
      ).toBe(true);
    });

    it("does not mutate containers if publishing the prepared journal fails", async () => {
      docker.afterStart = () => ({ Running: false, Status: "exited", ExitCode: 1 });
      await updater.update("app");
      docker.createVolume = async () => {
        throw new Error("journal full");
      };
      docker.calls.length = 0;
      const result = await updater.rollBack("app");
      expect(result.succeeded).toBe(false);
      expect(result.outcome).toContain("journal full");
      expect(docker.calls).toEqual([]);
      expect(docker.find("app-autoheal-old")).toBeDefined();
    });

    it("finishes cleanup after committed-phase publication fails without re-copying or restarting", async () => {
      docker.afterStart = () => ({ Running: false, Status: "exited", ExitCode: 1 });
      await updater.update("app");
      let copies = 0;
      const checkpoints = {
        take: async (_name: string, details: ContainerDetails) => completeCheckpoint(details),
        verify: async () => ({ at: KEPT_AT, problem: null }),
        restore: async () => {
          copies += 1;
          return { at: KEPT_AT, problem: null };
        },
        discard: async () => {},
      };
      const create = docker.createVolume.bind(docker);
      docker.createVolume = async (name, labels) => {
        if (name.endsWith("-committed")) throw new Error("publish interrupted");
        await create(name, labels);
      };
      const resume = () =>
        new ContainerUpdater(
          docker,
          async () => {},
          () => now,
          checkpoints,
        );
      expect((await resume().rollBack("app")).succeeded).toBe(false);
      docker.createVolume = create;
      docker.calls.length = 0;
      expect((await resume().rollBack("app")).succeeded).toBe(true);
      expect(copies).toBe(1);
      expect(docker.calls.some((call) => call.startsWith("start "))).toBe(false);
    });

    describe("when the old container is not seen to go once the new one holds", () => {
      // Docker refuses, or acts and loses its answer: either way the update itself has held.
      const removalFails = (removedAnyway: boolean) => {
        const originalId = app().Id!;
        const remove = docker.remove.bind(docker);
        docker.remove = async (reference) => {
          if (reference !== originalId) return remove(reference);
          docker.calls.push(`remove ${docker.find(reference)?.Name}`);
          if (removedAnyway) docker.containers.delete(originalId);
          throw new Error("removal of container is already in progress");
        };
      };

      it("keeps the copy of its data, says so, and a roll back to it still puts that data back", async () => {
        removalFails(false);
        const updater = checkpointsDoing({ at: KEPT_AT, problem: null });

        const result = await updater.update("app");

        expect(result.succeeded).toBe(true);
        expect(result.outcome).toContain(JOB_OUTCOMES.originalKept("app-autoheal-old"));
        expect(docker.calls).not.toContain("discard app's data");
        expect(docker.find("app-autoheal-old")).toBeDefined();
        docker.calls.length = 0;
        expect((await updater.rollBack("app")).succeeded).toBe(true);
        expect(docker.calls.indexOf("restore app's data")).toBeLessThan(docker.calls.indexOf("start /app"));
      });

      it("lets the copy go when Docker removed it though its answer was lost", async () => {
        removalFails(true);

        const result = await checkpointsDoing({ at: KEPT_AT, problem: null }).update("app");

        expect(result.outcome).not.toContain(JOB_OUTCOMES.originalKept("app-autoheal-old"));
        expect(docker.calls).toContain("discard app's data");
      });

      it("keeps the copy when Docker cannot be asked whether it went", async () => {
        const originalId = app().Id!;
        const inspect = docker.inspect.bind(docker);
        let removing = false;
        const remove = docker.remove.bind(docker);
        docker.remove = async (reference) => {
          removing ||= reference === originalId;
          return remove(reference);
        };
        docker.inspect = async (reference) => {
          if (removing && reference === originalId) throw new Error("Docker went away");
          return inspect(reference);
        };

        const result = await checkpointsDoing({ at: KEPT_AT, problem: null }).update("app");

        expect(result.outcome).toContain(JOB_OUTCOMES.originalKept("app-autoheal-old"));
        expect(docker.calls).not.toContain("discard app's data");
      });
    });

    it("leaves the old container stopped when its data cannot be put back", async () => {
      docker.afterStart = () => ({ Status: "exited", Running: false, ExitCode: 1 });
      const updater = checkpointsDoing({ at: KEPT_AT, problem: "no space left on device" });
      await updater.update("app");
      expect(await updater.rollBack("app")).toMatchObject({
        succeeded: false,
        outcome:
          "Put back app's old container but could not restore its data (no space left on device); it is left stopped so the old version does not run on the new data.",
      });
      expect(app()).toMatchObject({ Image: OLD_IMAGE, State: { Running: false } });
    });

    it("keeps nothing for an edit, which runs the same image on the same data", async () => {
      const updater = checkpointsDoing({ at: KEPT_AT, problem: null });
      const edited = await updater.edit("app", settingsOf(appContainer(), imageConfig));
      expect(edited.succeeded).toBe(true);
      expect(docker.calls).not.toContain("keep app's data");
    });
  });

  describe("with others inside its network", () => {
    const VPN_IMAGE = `sha256:${"5".repeat(64)}`;
    const VPN_REFERENCE = "ghcr.io/example/qbittorrent:4";
    const vpnId = "5".repeat(64);
    // qBittorrent through the app's VPN, as compose's network_mode: "service:app" makes it.
    const addDependent = (overrides: Partial<ContainerDetails> = {}) => {
      docker.images.set(VPN_IMAGE, { Id: VPN_IMAGE, Config: { Image: VPN_REFERENCE, Env: ["PATH=/usr/bin"] } });
      docker.tags.set(VPN_REFERENCE, VPN_IMAGE);
      docker.add({
        Id: vpnId,
        Name: "/qbittorrent",
        Image: VPN_IMAGE,
        State: { Status: "running", Running: true, ExitCode: 0 },
        Config: {
          Image: VPN_REFERENCE,
          Hostname: app().Config.Hostname,
          Domainname: "",
          Env: ["PATH=/usr/bin", "PUID=1000"],
        },
        HostConfig: { NetworkMode: `container:${app().Id}` },
        ...overrides,
      });
      docker.summaries = [
        {
          Id: vpnId,
          Names: ["/qbittorrent"],
          State: "running",
          Status: "Up",
          HostConfig: { NetworkMode: `container:${app().Id}` },
        },
      ];
    };
    const qbittorrent = () => docker.find("qbittorrent")!;

    const addGroup = () => {
      addDependent();
      const first = structuredClone(qbittorrent());
      for (const [name, running] of [
        ["offline", false],
        ["second", true],
        ["untouched", true],
      ] as const) {
        const id = name.padEnd(64, "0");
        docker.add({
          ...structuredClone(first),
          Id: id,
          Name: `/${name}`,
          State: { Status: running ? "running" : "exited", Running: running },
        });
        docker.summaries.push({
          Id: id,
          Names: [`/${name}`],
          State: running ? "running" : "exited",
          Status: "",
          HostConfig: { NetworkMode: `container:${app().Id}` },
        });
      }
    };

    it("compensates a partial dependent stop failure before touching the provider", async () => {
      addGroup();
      const provider = structuredClone(app());
      docker.failStops.add("/second");
      const result = await updater.update("app");
      expect(result.succeeded).toBe(false);
      expect(result.outcome).toContain("second");
      expect(result.outcome).toContain("Started qbittorrent again.");
      expect(docker.calls).toEqual([`pull ${REFERENCE}`, "stop /qbittorrent", "stop /second", "start /qbittorrent"]);
      expect(app()).toEqual(provider);
      expect(qbittorrent().State.Running).toBe(true);
      expect(docker.find("offline")?.State.Running).toBe(false);
      expect(docker.find("untouched")?.State.Running).toBe(true);
      expect(docker.created).toEqual([]);
      expect(result.output).toContain(vpnId);
      expect(result.output).toContain("second");
    });

    it("does not start any group member when the first stop fails", async () => {
      addGroup();
      docker.failStops.add("/qbittorrent");
      const result = await updater.update("app", true);
      expect(result.succeeded).toBe(false);
      expect(docker.calls).toEqual([`pull ${REFERENCE}`, "stop /qbittorrent"]);
      expect(JSON.parse(result.output!)).toMatchObject({
        stopped: [],
        restarted: [],
        restartFailures: [],
        stopNotConfirmed: { name: "qbittorrent", id: vpnId },
        provider: { changed: false },
      });
      expect(docker.find("offline")?.State.Running).toBe(false);
    });

    it("enumerates all compensation failures without claiming restoration", async () => {
      addGroup();
      docker.failStops.add("/untouched");
      docker.failStarts.add("/qbittorrent");
      docker.failStarts.add("/second");
      const result = await updater.update("app");
      expect(result.succeeded).toBe(false);
      expect(result.outcome).toContain("Could not restart qbittorrent");
      expect(result.outcome).toContain("Could not restart second");
      expect(result.outcome).not.toContain("Started");
      expect(JSON.parse(result.output!).restartFailures.map((failure: { name: string }) => failure.name)).toEqual([
        "qbittorrent",
        "second",
      ]);
      expect(docker.calls.slice(-2)).toEqual(["start /qbittorrent", "start /second"]);
      expect(app().State.Running).toBe(true);
    });

    it("reports each failed compensation and still attempts the remaining stopped dependents", async () => {
      addGroup();
      docker.failStops.add("/untouched");
      docker.failStarts.add("/qbittorrent");
      const result = await updater.update("app");
      expect(result.succeeded).toBe(false);
      expect(result.outcome).toContain("Could not restart qbittorrent");
      expect(result.outcome).toContain("Started second again.");
      expect(result.output).toContain("synthetic start failure");
      expect(result.output).toContain(vpnId);
      expect(qbittorrent().State.Running).toBe(false);
      expect(docker.find("second")?.State.Running).toBe(true);
      expect(docker.find("offline")?.State.Running).toBe(false);
      expect(docker.calls).not.toContain("stop /app");
      expect(docker.created).toEqual([]);
    });

    it("updates it and recreates each inside the new one's network, on its own image, before the old one goes", async () => {
      addDependent();
      const oldAppId = app().Id;
      const result = await updater.update("app");
      expect(result).toEqual({
        succeeded: true,
        outcome: `Updated app to the newest ${REFERENCE}, and it is running. The image it ran before is kept as ${KEPT}. Recreated qbittorrent on its new network.`,
      });
      expect(docker.calls).toEqual([
        `pull ${REFERENCE}`,
        "stop /qbittorrent",
        "stop /app",
        "rename /app app-autoheal-old",
        "create app",
        "start /app",
        "rename /qbittorrent qbittorrent-autoheal-old",
        "create qbittorrent",
        "start /qbittorrent",
        "remove /qbittorrent-autoheal-old",
        "remove /app-autoheal-old",
        `tag ${OLD_IMAGE} ${KEPT}`,
      ]);
      expect(app().Id).not.toBe(oldAppId);
      expect(qbittorrent()).toMatchObject({
        Image: VPN_IMAGE,
        State: { Running: true },
        HostConfig: { NetworkMode: `container:${app().Id}` },
      });
      // Docker gives it the new one's names: asking for any conflicts with the mode.
      expect(qbittorrent().Config).not.toHaveProperty("Hostname");
      expect(qbittorrent().Config).not.toHaveProperty("Domainname");
      expect(qbittorrent().Config.Env).toEqual(["PUID=1000"]);
      expect(await updater.dependentsOf("app")).toEqual([]);
    });

    it("keeps a dependent's copy of its data when its old container is not seen to go, and says so", async () => {
      addDependent();
      const discarded: string[] = [];
      const keeping = new ContainerUpdater(
        docker,
        async (milliseconds) => {
          now += milliseconds;
        },
        () => now,
        {
          take: async (_name, details) => completeCheckpoint(details),
          verify: async () => ({ at: null, problem: null }),
          restore: async () => ({ at: null, problem: null }),
          discard: async (name) => void discarded.push(name),
        },
      );
      const remove = docker.remove.bind(docker);
      docker.remove = async (reference) => {
        if (reference === vpnId) throw new Error("device or resource busy");
        return remove(reference);
      };

      const result = await keeping.update("app");

      expect(result.succeeded).toBe(true);
      expect(result.outcome).toContain(JOB_OUTCOMES.originalKept("qbittorrent-autoheal-old"));
      expect(discarded).toEqual(["app"]);
      expect(docker.find("qbittorrent-autoheal-old")?.Id).toBe(vpnId);
    });

    it("updates one of them on its own, without asking for the names Docker gives it from the other", async () => {
      addDependent();
      expect(await updater.update("qbittorrent")).toMatchObject({ succeeded: true });
      expect(qbittorrent()).toMatchObject({
        Image: NEW_IMAGE,
        State: { Running: true },
        HostConfig: { NetworkMode: `container:${app().Id}` },
      });
      expect(qbittorrent().Config).not.toHaveProperty("Hostname");
      expect(app().Image).toBe(OLD_IMAGE);
    });

    it("starts them again on the old one when the new one never ran", async () => {
      addDependent();
      docker.failCreate = true;
      const result = await updater.update("app");
      expect(result).toMatchObject({ succeeded: false });
      expect(result.outcome).toContain("The old container is back as it was. Started qbittorrent again.");
      expect(qbittorrent().State.Running).toBe(true);
    });

    it("leaves them stopped when the new one starts badly, and a roll back starts them", async () => {
      addDependent();
      docker.afterStart = (container) =>
        container.Name === "/app"
          ? { Status: "exited", Running: false, ExitCode: 1 }
          : { Status: "running", Running: true };
      const result = await updater.update("app");
      expect(result.outcome).toContain(
        "kept as app-autoheal-old: roll back from the task, or fix the new one. qbittorrent shares its network and stays stopped until you roll back or fix it.",
      );
      expect(qbittorrent().State.Running).toBe(false);

      expect(await updater.rollBack("app")).toEqual({
        succeeded: true,
        outcome: "Rolled back the update group: app, qbittorrent. Originally stopped containers remain stopped.",
      });
      expect(qbittorrent()).toMatchObject({ Id: vpnId, State: { Running: true } });
    });

    it("keeps the whole group stopped and aside when one had too much data to copy and the new one starts badly", async () => {
      addDependent({ Mounts: [{ Type: "volume", Name: "client-data", Destination: "/data", RW: true }] });
      docker.afterStart = (container) =>
        container.Name === "/app"
          ? { Status: "exited", Running: false, ExitCode: 1 }
          : { Status: "running", Running: true };
      const started = startsSeen();
      const restored: string[] = [];
      const tooMuchForOne = new ContainerUpdater(
        docker,
        async (milliseconds) => {
          now += milliseconds;
        },
        () => now,
        {
          take: async (name, details) =>
            name === "qbittorrent"
              ? { ...completeCheckpoint(details, TOO_MUCH_DATA), complete: false, oversized: true }
              : completeCheckpoint(details),
          verify: async (name) => ({
            at: null,
            problem: name === "qbittorrent" ? VOLUME_COPY_MESSAGES.incomplete : null,
          }),
          restore: async (name) => {
            restored.push(name);
            return { at: null, problem: null };
          },
          discard: async () => {},
        },
      );

      const result = await tooMuchForOne.update("app", true);

      expect(started).toEqual([NEW_IMAGE]);
      expect(docker.find("app-autoheal-old")).toMatchObject({ Image: OLD_IMAGE, State: { Running: false } });
      expect(qbittorrent().State.Running).toBe(false);
      expect(restored).toEqual([]);
      expect(result).toEqual({
        succeeded: false,
        outcome: `${JOB_OUTCOMES.startedBadly("app", "the new container stopped (exit 1)", "app-autoheal-old")}${JOB_OUTCOMES.dependentsStopped(["qbittorrent"])} qbittorrent: ${TOO_MUCH_DATA}`,
        output: expect.any(String),
      });
    });

    it("leaves them stopped with their copies when Docker's answer to the new one's start is lost", async () => {
      addDependent();
      const providerId = app().Id!;
      const start = docker.start.bind(docker);
      docker.start = async (reference) => {
        const starting = docker.find(reference)!;
        await start(reference);
        if (starting.Name === "/app" && starting.Id !== providerId) throw new Error("socket hang up");
      };
      const discarded: string[] = [];
      const keeping = new ContainerUpdater(
        docker,
        async (milliseconds) => {
          now += milliseconds;
        },
        () => now,
        {
          take: async (_name, details) => completeCheckpoint(details),
          verify: async () => ({ at: null, problem: null }),
          restore: async () => ({ at: null, problem: null }),
          discard: async (name) => void discarded.push(name),
        },
      );
      const result = await keeping.update("app");
      expect(result.outcome).toBe(
        JOB_OUTCOMES.startedBadly("app", VERIFY_PROBLEMS.startUnconfirmed("socket hang up"), "app-autoheal-old") +
          JOB_OUTCOMES.dependentsStopped(["qbittorrent"]),
      );
      expect(qbittorrent().State.Running).toBe(false);
      expect(discarded).toEqual([]);

      expect(await keeping.rollBack("app")).toMatchObject({ succeeded: true });
      expect(qbittorrent()).toMatchObject({ Id: vpnId, State: { Running: true } });
      expect(app()).toMatchObject({ Id: providerId, State: { Running: true } });
    });

    it("never starts a dependent on an image its tag was moved to meanwhile, and keeps its old container", async () => {
      addDependent();
      const MOVED = `sha256:${"6".repeat(64)}`;
      const rename = docker.rename.bind(docker);
      docker.rename = async (reference, newName) => {
        if (newName === "qbittorrent-autoheal-old") {
          docker.images.set(MOVED, { Id: MOVED, Config: { Env: ["PATH=/usr/bin"] } });
          docker.tags.set(VPN_REFERENCE, MOVED);
        }
        return rename(reference, newName);
      };
      const result = await updater.update("app");
      expect([...docker.containers.values()].some((container) => container.Image === MOVED)).toBe(false);
      expect(docker.find("qbittorrent-autoheal-old")?.Id).toBe(vpnId);
      expect(result.succeeded).toBe(false);
      expect(result.outcome).toContain(
        JOB_OUTCOMES.dependentNotRecreated(
          "qbittorrent",
          JOB_OUTCOMES.tagMovedMeanwhile(VPN_REFERENCE),
          "qbittorrent-autoheal-old",
        ),
      );
    });

    it("keeps it and those inside its network stopped when its tag moved and none of its data was kept", async () => {
      addDependent();
      const MOVED = `sha256:${"7".repeat(64)}`;
      const rename = docker.rename.bind(docker);
      docker.rename = async (reference, newName) => {
        if (newName === "app-autoheal-old") {
          docker.images.set(MOVED, { Id: MOVED, Config: {} });
          docker.tags.set(REFERENCE, MOVED);
        }
        return rename(reference, newName);
      };
      const nothingKept = new ContainerUpdater(
        docker,
        async () => undefined,
        () => now,
        {
          take: async (_name, details) => ({
            ...completeCheckpoint(details, TOO_MUCH_DATA),
            complete: false,
            oversized: true,
          }),
          verify: async () => ({ at: null, problem: VOLUME_COPY_MESSAGES.incomplete }),
          restore: async () => ({ at: null, problem: null }),
          discard: async () => {},
        },
      );

      const result = await nothingKept.update("app");

      expect(docker.calls.filter((call) => call.startsWith("start "))).toEqual([]);
      expect(app()).toMatchObject({ Image: OLD_IMAGE, State: { Running: false } });
      expect(qbittorrent().State.Running).toBe(false);
      expect(result).toEqual({
        succeeded: false,
        outcome: `${JOB_OUTCOMES.restoredStopped("app", JOB_OUTCOMES.tagMovedMeanwhile(REFERENCE))}${JOB_OUTCOMES.dependentsWaitStopped(["qbittorrent"])}`,
      });
    });

    it("keeps a dependent's old container when its new one does not hold", async () => {
      addDependent();
      docker.afterStart = (container) =>
        container.Name === "/qbittorrent"
          ? { Status: "exited", Running: false, ExitCode: 2 }
          : { Status: "running", Running: true };
      const result = await updater.update("app");
      expect(result.succeeded).toBe(false);
      expect(result.outcome).toContain(
        "Recreated qbittorrent, but the new container stopped (exit 2); its old container is kept as qbittorrent-autoheal-old.",
      );
      expect(docker.find("qbittorrent-autoheal-old")?.Id).toBe(vpnId);
      expect(docker.find("app-autoheal-old")?.Image).toBe(OLD_IMAGE);
    });

    it.each(["create", "start", "verify"])(
      "retains every original and checkpoint after dependent %s failure, then restores the entire group after runner restart",
      async (failure) => {
        addGroup();
        const names = ["app", "offline", "qbittorrent", "second", "untouched"];
        const originals = names.map((name) => structuredClone(docker.find(name)!));
        const data = new Map(names.map((name) => [name, 1]));
        const kept = new Map<string, number>();
        const discarded: string[] = [];
        for (const name of names)
          docker.find(name)!.Mounts = [{ Type: "volume", Name: `${name}-data`, Destination: "/data", RW: true }];
        const checkpoints = {
          take: async (name: string, details: ContainerDetails) => {
            expect([...docker.containers.values()].every(({ State }) => State.Running !== true)).toBe(true);
            kept.set(name, data.get(name)!);
            return completeCheckpoint(details);
          },
          verify: async (name: string) => ({ at: null, problem: kept.has(name) ? null : "checkpoint missing" }),
          restore: async (name: string) => {
            expect([...docker.containers.values()].every(({ State }) => State.Running !== true)).toBe(true);
            data.set(name, kept.get(name)!);
            return { at: null, problem: null };
          },
          discard: async (name: string) => {
            discarded.push(name);
            kept.delete(name);
          },
        };
        const makeUpdater = () =>
          new ContainerUpdater(
            docker,
            async (ms) => {
              now += ms;
            },
            () => now,
            checkpoints,
          );
        docker.afterStart = (container) => {
          for (const original of originals) expect(docker.find(original.Id!)).toBeDefined();
          if (!originals.some(({ Id }) => Id === container.Id)) data.set(container.Name.slice(1), 2);
          return container.Name === "/second" && !originals.some(({ Id }) => Id === container.Id)
            ? { Status: "exited", Running: false, ExitCode: 2 }
            : { Status: "running", Running: true };
        };
        const create = docker.create.bind(docker);
        if (failure === "create")
          docker.create = async (name, specification) => {
            if (name === "second") throw new Error("synthetic create failure");
            return create(name, specification);
          };
        if (failure === "start") docker.failStarts.add("/second");
        const result = await makeUpdater().update("app");
        expect(result.succeeded).toBe(false);
        expect(result.outcome).toContain("retained for the whole group");
        for (const original of originals) expect(docker.find(original.Id!)).toBeDefined();
        expect(kept.size).toBe(names.length);
        expect(discarded).toEqual([]);
        expect(data.get("app")).toBe(2);
        docker.failStarts.clear();
        expect(await makeUpdater().rollBack("app")).toMatchObject({ succeeded: true });
        for (const original of originals) {
          const restored = docker.find(original.Name.slice(1))!;
          expect(restored.Id).toBe(original.Id);
          expect(restored.State.Running).toBe(original.State.Running);
          if (original.Name !== "/app") expect(restored.HostConfig?.NetworkMode).toBe(`container:${originals[0]!.Id}`);
          expect(data.get(original.Name.slice(1))).toBe(1);
        }
        expect(docker.containers.size).toBe(names.length);
        expect(new Set(discarded)).toEqual(new Set(names));
      },
    );

    it("requires a usable checkpoint for every writable dependent before replacing the provider", async () => {
      addDependent({ Mounts: [{ Type: "volume", Name: "client-data", Destination: "/data", RW: true }] });
      const unsafe = new ContainerUpdater(
        docker,
        async () => {},
        () => now,
        {
          take: async (_name, details) => ({ ...completeCheckpoint(details), complete: false, outcome: "copy failed" }),
          verify: async () => ({ at: null, problem: "copy failed" }),
          restore: async () => ({ at: null, problem: null }),
          discard: async () => {},
        },
      );
      const result = await unsafe.update("app");
      expect(result.succeeded).toBe(false);
      expect(result.outcome).toContain("copy failed");
      expect(docker.calls).not.toContain("rename /app app-autoheal-old");
      expect(app().State.Running).toBe(true);
      expect(qbittorrent().State.Running).toBe(true);
      expect(docker.created).toEqual([]);
    });

    it("automatically undoes the whole group when a dependent fails", async () => {
      addGroup();
      const before = [...docker.containers.values()].map(({ Id, Name, State }) => ({
        Id,
        Name,
        running: State.Running,
      }));
      docker.afterStart = (container) =>
        container.Name === "/second" && !before.some(({ Id }) => Id === container.Id)
          ? { Running: false, Status: "exited", ExitCode: 2 }
          : { Running: true, Status: "running" };
      const result = await updater.update("app", true);
      expect(result.succeeded).toBe(false);
      expect(result.outcome).toContain("Rolled back the update group");
      expect(docker.containers.size).toBe(before.length);
      for (const member of before) expect(docker.find(member.Id!)?.State.Running).toBe(member.running);
    });

    it("never starts originals or discards checkpoints if any group data restore fails", async () => {
      addDependent();
      docker.afterStart = (container) =>
        container.Name === "/qbittorrent"
          ? { Running: false, Status: "exited", ExitCode: 2 }
          : { Running: true, Status: "running" };
      await updater.update("app");
      const discarded: string[] = [];
      const recovery = new ContainerUpdater(
        docker,
        async () => {},
        () => now,
        {
          take: async (_name, details) => completeCheckpoint(details),
          verify: async () => ({ at: null, problem: null }),
          restore: async (name) => ({ at: null, problem: name === "qbittorrent" ? "synthetic restore failure" : null }),
          discard: async (name) => {
            discarded.push(name);
          },
        },
      );
      const start = docker.calls.length;
      const result = await recovery.rollBack("app");
      expect(result.succeeded).toBe(false);
      expect(result.outcome).toContain("synthetic restore failure");
      expect(JSON.parse(result.output!).owner).toBe("app");
      expect(docker.calls.slice(start).some((call) => call.startsWith("start "))).toBe(false);
      expect(discarded).toEqual([]);
      expect(app().State.Running).toBe(false);
      expect(qbittorrent().State.Running).toBe(false);
    });

    it("retains the whole group when a rollback writer cannot stop", async () => {
      addGroup();
      docker.afterStart = (container) =>
        container.Name === "/second"
          ? { Running: false, Status: "exited", ExitCode: 2 }
          : { Running: true, Status: "running" };
      await updater.update("app");
      const providerId = app().Id;
      docker.failStops.add("/qbittorrent");
      docker.calls.length = 0;
      const result = await updater.rollBack("app");
      expect(result.succeeded).toBe(false);
      expect(JSON.parse(result.output!).owner).toBe("app");
      expect(docker.calls).toEqual(["stop /qbittorrent"]);
      expect(app().Id).toBe(providerId);
      expect(docker.find("app-autoheal-old")).toBeDefined();
      expect(docker.find("qbittorrent-autoheal-old")).toBeDefined();
    });

    it("resumes a partially restored group by immutable IDs after its manifest container is gone", async () => {
      addGroup();
      const originals = [...docker.containers.values()].map((container) => structuredClone(container));
      docker.afterStart = (container) =>
        container.Name === "/second" && !originals.some(({ Id }) => Id === container.Id)
          ? { Running: false, Status: "exited", ExitCode: 2 }
          : { Running: true, Status: "running" };
      await updater.update("app");
      const data = new Map(originals.map(({ Name }) => [Name.slice(1), 2]));
      let interrupted = true;
      const checkpoints = {
        take: async (_name: string, details: ContainerDetails) => completeCheckpoint(details),
        verify: async () => ({ at: null, problem: null }),
        restore: async (name: string) => {
          if (name === "qbittorrent" && interrupted) return { at: null, problem: "copy interrupted" };
          data.set(name, 1);
          return { at: null, problem: null };
        },
        discard: async () => {},
      };
      const resume = () =>
        new ContainerUpdater(
          docker,
          async () => {},
          () => now,
          checkpoints,
        );
      expect((await resume().rollBack("app")).succeeded).toBe(false);
      expect(docker.find("app-autoheal-old")).toBeUndefined();
      expect(app().State.Running).toBe(false);
      expect(data.get("app")).toBe(1);
      expect(data.get("qbittorrent")).toBe(2);
      interrupted = false;
      const start = docker.start.bind(docker);
      docker.start = async (id) => {
        expect([...data.values()].every((schema) => schema === 1)).toBe(true);
        await start(id);
      };
      docker.calls.length = 0;
      expect((await resume().rollBack("app")).succeeded).toBe(true);
      for (const original of originals) {
        expect(docker.find(original.Id!)?.State.Running).toBe(original.State.Running);
        expect(docker.calls.filter((call) => call === `start ${original.Name}`)).toHaveLength(
          original.State.Running ? 1 : 0,
        );
      }
    });

    it("refuses group rollback before mutation if any dependent checkpoint is missing", async () => {
      addDependent({ Mounts: [{ Type: "volume", Name: "client-data", Destination: "/data", RW: true }] });
      docker.afterStart = (container) =>
        container.Name === "/qbittorrent"
          ? { Running: false, Status: "exited", ExitCode: 2 }
          : { Running: true, Status: "running" };
      await updater.update("app");
      const start = docker.calls.length;
      const recovery = new ContainerUpdater(
        docker,
        async () => {},
        () => now,
        {
          take: async (_name, details) => completeCheckpoint(details),
          verify: async (name) => ({ at: null, problem: name === "qbittorrent" ? "checkpoint missing" : null }),
          restore: async () => {
            throw new Error("must not restore");
          },
          discard: async () => {
            throw new Error("must not discard");
          },
        },
      );
      expect((await recovery.rollBack("app")).succeeded).toBe(false);
      expect(docker.calls.slice(start)).toEqual([]);
      expect(docker.find("app-autoheal-old")).toBeDefined();
    });

    it("refuses the group when one is labelled off or its tag moved on, before anything stops", async () => {
      addDependent({ Config: { Image: VPN_REFERENCE, Labels: { "autoheal.update": "off" } } });
      expect((await updater.update("app")).outcome).toBe(
        "Refused: qbittorrent shares app's network and is labelled autoheal.update=off; update them together with docker compose.",
      );
      docker.containers.delete(vpnId);
      addDependent();
      docker.tags.set(VPN_REFERENCE, `sha256:${"6".repeat(64)}`);
      expect((await updater.update("app")).outcome).toBe(
        "Refused: qbittorrent shares app's network, and its tag now names a newer image than it runs. Update qbittorrent first.",
      );
      expect(docker.calls).toEqual([]);
    });

    it("still refuses to edit it: an edit recreates it alone", async () => {
      addDependent();
      expect((await updater.edit("app", settingsOf(appContainer(), imageConfig))).outcome).toBe(
        "Refused: qbittorrent shares app's network; update them together with docker compose.",
      );
    });
  });
});

describe("an update where a signed image is required", () => {
  const PULLED = `sha256:${"d".repeat(64)}`;
  let docker: InMemoryDocker;
  let policy: ImageTrustPolicy;
  let found: ImageProvenance | Error;
  let asked: string[];
  let clock: number;

  const provenanceSource = {
    policy: () => policy,
    read: async (reference: { repository: string }, digest: string) => {
      asked.push(`${reference.repository}@${digest}`);
      if (found instanceof Error) throw found;
      return found;
    },
  };
  // The clock has to move as the updater waits, or waiting for a healthy container never ends.
  const updaterWith = () =>
    new ContainerUpdater(
      docker,
      async (milliseconds: number) => {
        clock += milliseconds;
      },
      () => clock,
      {
        take: async (_name, details) => completeCheckpoint(details),
        verify: async () => ({ at: null, problem: null }),
        restore: async () => ({ at: null, problem: null }),
        discard: async () => {},
      },
      undefined,
      undefined,
      () => undefined,
      provenanceSource,
    );
  const verified = (digest: string, publisher = "example"): ImageProvenance => ({
    status: PROVENANCE_STATUS.verified,
    digest,
    publisher,
    checkedAt: 1,
    problem: null,
  });

  beforeEach(() => {
    docker = new InMemoryDocker();
    docker.add(appContainer());
    docker.pulledDigests = [`ghcr.io/example/app@${PULLED}`];
    asked = [];
    clock = 0;
    policy = {
      revision: 1,
      publishers: [{ name: "example", publicKey: "irrelevant here" }],
      required: [{ registry: "ghcr.io", repository: "example/app", publishers: [] }],
    };
    found = verified(PULLED);
  });

  it("goes ahead when the digest Docker pulled is the one a trusted publisher signed", async () => {
    const result = await updaterWith().update("app");

    expect(result.succeeded).toBe(true);
    expect(asked).toEqual([`example/app@${PULLED}`]);
    expect(docker.find("app")?.Image).toBe(NEW_IMAGE);
  });

  it("asks about the digest Docker recorded, not about the tag", async () => {
    await updaterWith().update("app");

    expect(asked[0]).toContain(PULLED);
    expect(asked[0]).not.toContain(":2");
  });

  it("never starts an image its tag was moved to after the signed one was checked, and puts the old one back", async () => {
    const UNCHECKED = `sha256:${"f".repeat(64)}`;
    // Another pull of the same tag, by a person or a cron, while the old container is set aside.
    const rename = docker.rename.bind(docker);
    docker.rename = async (reference, newName) => {
      docker.images.set(UNCHECKED, { Id: UNCHECKED, Config: {} });
      docker.tags.set(REFERENCE, UNCHECKED);
      return rename(reference, newName);
    };
    const started: (string | undefined)[] = [];
    const start = docker.start.bind(docker);
    docker.start = async (reference) => {
      started.push(docker.find(reference)?.Image);
      return start(reference);
    };

    const result = await updaterWith().update("app");

    expect(started).not.toContain(UNCHECKED);
    expect(docker.find("app")).toMatchObject({ Image: OLD_IMAGE, State: { Running: true } });
    expect([...docker.containers.values()].map((container) => container.Image)).toEqual([OLD_IMAGE]);
    expect(result).toEqual({
      succeeded: false,
      outcome: JOB_OUTCOMES.restoredAfterFailure("app", JOB_OUTCOMES.tagMovedMeanwhile(REFERENCE)),
    });
  });

  it("stops nothing when the proof is for another digest", async () => {
    found = verified(`sha256:${"e".repeat(64)}`);

    const result = await updaterWith().update("app");

    expect(result.succeeded).toBe(false);
    expect(result.outcome).toContain("needs a signed image");
    expect(docker.find("app")?.Image).toBe(OLD_IMAGE);
    expect(docker.calls.filter((call) => /^(stop|rename|create|remove) /.test(call))).toEqual([]);
  });

  it("stops nothing when the publisher is not one this scope names", async () => {
    policy = { ...policy, required: [{ registry: "ghcr.io", repository: "example/app", publishers: ["someone"] }] };

    const result = await updaterWith().update("app");

    expect(result.succeeded).toBe(false);
    expect(docker.find("app")?.Image).toBe(OLD_IMAGE);
  });

  it.each([
    [PROVENANCE_STATUS.unsigned, "no signature"],
    [PROVENANCE_STATUS.invalid, "does not hold up"],
    [PROVENANCE_STATUS.unreachable, "could not be asked"],
  ])("stops nothing when the image is %s, and says which it was", async (status, problem) => {
    found = { status, digest: PULLED, publisher: null, checkedAt: 1, problem };

    const result = await updaterWith().update("app");

    expect(result.succeeded).toBe(false);
    expect(result.outcome).toContain(problem);
    expect(docker.find("app")?.Image).toBe(OLD_IMAGE);
  });

  it("stops nothing when Docker recorded no digest for what it pulled", async () => {
    docker.pulledDigests = null;

    const result = await updaterWith().update("app");

    expect(result.succeeded).toBe(false);
    expect(result.outcome).toContain("needs a signed image");
    expect(asked).toEqual([]);
  });

  it("stops nothing when the registry could not be asked at all", async () => {
    found = new Error("getaddrinfo ENOTFOUND ghcr.io");

    const result = await updaterWith().update("app");

    expect(result.succeeded).toBe(false);
    expect(result.outcome).toContain("ENOTFOUND");
    expect(docker.find("app")?.Image).toBe(OLD_IMAGE);
  });

  it("asks nothing and changes nothing about an image no rule covers", async () => {
    policy = { ...policy, required: [{ registry: "ghcr.io", repository: "someone/else", publishers: [] }] };

    const result = await updaterWith().update("app");

    expect(result.succeeded).toBe(true);
    expect(asked).toEqual([]);
  });

  it("updates as it always did where no rule is set up at all", async () => {
    policy = EMPTY_TRUST_POLICY;

    const result = await updaterWith().update("app");

    expect(result.succeeded).toBe(true);
    expect(asked).toEqual([]);
    expect(docker.find("app")?.Image).toBe(NEW_IMAGE);
  });
});
