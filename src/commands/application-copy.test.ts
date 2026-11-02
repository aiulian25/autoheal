import { mkdtemp, mkdir, writeFile, readFile, link, lstat, chmod, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { afterEach, describe, expect, it } from "vitest";
import { captureApplication, restoreApplication } from "./application-copy.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "autoheal-app-copy-"));
  roots.push(root);
  for (const name of ["source", "capture", "clone", "restore"]) await mkdir(join(root, name));
  const identity = await generateX25519Identity();
  return {
    root,
    identity,
    recipient: await identityToRecipient(identity),
    artifact: join(root, "payload.age"),
    program: "/usr/bin/rsync",
    coverage: "f".repeat(64),
  };
}
describe("encrypted application batch", () => {
  it("round trips hard links, root metadata and a fixed SQLite integrity drill without changing the source", async () => {
    const f = await fixture(),
      source = join(f.root, "source"),
      clone = join(f.root, "clone");
    await writeFile(join(source, "secret"), "synthetic-private-data");
    await link(join(source, "secret"), join(source, "linked"));
    await chmod(source, 0o750);
    const db = new Database(join(source, "app.sqlite"));
    db.exec("CREATE TABLE fixture(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO fixture VALUES(1,'original')");
    db.close();
    const before = await readFile(join(source, "app.sqlite"));
    await captureApplication({ mounts: [source], work: join(f.root, "capture"), ...f }, f.recipient);
    const encrypted = await readFile(f.artifact);
    expect(encrypted.toString()).not.toContain("synthetic-private-data");
    expect(encrypted.toString()).not.toContain("rsync-readable-posix");
    const result = await restoreApplication(
      { mounts: [clone], work: join(f.root, "restore"), ...f },
      f.identity,
      { mountTarget: "/data", path: "app.sqlite" },
      0,
    );
    expect(result.integrity).toBe("sqlite-integrity-ok");
    expect((await lstat(clone)).mode & 0o777).toBe(0o750);
    expect((await lstat(join(clone, "secret"))).ino).toBe((await lstat(join(clone, "linked"))).ino);
    expect(await readFile(join(source, "app.sqlite"))).toEqual(before);
  });
  it("rejects excess source size before publishing ciphertext", async () => {
    const f = await fixture();
    const file = join(f.root, "source", "large");
    await writeFile(file, "");
    await truncate(file, 32 * 1024 * 1024 + 1);
    await expect(
      captureApplication({ mounts: [join(f.root, "source")], work: join(f.root, "capture"), ...f }, f.recipient),
    ).rejects.toThrow("32 MiB");
    await expect(readFile(f.artifact)).rejects.toThrow();
  });
  it("authenticates the complete encrypted payload before changing an existing destination", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "source", "original"), "source");
    await captureApplication({ mounts: [join(f.root, "source")], work: join(f.root, "capture"), ...f }, f.recipient);
    const encrypted = await readFile(f.artifact);
    encrypted[encrypted.length - 1] ^= 1;
    await writeFile(f.artifact, encrypted);
    await writeFile(join(f.root, "clone", "untouched"), "keep");
    await expect(
      restoreApplication({ mounts: [join(f.root, "clone")], work: join(f.root, "restore"), ...f }, f.identity),
    ).rejects.toThrow();
    expect(await readFile(join(f.root, "clone", "untouched"), "utf8")).toBe("keep");
  });
  it("preserves supported root ACL and extended attributes", async () => {
    const f = await fixture(),
      source = join(f.root, "source"),
      clone = join(f.root, "clone");
    execFileSync("python3", ["-c", "import os,sys;os.setxattr(sys.argv[1],'user.fixture',b'value')", source]);
    execFileSync("setfacl", ["-m", "u:12345:r-x", source]);
    await captureApplication({ mounts: [source], work: join(f.root, "capture"), ...f }, f.recipient);
    await restoreApplication({ mounts: [clone], work: join(f.root, "restore"), ...f }, f.identity);
    const attrs = (path: string) =>
      execFileSync(
        "python3",
        [
          "-c",
          "import os,sys;print(sorted((n,os.getxattr(sys.argv[1],n).hex())for n in os.listxattr(sys.argv[1])))",
          path,
        ],
        { encoding: "utf8" },
      );
    expect(attrs(clone)).toBe(attrs(source));
  });
  it("refuses same-count mount remapping before touching destinations", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "source", "original"), "historical");
    await captureApplication({ mounts: [join(f.root, "source")], work: join(f.root, "capture"), ...f }, f.recipient);
    await writeFile(join(f.root, "clone", "untouched"), "present");
    await expect(
      restoreApplication(
        { mounts: [join(f.root, "clone")], work: join(f.root, "restore"), ...f, coverage: "0".repeat(64) },
        f.identity,
      ),
    ).rejects.toThrow("coverage changed");
    expect(await readFile(join(f.root, "clone", "untouched"), "utf8")).toBe("present");
  });
});
