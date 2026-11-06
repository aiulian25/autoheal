import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT_NOT_INSIDE, recoveryScript } from "./stack-transaction.js";

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
