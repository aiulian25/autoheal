import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT_NOT_INSIDE, PREVIOUS_SUFFIX, commitScript, recoveryScript } from "./stack-transaction.js";

const run = async (script: string) =>
  promisify(execFile)("sh", ["-c", script]).then(
    () => 0,
    (error: { code: number }) => error.code,
  );

describe("putting back a save that died part way", () => {
  let root: string;
  let folder: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "autoheal-recovery-"));
    folder = join(root, "stack");
    mkdirSync(folder);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("touches nothing outside the folder when a link inside it points elsewhere", async () => {
    mkdirSync(join(root, "elsewhere"));
    writeFileSync(join(root, "elsewhere", "victim"), "kept");
    symlinkSync(join(root, "elsewhere"), join(folder, "link"));

    const script = recoveryScript(folder, [
      { path: join(folder, "link", "victim"), newSuffix: "abc", oldSuffix: null },
    ]);

    expect(await run(script)).toBe(EXIT_NOT_INSIDE);
    expect(existsSync(join(root, "elsewhere", "victim"))).toBe(true);
  });

  it("puts back a file that is really in the folder", async () => {
    writeFileSync(join(folder, "compose.yaml"), "half written");

    const script = recoveryScript(folder, [{ path: join(folder, "compose.yaml"), newSuffix: "abc", oldSuffix: null }]);

    expect(await run(script)).toBe(0);
    expect(existsSync(join(folder, "compose.yaml"))).toBe(false);
  });
});

describe("a save that keeps the version before it", () => {
  let root: string;
  let folder: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "autoheal-commit-"));
    folder = join(root, "stack");
    mkdirSync(folder);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("keeps it beside the file, not through a link put in its place", async () => {
    const compose = join(folder, "compose.yaml");
    const previous = `${compose}${PREVIOUS_SUFFIX}`;
    writeFileSync(compose, "old\n");
    writeFileSync(join(root, "victim"), "kept\n");
    symlinkSync(join(root, "victim"), previous);

    const script = commitScript({
      folder,
      writes: [{ path: compose, text: "new\n" }],
      forgetPrevious: [],
      keepPrevious: true,
    });

    expect(await run(script)).toBe(0);
    expect(readFileSync(join(root, "victim"), "utf8")).toBe("kept\n");
    expect(lstatSync(previous).isSymbolicLink()).toBe(false);
    expect(readFileSync(previous, "utf8")).toBe("old\n");
    expect(readFileSync(compose, "utf8")).toBe("new\n");
  });
});
