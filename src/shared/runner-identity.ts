import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_ID_LENGTH } from "./constants.js";

/**
 * What tells two builds of one release apart, for the runner hosts that run their own copy of this image. Every
 * compiled module a runner process loads goes in, found by following the imports from the entry points below rather
 * than by naming folders: a runner loads code from runner/, shared/, config/, ollama/, commands/ and host-helper/,
 * so the two folders this used to hash were always going to miss some of it. The versions of the packages that code
 * imports go in, and so do the base images, whose own tools (rsync, tar, nsenter) a runner runs. Code only the
 * dashboard loads stays out, so a dashboard-only change asks nothing of any host.
 *
 * What this does not see: a change inside a dependency of a dependency, which the lockfile pins but which leaves the
 * direct package's version alone.
 */
const RUNNER_ENTRY_POINTS = [
  "main.js",
  "runner/application.js",
  "commands/healthcheck.js",
  "commands/host-helper.js",
  "commands/volume-copy.js",
  "commands/backup-copy.js",
  "commands/application-copy.js",
];

/** Loaded on demand by main.js, and never by a runner: the dashboard's own mode and the commands a person runs. */
const CONTROL_PLANE_MODULES = [
  "control-plane/application.js",
  "commands/check-config.js",
  "commands/self-test.js",
  "commands/migrate.js",
  "commands/reset-admin.js",
  "commands/restore.js",
  "commands/backup-passphrase.js",
  "commands/self-update.js",
];

// Whole statements only, anchored: a string holding the word "from" is not an import.
const STATIC_IMPORT = /^(?:import|export)\b(?:[^"]*\bfrom)?\s*"([^"]+)";$/gm;
// The compiler puts each import on one line; were that to change, every specifier below the first would be missed.
const IMPORT_OVER_SEVERAL_LINES = /^\s*\}\s*from\s*"/m;
const LAZY_IMPORT = /\bimport\("([^"]+)"\)/g;
const RELATIVE = ".";
const NODE_BUILTIN = "node:";
const PACKAGE_DIRECTORY = "node_modules/";
const SCOPE = "@";
const SCOPED_NAME_PARTS = 2;

export interface RunnerIdentityInputs {
  /** Where the compiled server is, the folder holding main.js: dist/server. */
  serverDirectory: string;
  manifestPath: string;
  lockfilePath: string;
  /** The base images, as the Dockerfile pins them by digest. */
  images: string[];
}

const digestOf = (content: Buffer | string) => createHash("sha256").update(content).digest("hex");

const specifiersIn = (source: string, pattern: RegExp) =>
  [...source.matchAll(pattern)].map((match) => match[1]!).filter((specifier) => specifier !== "");

const moduleBeside = (importingModule: string, specifier: string) =>
  posix.normalize(posix.join(posix.dirname(importingModule), specifier));

const packageOf = (specifier: string) => {
  const parts = specifier.split("/");
  if (specifier.startsWith(SCOPE)) return parts.slice(0, SCOPED_NAME_PARTS).join("/");
  return parts[0]!;
};

/** Every compiled module a runner loads, and every package those modules import, from the entry points inwards. */
function runnerCode(serverDirectory: string) {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const waiting = [...RUNNER_ENTRY_POINTS];
  while (waiting.length > 0) {
    const module = waiting.pop()!;
    if (modules.has(module)) continue;
    const path = join(serverDirectory, module);
    if (!existsSync(path)) throw new Error(`${module} is not in ${serverDirectory}`);
    modules.add(module);
    const source = readFileSync(path, "utf8");
    if (IMPORT_OVER_SEVERAL_LINES.test(source)) throw new Error(`${module} imports over several lines`);
    for (const specifier of specifiersIn(source, STATIC_IMPORT)) {
      if (specifier.startsWith(RELATIVE)) waiting.push(moduleBeside(module, specifier));
      else if (!specifier.startsWith(NODE_BUILTIN)) packages.add(packageOf(specifier));
    }
    for (const specifier of specifiersIn(source, LAZY_IMPORT)) {
      if (!specifier.startsWith(RELATIVE)) continue;
      const loaded = moduleBeside(module, specifier);
      if (RUNNER_ENTRY_POINTS.includes(loaded) || CONTROL_PLANE_MODULES.includes(loaded)) continue;
      throw new Error(`${module} loads ${loaded} on demand; say in runner-identity.ts whether a runner does`);
    }
  }
  return { modules: [...modules].sort(), packages: [...packages].sort() };
}

const versionIn = (lockfile: { packages?: Record<string, { version?: string }> }, name: string) =>
  lockfile.packages?.[`${PACKAGE_DIRECTORY}${name}`]?.version;

/** Every runtime input a runner has, one per line: what a build of this release is made of. */
export function runnerIdentity(inputs: RunnerIdentityInputs): string[] {
  const { modules, packages } = runnerCode(inputs.serverDirectory);
  const lockfile = JSON.parse(readFileSync(inputs.lockfilePath, "utf8"));
  const dependencies: Record<string, string> = JSON.parse(readFileSync(inputs.manifestPath, "utf8")).dependencies ?? {};
  const lines = modules.map(
    (module) => `code ${module} ${digestOf(readFileSync(join(inputs.serverDirectory, module)))}`,
  );
  for (const name of packages) {
    if (!(name in dependencies)) throw new Error(`runner code imports ${name}, which is not a dependency`);
    const version = versionIn(lockfile, name);
    if (version === undefined)
      throw new Error(`runner code imports ${name}, which ${inputs.lockfilePath} does not pin`);
    lines.push(`package ${name} ${version}`);
  }
  for (const image of inputs.images) {
    lines.push(`image ${image}`);
  }
  return lines;
}

/** The short identity the dashboard compares a host's runner against. */
export const runnerBuildId = (inputs: RunnerIdentityInputs) =>
  digestOf(runnerIdentity(inputs).join("\n")).slice(0, BUILD_ID_LENGTH);

/** Run at build time by the Dockerfile, which writes what it prints beside the compiled server. */
if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  const [serverDirectory = "", manifestPath = "", lockfilePath = "", ...images] = process.argv.slice(2);
  console.log(runnerBuildId({ serverDirectory, manifestPath, lockfilePath, images }));
}
