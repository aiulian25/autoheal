import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILD_ID_LENGTH } from "./constants.js";
import { runnerBuildId, runnerIdentity } from "./runner-identity.js";

const MANIFEST = { dependencies: { zod: "^4.0.0", fastify: "^5.0.0" } };
const LOCKFILE = {
  packages: { "node_modules/zod": { version: "4.6.7" }, "node_modules/fastify": { version: "5.2.0" } },
};
// A compiled tree in the shape the build makes: what a runner loads, and what only the dashboard loads.
const SERVER = {
  "main.js": [
    'import { MODE_RUNNER } from "./shared/constants.js";',
    'const commands = { [MODE_RUNNER]: async () => (await import("./runner/application.js")).runRunner,',
    '  "check-config": async () => (await import("./commands/check-config.js")).runCheckConfig };',
  ].join("\n"),
  "runner/application.js": [
    'import { loadRunnerConfig } from "../config/runner-config.js";',
    'import { OllamaClient } from "../ollama/ollama-client.js";',
    'import { helperReport } from "../host-helper/helper-report.js";',
    'import { z } from "zod";',
    'import { createHash } from "node:crypto";',
  ].join("\n"),
  "commands/healthcheck.js": 'import { PORT } from "../shared/constants.js";',
  "commands/host-helper.js": 'import { helperReport } from "../host-helper/helper-report.js";',
  "commands/volume-copy.js": 'import "../shared/constants.js";',
  "commands/backup-copy.js": 'import "../shared/constants.js";',
  "commands/application-copy.js": 'import "../shared/constants.js";',
  "commands/check-config.js": 'import { loadControlPlaneConfig } from "../config/control-plane-config.js";',
  "config/runner-config.js": 'export const loadRunnerConfig = () => ({ fromTarget: "/from" });',
  "config/control-plane-config.js": 'import { fastify } from "fastify";',
  "ollama/ollama-client.js": "export class OllamaClient {}",
  "host-helper/helper-report.js": "export const helperReport = () => ({});",
  "shared/constants.js": 'export const MODE_RUNNER = "runner";\nexport const PORT = 9443;',
  "control-plane/application.js": 'import { fastify } from "fastify";',
};

let root: string;
const pathIn = (name: string) => join(root, name);
const write = (name: string, content: string) => {
  mkdirSync(dirname(pathIn(name)), { recursive: true });
  writeFileSync(pathIn(name), content);
};
const inputs = () => ({
  serverDirectory: pathIn("dist/server"),
  manifestPath: pathIn("package.json"),
  lockfilePath: pathIn("package-lock.json"),
  images: ["builder@sha256:1111", "runtime@sha256:2222"],
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "autoheal-runner-identity-"));
  for (const [name, content] of Object.entries(SERVER)) {
    write(join("dist/server", name), content);
  }
  write("package.json", JSON.stringify(MANIFEST));
  write("package-lock.json", JSON.stringify(LOCKFILE));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("what tells two builds of one release apart", () => {
  it("is the same for the same inputs, read twice", () => {
    expect(runnerBuildId(inputs())).toBe(runnerBuildId(inputs()));
    expect(runnerBuildId(inputs())).toHaveLength(BUILD_ID_LENGTH);
  });

  it("covers every folder a runner loads code from, not only two of them", () => {
    const covered = runnerIdentity(inputs())
      .filter((line) => line.startsWith("code "))
      .map((line) => line.split(" ")[1]!);
    expect(covered).toContain("config/runner-config.js");
    expect(covered).toContain("ollama/ollama-client.js");
    expect(covered).toContain("host-helper/helper-report.js");
    expect(covered).toContain("commands/host-helper.js");
    expect(covered).toContain("main.js");
  });

  it.each([
    ["the runtime configuration", "config/runner-config.js"],
    ["Ollama", "ollama/ollama-client.js"],
    ["a command a runner starts in a helper", "commands/host-helper.js"],
    ["the helper report", "host-helper/helper-report.js"],
    ["the runner itself", "runner/application.js"],
    ["what every mode loads", "shared/constants.js"],
  ])("changes when %s changes", (_what, module) => {
    const before = runnerBuildId(inputs());
    const path = pathIn(join("dist/server", module));
    writeFileSync(path, `${readFileSync(path, "utf8")}\n// a different build\n`);
    expect(runnerBuildId(inputs())).not.toBe(before);
  });

  it("stays the same when only the dashboard changes", () => {
    const before = runnerBuildId(inputs());
    write("dist/server/control-plane/application.js", 'import { fastify } from "fastify";\n// a new page\n');
    write("dist/server/commands/check-config.js", "// said differently\n");
    write("dist/server/config/control-plane-config.js", 'import { fastify } from "fastify";\n// more\n');
    expect(runnerBuildId(inputs())).toBe(before);
  });

  it("changes when a package a runner imports is a different version", () => {
    const before = runnerBuildId(inputs());
    write(
      "package-lock.json",
      JSON.stringify({ packages: { ...LOCKFILE.packages, "node_modules/zod": { version: "4.6.8" } } }),
    );
    expect(runnerBuildId(inputs())).not.toBe(before);
  });

  it("changes when a base image is a different one", () => {
    const before = runnerBuildId(inputs());
    expect(runnerBuildId({ ...inputs(), images: ["builder@sha256:3333", "runtime@sha256:2222"] })).not.toBe(before);
  });

  it("leaves out the packages only the dashboard imports", () => {
    const packages = runnerIdentity(inputs()).filter((line) => line.startsWith("package "));
    expect(packages).toEqual(["package zod 4.6.7"]);
  });

  it("will not hash a tree with a module missing", () => {
    rmSync(pathIn("dist/server/ollama/ollama-client.js"));
    expect(() => runnerBuildId(inputs())).toThrow(/ollama\/ollama-client\.js is not in/);
  });

  it("will not hash a tree where runner code loads something on demand that nobody has classified", () => {
    write("dist/server/runner/application.js", 'const page = await import("../control-plane/http/routes.js");');
    expect(() => runnerBuildId(inputs())).toThrow(/say in runner-identity\.ts whether a runner does/);
  });

  it("will not hash a tree whose imports the pattern cannot read whole", () => {
    write("dist/server/runner/application.js", 'import {\n  loadRunnerConfig,\n} from "../config/runner-config.js";');
    expect(() => runnerBuildId(inputs())).toThrow(/imports over several lines/);
  });

  it("will not hash a tree importing a package that is not a dependency", () => {
    write("dist/server/runner/application.js", 'import { readFile } from "fs-extra";');
    expect(() => runnerBuildId(inputs())).toThrow(/fs-extra, which is not a dependency/);
  });
});
