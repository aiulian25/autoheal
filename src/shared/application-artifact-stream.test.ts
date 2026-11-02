import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { describe, expect, it } from "vitest";
import { singleEntryArchive } from "../runner/tar.js";
import { TAR } from "./constants.js";
import { APPLICATION_BACKUPS } from "./application-backups.js";
import { applicationArtifactStream } from "./application-artifact-stream.js";
const archive = () =>
  singleEntryArchive(
    { name: "payload.age", type: TAR.types.file, mode: 0o600, uid: 0, gid: 0 },
    Buffer.from("age-encryption.org/v1\nsynthetic encrypted bytes"),
  );
describe("application ciphertext archive boundary", () => {
  it("holds every header byte until validation, even with one-byte transport chunks", async () => {
    const value = archive();
    value[345] = 46;
    value.fill(32, 148, 156);
    let sum = 0;
    for (const byte of value.subarray(0, 512)) sum += byte;
    value.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    let exposed = 0;
    const validator = applicationArtifactStream();
    validator.on("data", (chunk) => {
      exposed += chunk.length;
    });
    await expect(pipeline(Readable.from([...value].map((byte) => Buffer.from([byte]))), validator)).rejects.toThrow(
      "single encrypted payload",
    );
    expect(exposed).toBe(0);
  });
  it("preserves a valid archive exactly across tiny header fragments", async () => {
    const value = archive();
    const parts: Buffer[] = [];
    const validator = applicationArtifactStream();
    validator.on("data", (chunk) => parts.push(Buffer.from(chunk)));
    await pipeline(Readable.from([...value].map((byte) => Buffer.from([byte]))), validator);
    expect(Buffer.concat(parts)).toEqual(value);
    expect(parts[0]!.length).toBe(544);
  });
  it("rejects oversized streams and unexpected trailing entries", async () => {
    const large = applicationArtifactStream();
    large.resume();
    await expect(pipeline(Readable.from([Buffer.alloc(APPLICATION_BACKUPS.payloadBytes + 1)]), large)).rejects.toThrow(
      "quota",
    );
    const extra = applicationArtifactStream();
    extra.resume();
    await expect(pipeline(Readable.from([archive(), Buffer.from("second entry")]), extra)).rejects.toThrow(
      "additional entries",
    );
  });
});
