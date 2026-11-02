import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { TAR, VOLUME_LOOK } from "../shared/constants.js";
import type { DockerClient } from "./docker-client.js";
import { singleEntryArchive } from "./tar.js";
import { listArchive, lookInsideVolume } from "./volume-look.js";

const entry = (name: string, type: string, content = Buffer.alloc(0)) =>
  singleEntryArchive({ name, type, mode: 0o644, uid: 0, gid: 0 }, content);
const END = Buffer.alloc(1024);
const LONG = `autoheal-look/${"folder/".repeat(30)}last.txt`;
const archive = Buffer.concat([
  entry("autoheal-look/", "5"),
  entry("autoheal-look/sub/", "5"),
  entry("autoheal-look/sub/a.txt", "0", Buffer.from("hello")),
  entry("autoheal-look/big.bin", "0", Buffer.alloc(3000)),
  entry(LONG, "0", Buffer.from("x")),
  END,
]);
// Each byte on its own: nothing may rely on how a stream happens to be cut.
const dripped = (bytes: Buffer) => Readable.from([...bytes].map((byte) => Buffer.from([byte])));

describe("reading names from an archive", () => {
  it("lists what is inside, without the folder itself, skipping contents and however it is cut", async () => {
    const { entries, partial } = await listArchive(dripped(archive));

    expect(partial).toBe(false);
    expect(entries.map(({ path, folder, sizeBytes }) => [path, folder, sizeBytes])).toEqual([
      ["sub", true, 0],
      ["sub/a.txt", false, 5],
      ["big.bin", false, 3000],
      [LONG.slice("autoheal-look/".length), false, 1],
    ]);
  });

  it("reads a long path split between the two parts of its header", async () => {
    const split = entry("inner.txt", "0", Buffer.from("x"));
    split.write("autoheal-look/a-long-folder", TAR.fields.prefix.offset, "ascii");

    const { entries } = await listArchive(Readable.from([Buffer.concat([split, END])]));

    expect(entries.map(({ path }) => path)).toEqual(["a-long-folder/inner.txt"]);
  });

  it("stops at its limit and says so, closing the stream", async () => {
    const many = Buffer.concat([
      ...Array.from({ length: VOLUME_LOOK.entries + 50 }, (_, index) => entry(`autoheal-look/${index}`, "0")),
      END,
    ]);
    const stream = Readable.from([many]);

    const { entries, partial } = await listArchive(stream);

    expect(entries).toHaveLength(VOLUME_LOOK.entries);
    expect(partial).toBe(true);
    expect(stream.destroyed).toBe(true);
  });
});

describe("looking inside a volume", () => {
  const docker = (overrides: Partial<Record<keyof DockerClient, unknown>> = {}) => {
    const fake = {
      inspectVolume: vi.fn(async () => ({ Name: "data" })),
      images: vi.fn(async () => [
        { Id: "sha256:big", Size: 900 },
        { Id: "sha256:declares-volumes", Size: 1 },
        { Id: "sha256:small", Size: 50 },
      ]),
      inspectImage: vi.fn(async (id: string) => ({
        Id: id,
        Config: id.includes("declares") ? { Volumes: { "/data": {} } } : {},
      })),
      create: vi.fn(async () => "helper"),
      remove: vi.fn(async () => undefined),
      getArchiveStream: vi.fn(async () => Readable.from([archive])),
      ...overrides,
    };
    return fake as typeof fake & Parameters<typeof lookInsideVolume>[0];
  };
  const open = { containerAccess: true, dryRun: false };

  it("reads through a read-only container that never starts, on an image declaring no volumes, then removes it", async () => {
    const fake = docker();

    const answer = await lookInsideVolume(fake, open, "data");

    expect(answer.error).toBeNull();
    expect(answer.entries.map(({ path }) => path)).toContain("sub/a.txt");
    const [name, specification] = vi.mocked(fake.create).mock.calls[0]!;
    expect(specification).toMatchObject({
      Image: "sha256:small",
      NetworkDisabled: true,
      HostConfig: {
        NetworkMode: "none",
        Mounts: [{ Type: "volume", Source: "data", Target: VOLUME_LOOK.target, ReadOnly: true }],
      },
    });
    expect(fake.remove).toHaveBeenCalledWith(name);
    expect("start" in fake).toBe(false);
  });

  it("removes its container even when reading fails, and says why", async () => {
    const fake = docker({ getArchiveStream: vi.fn(async () => Promise.reject(new Error("Docker answered HTTP 500"))) });

    expect((await lookInsideVolume(fake, open, "data")).error).toBe("Docker answered HTTP 500");
    expect(fake.remove).toHaveBeenCalledTimes(1);
  });

  it("refuses where it may not reach inside, where it only watches, and with no image to borrow", async () => {
    const fake = docker();
    expect((await lookInsideVolume(fake, { containerAccess: false, dryRun: false }, "data")).error).toBe(
      VOLUME_LOOK.errors.accessOff,
    );
    expect((await lookInsideVolume(fake, { containerAccess: true, dryRun: true }, "data")).error).toBe(
      VOLUME_LOOK.errors.watching,
    );
    expect(fake.create).not.toHaveBeenCalled();
    expect((await lookInsideVolume(docker({ images: vi.fn(async () => []) }), open, "data")).error).toBe(
      VOLUME_LOOK.errors.noImage,
    );
    expect((await lookInsideVolume(docker({ inspectVolume: vi.fn(async () => null) }), open, "data")).error).toBe(
      VOLUME_LOOK.errors.gone,
    );
  });
});
