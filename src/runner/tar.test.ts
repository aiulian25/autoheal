import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { TAR } from "../shared/constants.js";
import { readFirstEntry, singleEntryArchive } from "./tar.js";

// Read back in small pieces, as a socket hands them over.
const streamOf = (archive: Buffer, pieceBytes = 100) =>
  Readable.from(
    Array.from({ length: Math.ceil(archive.length / pieceBytes) }, (_, index) =>
      archive.subarray(index * pieceBytes, (index + 1) * pieceBytes),
    ),
  );

const OWNER = { uid: 1000, gid: 1001 };

describe("the tar archives Docker's archive calls speak", () => {
  it("writes one file that tar itself unpacks, with its owner and mode, and reads it back", async () => {
    const content = Buffer.from("PAPERLESS_URL=https://docs.example.org\n");
    const archive = singleEntryArchive({ name: "paperless.env", type: TAR.types.file, mode: 0o640, ...OWNER }, content);

    expect(execFileSync("tar", ["-xOf", "-"], { input: archive }).toString()).toBe(content.toString());
    expect(execFileSync("tar", ["-tvf", "-", "--numeric-owner"], { input: archive }).toString()).toMatch(
      /^-rw-r----- 1000\/1001\s+39 .* paperless\.env\n$/u,
    );
    const entry = await readFirstEntry(streamOf(archive), 1024);
    expect(entry!.header).toMatchObject({ name: "paperless.env", type: "0", mode: 0o640, ...OWNER, size: 39 });
    expect(entry!.content!.toString()).toBe(content.toString());
  });

  it("names a long or non-ASCII entry in a PAX record, which a reader passes over", async () => {
    const name = `${"ä".repeat(60)}.txt`;
    const archive = singleEntryArchive({ name, type: TAR.types.file, mode: 0o644, ...OWNER }, Buffer.from("x"));

    expect(execFileSync("tar", ["-tf", "-"], { input: archive }).toString()).toBe(`${name}\n`);
    const entry = await readFirstEntry(streamOf(archive, 7), 1024);
    expect(entry!.header.size).toBe(1);
    expect(entry!.content!.toString()).toBe("x");
  });

  it("gives a folder's header, and a file past the limit without its content", async () => {
    const folder = singleEntryArchive(
      { name: "config", type: TAR.types.folder, mode: 0o755, ...OWNER },
      Buffer.alloc(0),
    );
    expect(execFileSync("tar", ["-tvf", "-"], { input: folder }).toString()).toMatch(/^drwxr-xr-x .* config\n$/u);
    expect((await readFirstEntry(streamOf(folder), 0))!.header).toMatchObject({ type: "5", ...OWNER });

    const big = singleEntryArchive({ name: "big", type: TAR.types.file, mode: 0o644, ...OWNER }, Buffer.alloc(5000));
    expect(await readFirstEntry(streamOf(big), 4096)).toMatchObject({ header: { size: 5000 }, content: null });
    expect(await readFirstEntry(streamOf(Buffer.alloc(1024)), 4096)).toBeNull();
  });
});
