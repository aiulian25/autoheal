import { describe, expect, it } from "vitest";
import type { ContainerSummary, DockerVolume } from "./docker-client.js";
import type { ContainerDetails } from "./incident-report.js";
import { CHECKPOINT } from "../shared/constants.js";
import { VolumeCheckpoints, RESTORE_OWNER_LABEL } from "./volume-checkpoints.js";

const TAKEN_AT = Date.UTC(2026, 9, 24, 3, 12);
const LIMIT = 2_000_000_000;
// Autoheal's image as the runner gives it to the helper.
const HELPER_IMAGE = "sha256:runner";
const OLD_ID = "a".repeat(64);

// Vaultwarden as compose runs it: its data volume and a bind mount written, its config read-only, Docker's
// socket, and a tmpfs.
const vaultwarden: ContainerDetails = {
  Id: OLD_ID,
  Name: "/vaultwarden",
  State: { Running: false },
  Config: { Image: "vaultwarden/server:latest" },
  Mounts: [
    {
      Type: "volume",
      Name: "vaultwarden-data",
      Source: "/var/lib/docker/volumes/vaultwarden-data/_data",
      Destination: "/data",
      RW: true,
    },
    { Type: "bind", Source: "/srv/vaultwarden/attachments", Destination: "/attachments", RW: true },
    { Type: "bind", Source: "/srv/vaultwarden/config.json", Destination: "/config.json", RW: false },
    { Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock", RW: true },
    { Type: "tmpfs", Destination: "/tmp", RW: true },
  ],
};

const report = (outcome: string, bytes = 0) =>
  JSON.stringify({ outcome, bytes, availableBytes: 9e10, reason: null, fidelity: CHECKPOINT.fidelity });

function fakeDocker(printed: string, existing: DockerVolume[] = []) {
  const calls: string[] = [];
  const created: Record<string, unknown>[] = [];
  const volumes = new Map(existing.map((volume) => [volume.Name, volume]));
  let output = printed;
  const docker = {
    inspect: async (name: string): Promise<ContainerDetails> =>
      name === "autoheal"
        ? ({
            Name: "/autoheal",
            Image: "sha256:runner",
            State: { Running: true },
            Config: { Image: "autoheal:2" },
          } satisfies ContainerDetails)
        : ({
            Name: `/${name}`,
            State: { Running: false },
            Config: { Image: "sha256:runner" },
          } satisfies ContainerDetails),
    containerSummaries: async (): Promise<ContainerSummary[]> => [],
    removeStopped: async () => {
      calls.push("remove previous helper");
    },
    create: async (name: string, specification: Record<string, unknown>) => {
      calls.push(`create ${name.replace(/[0-9a-f-]{36}$/, "…")}`);
      created.push(specification);
      return name;
    },
    start: async () => void calls.push("start helper"),
    logs: async () => output,
    remove: async () => void calls.push("remove helper"),
    createVolume: async (name: string, labels: Record<string, string>) => {
      calls.push(`create volume ${name}`);
      volumes.set(name, { Name: name, Labels: labels });
    },
    removeVolume: async (name: string) => {
      calls.push(`remove volume ${name}`);
      volumes.delete(name);
    },
    volumes: async (label: string) => {
      const [key, value] = label.split("=");
      return [...volumes.values()].filter((volume) => volume.Labels?.[key!] === value);
    },
  };
  return {
    docker,
    calls,
    created,
    volumes,
    setOutput: (text: string) => {
      output = text;
    },
  };
}

const checkpointsWith = (docker: ReturnType<typeof fakeDocker>["docker"], limitBytes = LIMIT) =>
  new VolumeCheckpoints({
    docker,
    helperImage: async () => HELPER_IMAGE,
    limitBytes,
    now: () => TAKEN_AT,
    sleep: async () => {},
  });

describe("VolumeCheckpoints", () => {
  it("publishes complete container/mount coverage only after a successful copy", async () => {
    const fake = fakeDocker(report("kept", 38_000_000));
    const taken = await checkpointsWith(fake.docker).take("vaultwarden", vaultwarden);
    expect(taken).toMatchObject({ containerId: OLD_ID, complete: true });
    expect(taken.mounts.map((mount) => mount.target)).toEqual(["/data", "/attachments"]);
    expect(taken.outcome).toContain("(2 mounts, 38 MB)");
    const manifest = [...fake.volumes.values()].find((volume) => volume.Labels?.[CHECKPOINT.manifestLabel]);
    expect(manifest).toBeDefined();
    expect(fake.calls.at(-1)).toBe(`create volume ${manifest!.Name}`);
    expect(fake.calls.indexOf("remove helper")).toBeLessThan(fake.calls.length - 1);
    expect(JSON.parse(manifest!.Labels![CHECKPOINT.manifestLabel]!)).toMatchObject({
      version: 2,
      fidelity: CHECKPOINT.fidelity,
      mounts: [
        { type: "volume", source: "vaultwarden-data", target: "/data" },
        { type: "bind", source: "/srv/vaultwarden/attachments", target: "/attachments" },
      ],
    });
    expect(fake.created[0]).toMatchObject({
      Image: "sha256:runner",
      Cmd: ["volume-copy", "keep", String(LIMIT)],
      User: "0",
      NetworkDisabled: true,
      HostConfig: {
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        CapAdd: ["CHOWN", "DAC_OVERRIDE", "DAC_READ_SEARCH", "FOWNER"],
        NetworkMode: "none",
      },
    });
    const mounts = (fake.created[0]!.HostConfig as { Mounts: { ReadOnly: boolean; Source: string }[] }).Mounts;
    expect(mounts.map((mount) => mount.ReadOnly)).toEqual([true, false, true, false]);
    expect(mounts[0]!.Source).toBe("vaultwarden-data");
  });

  it.each(["too_big", "no_room", "failed", "garbled"])(
    "returns incomplete coverage and cleans up after %s",
    async (outcome) => {
      const fake = fakeDocker(outcome === "garbled" ? "Segmentation fault" : report(outcome, LIMIT + 1));
      const result = await checkpointsWith(fake.docker).take("vaultwarden", vaultwarden);
      expect(result).toMatchObject({ complete: false, containerId: OLD_ID });
      expect(result.mounts).toHaveLength(2);
      expect(result.outcome).toContain("Rolling back is blocked");
      expect(fake.volumes.size).toBe(0);
    },
  );

  it("rejects a successful-looking helper report without the verified fidelity contract", async () => {
    const fake = fakeDocker(JSON.stringify({ outcome: "kept", bytes: 1, availableBytes: 9e10, reason: null }));
    expect((await checkpointsWith(fake.docker).take("vaultwarden", vaultwarden)).complete).toBe(false);
    expect(fake.volumes.size).toBe(0);
  });

  it.each(["legacy-version", "missing-fidelity", "wrong-fidelity"])(
    "retains but refuses %s manifests before mutation",
    async (failure) => {
      const fake = fakeDocker(report("kept"));
      const checkpoints = checkpointsWith(fake.docker);
      await checkpoints.take("vaultwarden", vaultwarden);
      const manifest = [...fake.volumes.values()].find((volume) => volume.Labels?.[CHECKPOINT.manifestLabel])!;
      const value = JSON.parse(manifest.Labels![CHECKPOINT.manifestLabel]!);
      if (failure === "legacy-version") value.version = 1;
      if (failure === "missing-fidelity") delete value.fidelity;
      if (failure === "wrong-fidelity") value.fidelity = "unknown";
      manifest.Labels![CHECKPOINT.manifestLabel] = JSON.stringify(value);
      const before = [...fake.calls];
      expect((await checkpoints.verify("vaultwarden", vaultwarden)).problem).not.toBeNull();
      expect((await checkpoints.restore("vaultwarden", vaultwarden)).problem).not.toBeNull();
      expect(fake.calls).toEqual(before);
      expect(fake.volumes.size).toBe(3);
    },
  );

  it("does not accept a restored report from an older helper without fidelity evidence", async () => {
    const fake = fakeDocker(report("kept"));
    const checkpoints = checkpointsWith(fake.docker);
    await checkpoints.take("vaultwarden", vaultwarden);
    fake.setOutput(JSON.stringify({ outcome: "restored", bytes: 0, availableBytes: 0, reason: null }));
    expect((await checkpoints.restore("vaultwarden", vaultwarden)).problem).not.toBeNull();
  });

  it("handles a thrown copy failure and disabled checkpoints without declaring success", async () => {
    const fake = fakeDocker(report("kept"));
    fake.docker.logs = async () => {
      throw new Error("copy failed");
    };
    expect((await checkpointsWith(fake.docker).take("vaultwarden", vaultwarden)).complete).toBe(false);
    expect(fake.volumes.size).toBe(0);
    expect((await checkpointsWith(fake.docker, 0).take("vaultwarden", vaultwarden)).complete).toBe(false);
    expect((await checkpointsWith(fake.docker, 0).take("whoami", { ...vaultwarden, Mounts: [] })).complete).toBe(true);
  });

  it("does not publish a usable checkpoint when manifest creation fails", async () => {
    const fake = fakeDocker(report("kept"));
    const create = fake.docker.createVolume;
    fake.docker.createVolume = async (name, labels) => {
      if (labels[CHECKPOINT.manifestLabel]) {
        throw new Error("manifest write failed");
      }
      return create(name, labels);
    };
    const result = await checkpointsWith(fake.docker).take("vaultwarden", vaultwarden);
    expect(result.complete).toBe(false);
    expect(fake.volumes.size).toBe(0);
  });

  it("does not mistake a writable mount without a source identity for a stateless container", async () => {
    const fake = fakeDocker(report("kept"));
    const details = { ...vaultwarden, Mounts: [{ Type: "volume", Destination: "/data", RW: true }] };
    expect((await checkpointsWith(fake.docker).take("vaultwarden", details)).complete).toBe(false);
    expect((await checkpointsWith(fake.docker).verify("vaultwarden", details)).problem).not.toBeNull();
    expect(fake.created).toEqual([]);
  });

  it("uses a new generation even when the clock has not advanced", async () => {
    const fake = fakeDocker(report("kept"));
    const checkpoints = checkpointsWith(fake.docker);
    await checkpoints.take("vaultwarden", vaultwarden);
    const first = [...fake.volumes.keys()];
    await checkpoints.take("vaultwarden", vaultwarden);
    expect([...fake.volumes.keys()].every((name) => !first.includes(name))).toBe(true);
    expect(first.every((name) => fake.calls.includes(`remove volume ${name}`))).toBe(true);
  });

  it("preflights without mutation and restores the complete original mount set", async () => {
    const fake = fakeDocker(report("kept", 13));
    const checkpoints = checkpointsWith(fake.docker);
    expect((await checkpoints.take("vaultwarden", vaultwarden)).outcome).toContain("1 kB");
    const before = [...fake.calls];
    expect(await checkpoints.verify("vaultwarden", vaultwarden)).toEqual({ at: TAKEN_AT, problem: null });
    expect(fake.calls).toEqual(before);
    fake.setOutput(report("restored"));
    expect(await checkpoints.restore("vaultwarden", vaultwarden)).toEqual({ at: TAKEN_AT, problem: null });
    expect(fake.created[1]).toMatchObject({ Cmd: ["volume-copy", "restore"] });
    const mounts = (fake.created[1]!.HostConfig as { Mounts: { Source: string }[] }).Mounts;
    expect(mounts[1]!.Source).toBe("vaultwarden-data");
    expect(mounts[3]!.Source).toBe("/srv/vaultwarden/attachments");
  });

  it.each(["missing", "partial", "manifest", "identity", "source", "timestamp", "duplicate", "garbled", "legacy"])(
    "refuses %s checkpoints before any restore helper starts",
    async (failure) => {
      const fake = fakeDocker(report("kept"));
      const checkpoints = checkpointsWith(fake.docker);
      await checkpoints.take("vaultwarden", vaultwarden);
      const manifest = [...fake.volumes.values()].find((volume) => volume.Labels?.[CHECKPOINT.manifestLabel])!;
      const data = [...fake.volumes.values()].find((volume) => volume.Labels?.[CHECKPOINT.targetLabel] === "/data")!;
      let details = structuredClone(vaultwarden);
      if (failure === "missing") {
        fake.volumes.clear();
      }
      if (failure === "partial") {
        fake.volumes.delete(data.Name);
      }
      if (failure === "manifest" || failure === "legacy") {
        fake.volumes.delete(manifest.Name);
      }
      if (failure === "identity") {
        details.Id = "another-container";
      }
      if (failure === "source") {
        details.Mounts![0]!.Name = "another-volume";
      }
      if (failure === "timestamp") {
        data.Labels![CHECKPOINT.takenAtLabel] = "1";
      }
      if (failure === "garbled") {
        manifest.Labels![CHECKPOINT.manifestLabel] = "not json";
      }
      if (failure === "duplicate") {
        const parsed = JSON.parse(manifest.Labels![CHECKPOINT.manifestLabel]!);
        parsed.mounts[1] = parsed.mounts[0];
        manifest.Labels![CHECKPOINT.manifestLabel] = JSON.stringify(parsed);
      }
      const count = fake.created.length;
      expect((await checkpoints.verify("vaultwarden", details)).problem).not.toBeNull();
      expect((await checkpoints.restore("vaultwarden", details)).problem).not.toBeNull();
      expect(fake.created).toHaveLength(count);
    },
  );

  it("refuses a checkpoint deleted after a successful preflight", async () => {
    const fake = fakeDocker(report("kept"));
    const checkpoints = checkpointsWith(fake.docker);
    await checkpoints.take("vaultwarden", vaultwarden);
    expect((await checkpoints.verify("vaultwarden", vaultwarden)).problem).toBeNull();
    fake.volumes.clear();
    expect((await checkpoints.restore("vaultwarden", vaultwarden)).problem).not.toBeNull();
  });

  it("waits for an interrupted restore helper to exit before starting a new copy", async () => {
    const fake = fakeDocker(report("kept"));
    await checkpointsWith(fake.docker).take("vaultwarden", vaultwarden);
    fake.setOutput(report("restored"));
    let oldReads = 0;
    const inspect = fake.docker.inspect;
    fake.docker.inspect = async (name) =>
      name === "previous-helper"
        ? {
            Name: "/previous-helper",
            State: { Running: oldReads++ === 0 },
            Config: { Image: "runner" },
          }
        : inspect(name);
    fake.docker.containerSummaries = async () => [
      {
        Id: "previous-helper",
        Names: ["/previous-helper"],
        State: "running",
        Status: "Up",
        Labels: { [RESTORE_OWNER_LABEL]: OLD_ID },
      },
    ];
    const create = fake.docker.create;
    fake.docker.create = async (name, specification) => {
      expect(oldReads).toBeGreaterThanOrEqual(2);
      return create(name, specification);
    };
    expect((await checkpointsWith(fake.docker).restore("vaultwarden", vaultwarden)).problem).toBeNull();
    expect(fake.created[1]!.Labels).toMatchObject({ [RESTORE_OWNER_LABEL]: OLD_ID });
    expect(fake.calls.indexOf("remove previous helper")).toBeLessThan(fake.calls.lastIndexOf("start helper"));
  });

  it("does not start the restore helper if a source disappears while its mounts are attached", async () => {
    const fake = fakeDocker(report("kept"));
    const checkpoints = checkpointsWith(fake.docker);
    await checkpoints.take("vaultwarden", vaultwarden);
    const create = fake.docker.create;
    fake.docker.create = async (name, specification) => {
      const result = await create(name, specification);
      fake.volumes.clear();
      return result;
    };
    fake.calls.length = 0;
    expect((await checkpoints.restore("vaultwarden", vaultwarden)).problem).not.toBeNull();
    expect(fake.calls).not.toContain("start helper");
    expect(fake.calls.at(-1)).toBe("remove helper");
  });
});
