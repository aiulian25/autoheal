import {
  chmodSync,
  lstatSync,
  linkSync,
  unlinkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runVolumeCopy } from "./volume-copy.js";

const MODE_BITS = 0o7777;
const KEPT_AT = new Date(Date.UTC(2026, 9, 24, 3, 12));

describe("volume-copy", () => {
  let root: string;
  const at = (...parts: string[]) => join(root, ...parts);
  const modeOf = (path: string) => lstatSync(path).mode & MODE_BITS;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "autoheal-volume-copy-"));
    mkdirSync(at("from"));
    mkdirSync(at("to"));
  });

  // A folder made read-only by a test is opened up again, so it can be removed.
  afterEach(() => {
    const openUp = (path: string) => {
      if (lstatSync(path).isDirectory()) {
        chmodSync(path, 0o700);
        readdirSync(path).forEach((entry) => openUp(join(path, entry)));
      }
    };
    openUp(root);
    rmSync(root, { recursive: true, force: true });
  });

  async function run(
    commandArguments: string[],
    roots = { from: at("from"), to: at("to") },
    program = "/usr/bin/rsync",
  ) {
    const printed: string[] = [];
    const output = { log: (line: string) => printed.push(line), error: (line: string) => printed.push(line) };
    const code = await runVolumeCopy(commandArguments, output, roots, program);
    return { code, printed: printed.at(-1) ?? "" };
  }

  it("keeps each mount: files with their mode and times, folders, links, a read-only folder, a single file", async () => {
    mkdirSync(at("from", "0", "config"), { recursive: true });
    writeFileSync(at("from", "0", "state.db"), "v1");
    chmodSync(at("from", "0", "state.db"), 0o640);
    utimesSync(at("from", "0", "state.db"), KEPT_AT, KEPT_AT);
    writeFileSync(at("from", "0", "config", "app.yml"), "port: 8080\n");
    chmodSync(at("from", "0", "config"), 0o750);
    symlinkSync("state.db", at("from", "0", "latest"));
    mkdirSync(at("from", "0", "locked"));
    writeFileSync(at("from", "0", "locked", "inside"), "sealed");
    chmodSync(at("from", "0", "locked"), 0o500);
    // A mount of one file: Traefik's acme.json, say.
    writeFileSync(at("from", "1"), '{"certificates":[]}');
    chmodSync(at("from", "1"), 0o600);
    mkdirSync(at("to", "0"));
    mkdirSync(at("to", "1"));

    const { code, printed } = await run(["keep", "1000000"]);
    expect(code).toBe(0);
    expect(JSON.parse(printed)).toMatchObject({ outcome: "kept", bytes: 2 + 11 + 6 + 19, reason: null });
    expect(lstatSync(at("to", "0", "state.db")).atime).toEqual(KEPT_AT);
    expect(readFileSync(at("to", "0", "state.db"), "utf8")).toBe("v1");
    expect(modeOf(at("to", "0", "state.db"))).toBe(0o640);
    expect(lstatSync(at("to", "0", "state.db")).mtime).toEqual(KEPT_AT);
    expect(readFileSync(at("to", "0", "config", "app.yml"), "utf8")).toBe("port: 8080\n");
    expect(modeOf(at("to", "0", "config"))).toBe(0o750);
    expect(readlinkSync(at("to", "0", "latest"))).toBe("state.db");
    expect(readFileSync(at("to", "0", "locked", "inside"), "utf8")).toBe("sealed");
    expect(modeOf(at("to", "0", "locked"))).toBe(0o500);
    expect(readFileSync(at("to", "1", "file"), "utf8")).toBe('{"certificates":[]}');
    expect(modeOf(at("to", "1", "file"))).toBe(0o600);
  });

  it("preserves hard links and the mount root mode through keep and restore", async () => {
    mkdirSync(at("from", "0"));
    mkdirSync(at("to", "0"));
    writeFileSync(at("from", "0", "first"), "original");
    linkSync(at("from", "0", "first"), at("from", "0", "second"));
    writeFileSync(at("from", "0", "third"), "original");
    chmodSync(at("from", "0"), 0o750);
    expect((await run(["keep", "10000"])).code).toBe(0);
    expect(lstatSync(at("to", "0", "first")).ino).toBe(lstatSync(at("to", "0", "second")).ino);
    expect(modeOf(at("to", "0"))).toBe(0o750);
    const keptRoot = lstatSync(at("to", "0"));
    unlinkSync(at("from", "0", "second"));
    writeFileSync(at("from", "0", "second"), "separate new schema");
    writeFileSync(at("from", "0", "extra"), "new");
    unlinkSync(at("from", "0", "third"));
    linkSync(at("from", "0", "first"), at("from", "0", "third"));
    chmodSync(at("from", "0"), 0o700);
    expect((await run(["restore"], { from: at("to"), to: at("from") })).code).toBe(0);
    expect(lstatSync(at("from", "0", "first")).ino).toBe(lstatSync(at("from", "0", "second")).ino);
    expect(readFileSync(at("from", "0", "second"), "utf8")).toBe("original");
    expect(readdirSync(at("from", "0"))).toEqual(["first", "second", "third"]);
    expect(lstatSync(at("from", "0", "third")).ino).not.toBe(lstatSync(at("from", "0", "first")).ino);
    expect(modeOf(at("from", "0"))).toBe(0o750);
    expect(lstatSync(at("from", "0")).uid).toBe(keptRoot.uid);
    expect(lstatSync(at("from", "0")).gid).toBe(keptRoot.gid);
    expect(lstatSync(at("from", "0")).mtimeMs).toBeCloseTo(keptRoot.mtimeMs, 2);
  });

  it("copies nothing past its limit", async () => {
    mkdirSync(at("from", "0"));
    writeFileSync(at("from", "0", "photos.tar"), "x".repeat(100));
    mkdirSync(at("to", "0"));
    const { code, printed } = await run(["keep", "10"]);
    expect(code).toBe(0);
    expect(JSON.parse(printed)).toMatchObject({ outcome: "too_big" });
    expect(readdirSync(at("to", "0"))).toEqual([]);
  });

  it("puts the kept data back in place of what is there, and a single file back where it is", async () => {
    mkdirSync(at("from", "0", "db"), { recursive: true });
    writeFileSync(at("from", "0", "db", "state"), "v1");
    mkdirSync(at("from", "1"));
    writeFileSync(at("from", "1", "file"), "acme v1");
    mkdirSync(at("to", "0", "db"), { recursive: true });
    writeFileSync(at("to", "0", "db", "state"), "migrated");
    writeFileSync(at("to", "0", "written-by-the-new-version"), "new");
    writeFileSync(at("to", "1"), "acme migrated");
    const inode = lstatSync(at("to", "1")).ino;

    const { code, printed } = await run(["restore"]);
    expect(code).toBe(0);
    expect(JSON.parse(printed)).toMatchObject({ outcome: "restored", reason: null });
    expect(readdirSync(at("to", "0"))).toEqual(["db"]);
    expect(readFileSync(at("to", "0", "db", "state"), "utf8")).toBe("v1");
    // Written over where it is: the container's mount of that one file still sees it.
    expect(readFileSync(at("to", "1"), "utf8")).toBe("acme v1");
    expect(lstatSync(at("to", "1")).ino).toBe(inode);
  });

  it("refuses an unavailable tool before touching restore data", async () => {
    mkdirSync(at("from", "0"));
    writeFileSync(at("from", "0", "state"), "old");
    mkdirSync(at("to", "0"));
    writeFileSync(at("to", "0", "state"), "current");
    const result = await run(["restore"], undefined, at("missing-rsync"));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.printed).fidelity).toBeUndefined();
    expect(readFileSync(at("to", "0", "state"), "utf8")).toBe("current");
  });

  it("refuses external hard links, including single-file mounts, before copying", async () => {
    mkdirSync(at("from", "0"));
    mkdirSync(at("to", "0"));
    writeFileSync(at("from", "0", "inside"), "original");
    linkSync(at("from", "0", "inside"), at("outside"));
    const result = await run(["keep", "10000"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.printed).reason).toContain("hard-link group extends outside");
    expect(readdirSync(at("to", "0"))).toEqual([]);
    rmSync(at("from", "0"), { recursive: true });
    linkSync(at("outside"), at("from", "0"));
    expect((await run(["keep", "10000"])).code).toBe(1);
  });

  it("refuses restore into an external hard-link group before overwriting shared data", async () => {
    mkdirSync(at("from", "0"));
    mkdirSync(at("to", "0"));
    writeFileSync(at("from", "0", "state"), "old");
    writeFileSync(at("to", "0", "state"), "current");
    linkSync(at("to", "0", "state"), at("outside"));
    expect((await run(["restore"])).code).toBe(1);
    expect(readFileSync(at("outside"), "utf8")).toBe("current");
    expect(readFileSync(at("to", "0", "state"), "utf8")).toBe("current");
  });

  it("refuses special files before copying any mount", async () => {
    mkdirSync(at("from", "0"));
    mkdirSync(at("to", "0"));
    writeFileSync(at("from", "0", "state"), "old");
    mkdirSync(at("from", "1"));
    mkdirSync(at("to", "1"));
    execFileSync("mkfifo", [at("from", "1", "pipe")]);
    expect((await run(["keep", "10000"])).code).toBe(1);
    expect(readdirSync(at("to", "0"))).toEqual([]);
  });

  it("leaves out a mount that is itself a socket, pipe or link, the host's plumbing, keeping the rest", async () => {
    mkdirSync(at("from", "0"));
    mkdirSync(at("to", "0"));
    writeFileSync(at("from", "0", "state"), "old");
    execFileSync("mkfifo", [at("from", "1")]);
    mkdirSync(at("to", "1"));
    symlinkSync(at("from", "0", "state"), at("from", "2"));
    mkdirSync(at("to", "2"));

    const kept = await run(["keep", "10000"]);

    expect(kept.code).toBe(0);
    expect(JSON.parse(kept.printed).outcome).toBe("kept");
    expect(readFileSync(at("to", "0", "state"), "utf8")).toBe("old");
    expect(readdirSync(at("to", "1"))).toEqual([]);

    // Put back the other way round: the plumbing is passed over again, and the data comes back.
    writeFileSync(at("from", "0", "state"), "new");
    const back = await run(["restore"], { from: at("to"), to: at("from") });
    expect(back.code).toBe(0);
    expect(readFileSync(at("from", "0", "state"), "utf8")).toBe("old");
  });

  it("reads contents only to compare them on a restore, never to fill an empty checkpoint", async () => {
    mkdirSync(at("from", "0"));
    mkdirSync(at("to", "0"));
    writeFileSync(at("from", "0", "state"), "old");
    writeFileSync(at("to", "0", "state"), "new");
    const tool = at("fake-recording");
    const calls = at("calls");
    writeFileSync(
      tool,
      `#!/bin/sh
case "$1" in
--version) printf 'rsync  version 3.4.1\nCapabilities: ACLs xattrs hardlinks hardlink-symlinks symtimes atimes\n';;
*) echo "$*" >> "${calls}";;
esac
`,
    );
    chmodSync(tool, 0o700);

    expect((await run(["keep", "10000"], undefined, tool)).code).toBe(0);
    const kept = readFileSync(calls, "utf8").trim().split("\n");
    expect(kept).toHaveLength(2);
    expect(kept.every((call) => !call.includes("--checksum"))).toBe(true);

    rmSync(calls);
    expect((await run(["restore"], undefined, tool)).code).toBe(0);
    expect(
      readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .every((call) => call.includes("--checksum")),
    ).toBe(true);
  });

  it("treats tool warnings and verification differences as failures without printing their private diagnostics", async () => {
    mkdirSync(at("from", "0"));
    mkdirSync(at("to", "0"));
    writeFileSync(at("from", "0", "state"), "old");
    for (const mode of ["warning", "difference"]) {
      const tool = at(`fake-${mode}`);
      writeFileSync(
        tool,
        `#!/bin/sh
case "$1" in
--version) printf 'rsync  version 3.4.1\nCapabilities: ACLs xattrs hardlinks hardlink-symlinks symtimes atimes\n';;
*) ${mode === "warning" ? "printf 'private-file-secret' >&2" : "printf 'different'"};;
esac
`,
      );
      chmodSync(tool, 0o700);
      const result = await run(["keep", "10000"], undefined, tool);
      expect(result.code).toBe(1);
      expect(result.printed).not.toContain("private-file-secret");
      expect(JSON.parse(result.printed).fidelity).toBeUndefined();
    }
  });

  it("round-trips file/root xattrs and ACLs and removes metadata added by the replacement", async (context) => {
    mkdirSync(at("from", "0"));
    mkdirSync(at("to", "0"));
    writeFileSync(at("from", "0", "state"), "old");
    const py = (code: string, ...args: string[]) =>
      execFileSync("python3", ["-c", code, ...args], { encoding: "utf8" }).trim();
    const attributes = (path: string) =>
      JSON.parse(
        py(
          "import os,sys,json; print(json.dumps({k:os.getxattr(sys.argv[1],k).hex() for k in os.listxattr(sys.argv[1])}))",
          path,
        ),
      );
    const acl = (path: string) =>
      execFileSync("getfacl", ["--omit-header", "--numeric", "--absolute-names", path], { encoding: "utf8" });
    try {
      py("import os,sys; os.setxattr(sys.argv[1],'user.autoheal',b'old')", at("from", "0"));
      py("import os,sys; os.setxattr(sys.argv[1],'user.binary',bytes([0,255,10]))", at("from", "0", "state"));
      execFileSync("setfacl", ["-m", "u:12345:r-x,d:u:12345:r-x", at("from", "0")]);
      execFileSync("setfacl", ["-m", "u::r--,u:12345:r--,g::---,m::r--,o::---", at("from", "0", "state")]);
    } catch (error) {
      context.skip(`xattr/ACL fixture unavailable on this filesystem or test host: ${String(error)}`);
    }
    const rootAttrs = attributes(at("from", "0"));
    const fileAttrs = attributes(at("from", "0", "state"));
    const rootACL = acl(at("from", "0"));
    const fileACL = acl(at("from", "0", "state"));
    expect((await run(["keep", "10000"])).code).toBe(0);
    expect(attributes(at("to", "0"))).toEqual(rootAttrs);
    expect(attributes(at("to", "0", "state"))).toEqual(fileAttrs);
    chmodSync(at("from", "0", "state"), 0o600);
    for (const path of [at("from", "0"), at("from", "0", "state")])
      py("import os,sys; os.setxattr(sys.argv[1],'user.added',b'new')", path);
    execFileSync("setfacl", ["-b", at("from", "0", "state")]);
    execFileSync("setfacl", ["-k", at("from", "0")]);
    chmodSync(at("from", "0", "state"), 0o600);
    writeFileSync(at("from", "0", "state"), "new");
    expect((await run(["restore"], { from: at("to"), to: at("from") })).code).toBe(0);
    expect(attributes(at("from", "0"))).toEqual(rootAttrs);
    expect(attributes(at("from", "0", "state"))).toEqual(fileAttrs);
    expect(acl(at("from", "0"))).toBe(rootACL);
    expect(acl(at("from", "0", "state"))).toBe(fileACL);
    expect(readFileSync(at("from", "0", "state"), "utf8")).toBe("old");
    if (process.getuid?.() !== 0) {
      expect(() => writeFileSync(at("from", "0", "state"), "denied")).toThrow(
        expect.objectContaining({ code: "EACCES" }),
      );
    } else {
      execFileSync(
        "python3",
        [
          "-c",
          "import os; os.setgroups([]); os.setgid(12345); os.setuid(12345); assert open('state').read() == 'old';\ntry: open('state','w'); raise AssertionError('write was allowed')\nexcept PermissionError: pass",
        ],
        { cwd: at("from", "0") },
      );
    }
  });

  it("removes extra xattrs on a single-file mount without replacing its inode", async (context) => {
    writeFileSync(at("from", "0"), "old");
    mkdirSync(at("to", "0"));
    const py = (code: string, path: string) => execFileSync("python3", ["-c", code, path], { encoding: "utf8" }).trim();
    try {
      py("import os,sys; os.setxattr(sys.argv[1],'user.old',b'original')", at("from", "0"));
    } catch (error) {
      context.skip(`xattr fixture unavailable: ${String(error)}`);
    }
    expect((await run(["keep", "10000"])).code).toBe(0);
    const inode = lstatSync(at("from", "0")).ino;
    py("import os,sys; os.setxattr(sys.argv[1],'user.added',b'new')", at("from", "0"));
    writeFileSync(at("from", "0"), "new");
    expect((await run(["restore"], { from: at("to"), to: at("from") })).code).toBe(0);
    expect(lstatSync(at("from", "0")).ino).toBe(inode);
    expect(readFileSync(at("from", "0"), "utf8")).toBe("old");
    expect(py("import os,sys,json; print(json.dumps(os.listxattr(sys.argv[1])))", at("from", "0"))).toBe(
      '["user.old"]',
    );
    expect(py("import os,sys; print(os.getxattr(sys.argv[1],'user.old').decode())", at("from", "0"))).toBe("original");
  });

  it("says how to use it, and fails when the mounts do not pair up", async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(["keep", "lots"])).printed).toContain(
      "Usage: main.js volume-copy keep <limit in bytes> | restore",
    );
    mkdirSync(at("from", "0"));
    mkdirSync(at("from", "1"));
    mkdirSync(at("to", "0"));
    const { code, printed } = await run(["keep", "100"]);
    expect(code).toBe(1);
    expect(JSON.parse(printed)).toMatchObject({
      outcome: "failed",
      reason: "the mounts to copy from and to do not pair up",
    });
  });
});
