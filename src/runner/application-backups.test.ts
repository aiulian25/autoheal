import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { APPLICATION_BOOT_DRILL, APPLICATION_BOOT_TEXT } from "../shared/application-backups.js";
import { ApplicationBackups, imageOnHost } from "./application-backups.js";
import { RemedyGuard } from "./remedy-guard.js";
import type { DockerClient } from "./docker-client.js";
import type { ContainerDetails } from "./incident-report.js";
import {
  APPLICATION_HELPER_ERRORS,
  type ApplicationBackupResult,
  type ApplicationBackupTask,
} from "../shared/application-backups.js";
function setup() {
  const containers = new Map<string, ContainerDetails>();
  const volumes = new Map<string, { Name: string; Labels: Record<string, string> }>();
  const calls: string[] = [];
  // The image each helper was created with.
  const helperImages: string[] = [];
  const results: ApplicationBackupResult[] = [];
  let now = 1_000_000;
  let reportFails = false,
    stopFails: string | null = null;
  let bootImageGone = false;
  let removeFails = false;
  const member = (name: string, sources: string[], running = true) => {
    const value = {
      Id: `id-${name}`,
      Name: `/${name}`,
      Image: "image",
      Config: { Image: "fixture" },
      HostConfig: {},
      State: { Running: running, ExitCode: 0 },
      Mounts: sources.map((source, i) => ({
        Type: "volume",
        Name: source,
        Source: `/engine/${source}`,
        Destination: `/data/${i}`,
        RW: true,
      })),
    } as ContainerDetails;
    containers.set(value.Id!, value);
    return value;
  };
  member("a", ["one"]);
  member("b", ["one", "two"]);
  member("c", ["two"]);
  member("stopped", ["one"], false);
  member("runner", [], true);
  const docker = {
    setRestartPolicy: async (id: string, policy: { Name: string; MaximumRetryCount: number }) => {
      (await docker.inspect(id))!.HostConfig!.RestartPolicy = policy;
    },
    inspectVolume: async (name: string) => ({ Name: name, Driver: "local", Options: {} }),
    inspect: async (name: string) =>
      containers.get(name) ?? [...containers.values()].find((v) => v.Name === `/${name}`) ?? null,
    containerSummaries: async () =>
      [...containers.values()].map((v) => ({ Id: v.Id, Names: [v.Name], Labels: v.Config.Labels ?? {} })),
    volumes: async (filter: string) => [...volumes.values()].filter((volume) => volume.Labels[filter] !== undefined),
    createVolume: async (name: string, labels: Record<string, string>) => {
      volumes.set(name, { Name: name, Labels: labels });
    },
    removeVolume: async (name: string) => {
      volumes.delete(name);
    },
    stop: async (id: string) => {
      calls.push(`stop:${id}`);
      if (stopFails === id) throw new Error("unavailable");
      (await docker.inspect(id))!.State.Running = false;
    },
    start: async (id: string) => {
      calls.push(`start:${id}`);
      (await docker.inspect(id))!.State.Running = true;
    },
    inspectImage: async (reference: string) => (bootImageGone ? null : { Id: reference }),
    logs: async () => "the database is corrupt",
    remove: async (name: string) => {
      calls.push(`remove:${name}`);
      if (removeFails) return;
      const value = await docker.inspect(name);
      if (value) containers.delete(value.Id!);
    },
    create: async (name: string, config: { Labels: Record<string, string>; Image: string }) => {
      helperImages.push(config.Image);
      const value = member(name, [], false);
      value.Config.Labels = config.Labels;
    },
    removeStopped: async (name: string) => {
      const value = await docker.inspect(name);
      if (value) containers.delete(value.Id!);
    },
    runCommand: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, integrity: "metadata-verified" }),
      stderr: "",
      truncated: false,
    }),
    runInputCommand: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, integrity: "metadata-verified" }),
      stderr: "",
      truncated: false,
    }),
    getArchiveStream: async () => Readable.from([Buffer.from("encrypted fixture tar")]),
    putArchiveStream: async (_a: string, _b: string, stream: Readable) => {
      for await (const _chunk of stream) {
        /* drain */
      }
    },
  };
  const guard = new RemedyGuard(new Set());
  const client = {
    authorizeApplicationBackup: async () => true,
    uploadApplicationBackup: async (_task: string, _artifact: string, stream: Readable) => {
      for await (const _chunk of stream) {
        /* drain */
      }
    },
    downloadApplicationBackup: async () => Readable.from([Buffer.from("encrypted fixture tar")]),
    reportApplicationBackup: async (result: ApplicationBackupResult) => {
      if (reportFails) throw new Error("lost response");
      results.push(result);
    },
  };
  const runtime = () =>
    new ApplicationBackups({
      docker: docker as unknown as DockerClient,
      guard,
      selfContainerName: "runner",
      protectedContainers: new Set(),
      dryRun: () => false,
      client,
      wait: async () => undefined,
      clock: () => (now += 3000),
    });
  const task: ApplicationBackupTask = {
    id: randomUUID(),
    planId: randomUUID(),
    hostId: randomUUID(),
    operation: "capture",
    artifactId: randomUUID(),
    recipient: "age1" + "a".repeat(60),
    definition: {
      version: 1,
      name: "fixture",
      containerName: "a",
      consistency: "coordinated-clean-stop",
      exclusiveDockerWriters: true,
      sqlite: null,
      intervalHours: null,
      retain: 3,
    },
    expiresAt: Date.now() + 60000,
  };
  return {
    bootImageIsGone: () => {
      bootImageGone = true;
    },
    removalFails: () => {
      removeFails = true;
    },
    runtime,
    docker,
    task,
    calls,
    helperImages,
    results,
    containers,
    volumes,
    guard,
    client,
    failStop: (id: string) => {
      stopFails = id;
    },
    failReport: (value: boolean) => {
      reportFails = value;
    },
  };
}
describe("application backups on a host reached over SSH", () => {
  const REFERENCE = "autoheal:dev-latest";
  const onHost = (f: ReturnType<typeof setup>, found: string | null) =>
    new ApplicationBackups({
      docker: f.docker as unknown as DockerClient,
      guard: f.guard,
      selfContainerName: "runner",
      protectedContainers: new Set(),
      dryRun: () => false,
      client: f.client,
      helperImage: imageOnHost({ inspectImage: async () => (found === null ? null : { Id: found }) }, REFERENCE),
    });

  it("without Autoheal's image there, refuses before recording or stopping anything, saying how to load it", async () => {
    const f = setup(),
      runtime = onHost(f, null);
    await runtime.initialize();
    const volumes = [...f.volumes.keys()];
    await runtime.run(f.task);
    expect(f.calls).toEqual([]);
    expect([...f.volumes.keys()]).toEqual(volumes);
    expect(f.results[0]).toMatchObject({
      ok: false,
      message: APPLICATION_HELPER_ERRORS.imageMissing(REFERENCE),
      stopped: [],
    });
    expect(runtime.isBlocked("a")).toBe(false);
  });

  it("with it there, copies in it, as a runner copies in its own image", async () => {
    const f = setup(),
      runtime = onHost(f, "sha256:loaded");
    await runtime.initialize();
    await runtime.run(f.task);
    expect(f.results.at(-1)).toMatchObject({ ok: true });
    expect(f.helperImages).toEqual(["sha256:loaded"]);
    expect(f.calls).toContain("stop:id-a");
  });
});

describe("application writer orchestration", () => {
  it("discovers transitive shared writers and compensates a partial stop without starting originally stopped members", async () => {
    const f = setup(),
      runtime = f.runtime();
    await runtime.initialize();
    expect((await runtime.discover("a")).members.map((m) => m.name)).toEqual(["a", "b", "c", "stopped"]);
    f.failStop("id-b");
    await runtime.run(f.task);
    expect(f.calls).toContain("start:id-a");
    expect(f.calls).not.toContain("start:id-stopped");
    expect(f.results.at(-1)).toMatchObject({ ok: false, stopped: ["b"] });
    expect(runtime.isBlocked("a")).toBe(true);
  });
  it("retries only a durable outcome after reconstruction, without executing capture again", async () => {
    const f = setup(),
      runtime = f.runtime();
    await runtime.initialize();
    f.failReport(true);
    await runtime.run(f.task);
    const stops = f.calls.filter((c) => c.startsWith("stop:")).length;
    expect(f.volumes.size).toBeGreaterThan(0);
    const restarted = f.runtime();
    await restarted.initialize();
    f.failReport(false);
    await restarted.run(f.task);
    expect(f.calls.filter((c) => c.startsWith("stop:")).length).toBe(stops);
    expect(f.results).toHaveLength(1);
    expect(f.results[0]).toMatchObject({ ok: true });
  });
  it("refuses changed reviewed resources before stopping any writer", async () => {
    const f = setup(),
      runtime = f.runtime();
    await runtime.initialize();
    await runtime.run({ ...f.task, operation: "restore", expectedFingerprint: "0".repeat(64) });
    expect(f.calls).toEqual([]);
    expect(f.results[0]).toMatchObject({ ok: false, stopped: [] });
  });
  it("keeps an interrupted restore block across reconstruction and blocks normal healing", async () => {
    const f = setup(),
      runtime = f.runtime();
    await runtime.initialize();
    await runtime.journal.save({
      version: 1,
      id: f.task.id,
      revision: 0,
      operation: "restore",
      artifactId: f.task.artifactId,
      phase: "restoring",
      members: [{ name: "a", id: "id-a", running: true }],
      blocked: true,
      result: null,
    });
    const restarted = f.runtime();
    await restarted.initialize();
    f.guard.externalRecoveryBlocked = (name, id) => restarted.isBlocked(name, id);
    expect(restarted.isBlocked("alias", "id-a")).toBe(true);
    expect(f.guard.claim("a")).toBe(false);
    await restarted.flush();
    expect(f.results[0]).toMatchObject({ ok: false, stopped: ["a"] });
    expect(restarted.isBlocked("a")).toBe(true);
  });
  it("refuses unlimited shutdown grace before stopping writers", async () => {
    const f = setup(),
      runtime = f.runtime();
    f.containers.get("id-a")!.Config.StopTimeout = -1;
    await runtime.initialize();
    await runtime.run(f.task);
    expect(f.calls).toEqual([]);
    expect(f.results[0]?.ok).toBe(false);
  });
  it("includes mount targets in the immutable coverage fingerprint", async () => {
    const f = setup(),
      runtime = f.runtime();
    await runtime.initialize();
    const before = (await runtime.discover("a")).fingerprint;
    f.containers.get("id-a")!.Mounts![0]!.Destination = "/different";
    expect((await runtime.discover("a")).fingerprint).not.toBe(before);
  });
  it("restores original Docker restart policies after successful capture", async () => {
    const f = setup(),
      runtime = f.runtime();
    f.containers.get("id-a")!.HostConfig!.RestartPolicy = { Name: "always", MaximumRetryCount: 0 };
    await runtime.initialize();
    await runtime.run(f.task);
    expect(f.results[0]).toMatchObject({ ok: true });
    expect(f.containers.get("id-a")!.HostConfig!.RestartPolicy?.Name).toBe("always");
  });
  it("settles a surviving task helper before restarting an original writer on resume", async () => {
    const f = setup(),
      runtime = f.runtime();
    await runtime.initialize();
    f.containers.get("id-a")!.State.Running = false;
    const helper = {
      Id: "surviving-helper",
      Name: "/surviving-helper",
      Image: "fixture",
      Config: { Image: "fixture", Labels: { "autoheal.application-backup.task": f.task.id } },
      HostConfig: {},
      State: { Running: true, ExitCode: 0 },
      Mounts: [],
    } as ContainerDetails;
    f.containers.set(helper.Id!, helper);
    await runtime.journal.save({
      version: 1,
      id: f.task.id,
      revision: 0,
      operation: "capture",
      artifactId: f.task.artifactId,
      phase: "stopping",
      members: [{ name: "a", id: "id-a", running: true }],
      blocked: true,
      result: null,
    });
    await runtime.run({ ...f.task, resume: true, attempt: 1 });
    expect(f.calls.indexOf("stop:surviving-helper")).toBeLessThan(f.calls.indexOf("start:id-a"));
    expect(f.containers.has("surviving-helper")).toBe(false);
  });
  it("keeps recovery blocked if the surviving helper cannot stop", async () => {
    const f = setup(),
      runtime = f.runtime();
    await runtime.initialize();
    f.containers.get("id-a")!.State.Running = false;
    const helper = {
      Id: "surviving-helper",
      Name: "/surviving-helper",
      Image: "fixture",
      Config: { Image: "fixture", Labels: { "autoheal.application-backup.task": f.task.id } },
      HostConfig: {},
      State: { Running: true, ExitCode: 0 },
      Mounts: [],
    } as ContainerDetails;
    f.containers.set(helper.Id!, helper);
    f.failStop("surviving-helper");
    await runtime.journal.save({
      version: 1,
      id: f.task.id,
      revision: 0,
      operation: "capture",
      artifactId: f.task.artifactId,
      phase: "stopping",
      members: [{ name: "a", id: "id-a", running: true }],
      blocked: true,
      result: null,
    });
    await runtime.run({ ...f.task, resume: true, attempt: 1 });
    expect(f.calls).not.toContain("start:id-a");
    expect(runtime.isBlocked("a")).toBe(true);
    expect(f.results.at(-1)).toMatchObject({ attempt: 1, recoveryRequired: true });
  });
  it("settles a source stream error without hanging or starting a second copy", async () => {
    const f = setup(),
      runtime = f.runtime();
    await runtime.initialize();
    f.docker.getArchiveStream = async () =>
      Readable.from(
        (async function* () {
          yield Buffer.from("partial");
          throw new Error("archive source failed");
        })(),
      );
    await runtime.run(f.task);
    expect(f.results.at(-1)).toMatchObject({ ok: false, stopped: [] });
    expect(f.containers.get("id-a")!.State.Running).toBe(true);
  });

  describe("a boot drill", () => {
    const IMAGE = "sha256:backed-up";
    const recipe = { readySeconds: 5, environment: [{ name: "APP_MODE", value: "test" }] };
    const bootTask = (fixture: ReturnType<typeof setup>): ApplicationBackupTask => ({
      ...fixture.task,
      operation: "boot-drill",
      identity: "AGE-SECRET-KEY-" + "A".repeat(50),
      imageId: IMAGE,
      definition: { ...fixture.task.definition, bootDrill: recipe },
    });
    const booted = async (fixture: ReturnType<typeof setup>) => {
      const app = fixture.runtime();
      await app.initialize();
      await app.run(bootTask(fixture));
      return fixture.results.at(-1)!;
    };

    it("starts the application on clones, says it did, leaves nothing, and touches nothing live", async () => {
      const fixture = setup();
      const liveBefore = [...fixture.volumes.keys()];
      const result = await booted(fixture);
      expect(result).toMatchObject({
        ok: true,
        message: APPLICATION_BOOT_TEXT.notProven,
        boot: { imageId: IMAGE, readiness: "stayed-running", problem: null, left: [] },
      });
      // A helper of its own is stopped; never one of the application's.
      expect(fixture.calls.filter((call) => /^stop:id-(a|b|c|stopped)$/.test(call))).toEqual([]);
      expect([...fixture.volumes.keys()]).toEqual(liveBefore);
      expect([...fixture.containers.keys()].some((name) => name.includes("boot-drill"))).toBe(false);
      for (const name of ["a", "b", "c", "runner"]) {
        expect((await fixture.docker.inspect(name))?.State.Running).toBe(true);
      }
    });

    it("fails clearly for an image no longer there, with the backup's data still restored and removed", async () => {
      const fixture = setup();
      fixture.bootImageIsGone();
      const result = await booted(fixture);
      expect(result.ok).toBe(false);
      expect(result.recoveryRequired).toBeUndefined();
      expect(result.message).toContain(APPLICATION_BOOT_TEXT.imageGone);
      expect(result.boot).toMatchObject({ readiness: null, left: [] });
    });

    it("fails clearly for a backup that will not restore, starting nothing", async () => {
      const fixture = setup();
      fixture.docker.runInputCommand = async () => ({
        exitCode: 1,
        stdout: JSON.stringify({ ok: false }),
        stderr: "not a valid backup",
        truncated: false,
      });
      fixture.docker.runCommand = fixture.docker.runInputCommand;
      const result = await booted(fixture);
      expect(result.ok).toBe(false);
      expect(result.integrity).toBeUndefined();
      expect(result.boot?.readiness).toBeNull();
    });

    it("names what it could not remove", async () => {
      const fixture = setup();
      fixture.removalFails();
      const result = await booted(fixture);
      expect(result.boot?.left.join()).toContain("boot-drill");
    });

    it("names and later sweeps its copy of the backup, as it does its clones", async () => {
      const fixture = setup();
      const removeVolume = fixture.docker.removeVolume;
      fixture.docker.removeVolume = async () => {
        throw new Error("in use");
      };
      const result = await booted(fixture);
      expect(result.boot?.left.join()).toContain("autoheal-application-download-");
      expect(result.boot?.left.join()).toContain("autoheal-application-drill-");
      fixture.docker.removeVolume = removeVolume;
      await fixture.runtime().initialize();
      const remaining = [...fixture.volumes.keys()].join();
      expect(remaining).not.toContain("autoheal-application-download-");
      expect(remaining).not.toContain("autoheal-application-drill-");
    });

    it("says it passed only on a health check", async () => {
      const fixture = setup();
      fixture.docker.create = (async (name: string, config: { Labels: Record<string, string> }) => {
        const value = {
          Id: `id-${name}`,
          Name: `/${name}`,
          Image: "image",
          Config: { Image: "fixture", Labels: config.Labels },
          HostConfig: {},
          Mounts: [],
          State: { Running: false, ExitCode: 0, Health: { Status: "healthy" } },
        } as unknown as ContainerDetails;
        fixture.containers.set(value.Id!, value);
      }) as never;
      const result = await booted(fixture);
      expect(result).toMatchObject({ ok: true, message: APPLICATION_BOOT_TEXT.passed, boot: { readiness: "healthy" } });
    });

    it("removes what a crash left of one when the runner starts", async () => {
      const fixture = setup();
      const leftover = await fixture.docker.create("autoheal-helper-boot-drill-old", {
        Labels: { [APPLICATION_BOOT_DRILL.label]: "old" },
        Image: IMAGE,
      });
      void leftover;
      fixture.volumes.set("autoheal-application-drill-old-0", {
        Name: "autoheal-application-drill-old-0",
        Labels: { [APPLICATION_BOOT_DRILL.volumeLabel]: "old" },
      });
      await fixture.runtime().initialize();
      expect(await fixture.docker.inspect("autoheal-helper-boot-drill-old")).toBeNull();
      expect(fixture.volumes.has("autoheal-application-drill-old-0")).toBe(false);
    });

    it("records the image a capture was made with", async () => {
      const fixture = setup();
      (await fixture.docker.inspect("a"))!.Image = IMAGE;
      const app = fixture.runtime();
      await app.initialize();
      await app.run(fixture.task);
      expect(fixture.results.at(-1)).toMatchObject({ ok: true, imageId: IMAGE });
    });
  });
});
