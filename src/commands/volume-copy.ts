import { execFile } from "node:child_process";
import { lstat, readdir, rm, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  CHECKPOINT,
  EXIT_FAILURE,
  EXIT_SUCCESS,
  EXIT_USAGE,
  VOLUME_COPY_MESSAGES,
  VOLUME_COPY_OUTCOME,
  VOLUME_COPY_VERB,
  type VolumeCopyOutcome,
} from "../shared/constants.js";
import { describeError } from "../shared/errors.js";

/** A successful report names the fidelity contract that was actually verified. */
export interface VolumeCopyReport {
  outcome: VolumeCopyOutcome;
  bytes: number;
  availableBytes: number;
  reason: string | null;
  fidelity?: typeof CHECKPOINT.fidelity;
}

export interface CopyRoots {
  from: string;
  to: string;
}

const execute = promisify(execFile);
const keepArguments = z.tuple([z.literal(VOLUME_COPY_VERB.keep), z.coerce.number().int().positive()]);
const restoreArguments = z.tuple([z.literal(VOLUME_COPY_VERB.restore)]);
const reportOf = (
  outcome: VolumeCopyOutcome,
  bytes = 0,
  availableBytes = 0,
  reason: string | null = null,
): VolumeCopyReport => ({
  outcome,
  bytes,
  availableBytes,
  reason,
  ...(outcome === VOLUME_COPY_OUTCOME.kept || outcome === VOLUME_COPY_OUTCOME.restored
    ? { fidelity: CHECKPOINT.fidelity }
    : {}),
});

/** Refuse silent omissions and links whose full relationship lies outside this one mount. */
export async function scanMount(path: string, budget: number): Promise<number> {
  const links = new Map<string, { expected: bigint; seen: bigint }>();
  let bytes = 0;
  let entries = 0;
  const scan = async (entry: string): Promise<void> => {
    if (++entries > CHECKPOINT.entryLimit) throw new Error(VOLUME_COPY_MESSAGES.entryLimit);
    const stats = await lstat(entry, { bigint: true });
    if (stats.isDirectory()) {
      for (const name of await readdir(entry)) {
        await scan(join(entry, name));
        if (bytes > budget) return;
      }
      return;
    }
    if (!stats.isFile() && !stats.isSymbolicLink()) throw new Error(VOLUME_COPY_MESSAGES.specialFile);
    if (stats.nlink > 1n) {
      const key = `${stats.dev}:${stats.ino}`;
      const previous = links.get(key);
      links.set(key, { expected: stats.nlink, seen: (previous?.seen ?? 0n) + 1n });
      if (previous !== undefined) return;
    }
    if (stats.isFile()) bytes += Number(stats.size);
  };
  await scan(path);
  if (bytes <= budget && [...links.values()].some(({ expected, seen }) => expected !== seen))
    throw new Error(VOLUME_COPY_MESSAGES.externalLinks);
  return bytes;
}

async function pairsOf(roots: CopyRoots): Promise<CopyRoots[]> {
  const sources = (await readdir(roots.from)).toSorted();
  const targets = (await readdir(roots.to)).toSorted();
  if (JSON.stringify(sources) !== JSON.stringify(targets)) throw new Error(VOLUME_COPY_MESSAGES.mismatch);
  return sources.map((name) => ({ from: resolve(roots.from, name), to: resolve(roots.to, name) }));
}

/** Never invoke a shell; output is bounded and never echoed because diagnostics can contain private filenames. */
export async function runCopier(program: string, args: readonly string[]) {
  try {
    const result = await execute(program, [...args], {
      timeout: CHECKPOINT.exitDeadlineMilliseconds,
      maxBuffer: CHECKPOINT.copyOutputBytes,
      env: { LC_ALL: "C", PATH: dirname(program), LD_LIBRARY_PATH: join(dirname(program), "lib") },
    });
    if (result.stderr !== "") throw new Error(VOLUME_COPY_MESSAGES.metadataCopyFailed);
    return result.stdout;
  } catch {
    throw new Error(VOLUME_COPY_MESSAGES.metadataCopyFailed);
  }
}

export async function requireCopier(program: string) {
  try {
    const version = await runCopier(program, ["--version"]);
    const features = ["ACLs", "xattrs", "hardlinks", "hardlink-symlinks", "symtimes", "atimes"];
    if (
      !version.startsWith("rsync  version ") ||
      features.some((feature) => !version.includes(feature) || version.includes(`no ${feature}`))
    )
      throw new Error(VOLUME_COPY_MESSAGES.metadataUnavailable);
  } catch {
    throw new Error(VOLUME_COPY_MESSAGES.metadataUnavailable);
  }
}

/**
 * Root attributes are included by trailing-slash directory transfers. Single-file mounts keep their inode. Into an
 * empty checkpoint, contents are not compared beforehand: rsync checks each file it sends as it lands, so reading
 * every byte first, and both copies again after, only makes the update wait. A restore over existing files compares
 * contents, as a file of the same size and time may still differ.
 */
async function copyAndVerify(
  program: string,
  pair: CopyRoots,
  directory: boolean,
  inPlace: boolean,
  compareContents: boolean,
) {
  const args = [
    "--archive",
    "--hard-links",
    "--acls",
    "--xattrs",
    "--atimes",
    "--open-noatime",
    "--numeric-ids",
    ...(compareContents ? ["--checksum"] : []),
    "--modify-window=-1",
    "--no-inc-recursive",
    ...(directory ? ["--delete"] : []),
    ...(inPlace ? ["--inplace"] : []),
  ];
  const paths = ["--", directory ? `${pair.from}/` : pair.from, directory ? `${pair.to}/` : pair.to];
  await runCopier(program, [...args, ...paths]);
  // A zero exit status alone is not proof that ownership, hard links, ACLs and xattrs converged.
  const differences = await runCopier(program, [
    ...args,
    "--dry-run",
    "--itemize-changes",
    "--out-format=%i",
    ...paths,
  ]);
  if (differences !== "") throw new Error(VOLUME_COPY_MESSAGES.metadataCopyFailed);
}

async function keep(roots: CopyRoots, limit: number, program: string): Promise<VolumeCopyReport> {
  const pairs = await pairsOf(roots);
  const disk = pairs[0] === undefined ? null : await statfs(pairs[0].to);
  const availableBytes = disk === null ? 0 : disk.bavail * disk.bsize;
  let bytes = 0;
  const plan: { pair: CopyRoots; directory: boolean }[] = [];
  for (const pair of pairs) {
    const source = await lstat(pair.from);
    if (!source.isDirectory() && !source.isFile()) throw new Error(VOLUME_COPY_MESSAGES.specialFile);
    bytes += await scanMount(pair.from, limit - bytes);
    if (bytes > limit) return reportOf(VOLUME_COPY_OUTCOME.tooBig, bytes, availableBytes);
    plan.push({
      pair: source.isFile() ? { ...pair, to: join(pair.to, CHECKPOINT.fileEntry) } : pair,
      directory: source.isDirectory(),
    });
  }
  if (bytes > availableBytes * CHECKPOINT.freeSpaceShare)
    return reportOf(VOLUME_COPY_OUTCOME.noRoom, bytes, availableBytes);
  await requireCopier(program);
  for (const { pair, directory } of plan) await copyAndVerify(program, pair, directory, false, false);
  return reportOf(VOLUME_COPY_OUTCOME.kept, bytes, availableBytes);
}

async function restore(roots: CopyRoots, program: string): Promise<VolumeCopyReport> {
  const plan: { pair: CopyRoots; directory: boolean }[] = [];
  for (const pair of await pairsOf(roots)) {
    const target = await lstat(pair.to);
    if (!target.isDirectory() && !target.isFile()) throw new Error(VOLUME_COPY_MESSAGES.specialFile);
    const from = target.isFile() ? join(pair.from, CHECKPOINT.fileEntry) : pair.from;
    const source = await lstat(from);
    if (source.isDirectory() !== target.isDirectory() || source.isFile() !== target.isFile())
      throw new Error(VOLUME_COPY_MESSAGES.incomplete);
    await scanMount(from, Infinity);
    await scanMount(pair.to, Infinity);
    plan.push({ pair: { from, to: pair.to }, directory: target.isDirectory() });
  }
  // All roots, link boundaries and tool availability are checked before removing or replacing any data.
  await requireCopier(program);
  for (const { pair, directory } of plan) {
    // Rebuild directory link topology, including splitting unintended links between identical files.
    // Keep the mounted root itself; rsync restores its attributes and removes replacement-only xattrs.
    if (directory)
      for (const entry of await readdir(pair.to)) await rm(join(pair.to, entry), { recursive: true, force: true });
    await copyAndVerify(program, pair, directory, !directory, true);
  }
  return reportOf(VOLUME_COPY_OUTCOME.restored);
}

/** The packaged tool runs locally inside the existing isolated helper, never as a daemon or remote transfer. */
export async function runVolumeCopy(
  commandArguments: string[],
  output: Pick<Console, "log" | "error"> = console,
  roots: CopyRoots = { from: CHECKPOINT.fromTarget, to: CHECKPOINT.toTarget },
  program: string = CHECKPOINT.copyProgram,
): Promise<number> {
  const keeping = keepArguments.safeParse(commandArguments);
  const restoring = restoreArguments.safeParse(commandArguments);
  if (!keeping.success && !restoring.success) {
    output.error(VOLUME_COPY_MESSAGES.usage);
    return EXIT_USAGE;
  }
  const copying = keeping.success ? keep(roots, keeping.data[1], program) : restore(roots, program);
  const report = await copying.catch((error: unknown) =>
    reportOf(VOLUME_COPY_OUTCOME.failed, 0, 0, describeError(error)),
  );
  output.log(JSON.stringify(report));
  return report.outcome === VOLUME_COPY_OUTCOME.failed ? EXIT_FAILURE : EXIT_SUCCESS;
}
