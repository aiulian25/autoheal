import { constants } from "node:fs";
import { lstat, open, opendir, readlink, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, normalize, relative } from "node:path";
import { HOME_REVIEW_LIMITS, HOME_REVIEW_TEXT } from "../../shared/constants.js";
import {
  HOME_SCAN_INCOMPLETE,
  HOME_SKIPPED_WHY,
  type HomeScanIncomplete,
  type HomeCommentBlock,
  type HomeDeadReference,
  type HomeLeftover,
  type HomeSkippedFile,
  type HomeSkippedWhy,
} from "../../shared/home-review.js";

// Never opened, whatever they are asked for: passwords, tokens and sign-ins. Their names may be listed, as a leftover.
const NEVER_OPENED_FILES = new Set(["secrets.yaml", "known_devices.yaml"]);
const NEVER_OPENED_FOLDERS = new Set([".storage", ".cloud", ".cache"]);
// What Home Assistant or its add-ons own and change themselves: no leftover of a person's is in these.
const NOT_WALKED = new Set([
  "custom_components",
  "deps",
  "www",
  "image",
  "tts",
  "themes",
  "blueprints",
  ".cache",
  ".cloud",
]);
const LEFTOVER_NAME =
  /\.bak|\.bkp|\.backup|\.old$|\.orig$|~$|[._-]backups?\b|bak-|\.migration_backup|dump\.|\.fault$|\.log\.\d+$/i;
const YAML_NAME = /\.ya?ml$/i;
const CODE_FOLDERS = ["packages", "scripts", "automations", "includes"];
const CODE_COMMENT = /^\s*#\s?\s*(?:- )?[A-Za-z_][\w.-]*:(?:\s|$)|^\s*#\s?\s*- /;
const LEADING_COMMENT = /^\s*#\s?/;
const ENTITY_ID = /^[a-z_]+\.[a-z0-9_]+$/;
const ENTITY_KEY = /^\s*(?:- )?entity_id:\s*(.*?)\s*(?:#.*)?$/;
const LIST_ITEM = /^\s*- ["']?([a-z_]+\.[a-z0-9_]+)["']?\s*(?:#.*)?$/;
const NEAR_DISTANCE = 4;

// In lower case, as a share may not mind the case of a name.
const isOpenable = (relativePath: string) => {
  const parts = relativePath.toLowerCase().split("/");
  return !NEVER_OPENED_FILES.has(parts.at(-1)!) && !parts.some((part) => NEVER_OPENED_FOLDERS.has(part));
};

const staysInside = (relativePath: string) =>
  relativePath !== "" &&
  !isAbsolute(relativePath) &&
  normalize(relativePath) === relativePath &&
  !relativePath.split("/").includes("..");

// Without following links, and without waiting on a pipe.
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const SAME_FILE_LINKS = 1;
const SYMBOLIC_LINK_TOO_DEEP = "ELOOP";
// Where this process has a file open, as the kernel knows it: no later change to the path can alter the answer.
const openedPathOf = (descriptor: number) => readlink(`/proc/self/fd/${descriptor}`);

export interface ScanLimits {
  entries: number;
  fileBytes: number;
  totalBytes: number;
  readers: number;
}

const DEFAULT_SCAN_LIMITS: ScanLimits = {
  entries: HOME_REVIEW_LIMITS.scanEntries,
  fileBytes: HOME_REVIEW_LIMITS.scanFileBytes,
  totalBytes: HOME_REVIEW_LIMITS.scanTotalBytes,
  readers: HOME_REVIEW_LIMITS.scanReaders,
};

/**
 * What one look at the configuration may cost, known before each thing is done rather than found out after: how many
 * names it may look at, how much it may keep, and whether it has been told to stop. A slow share's read under way
 * cannot be taken back, but nothing new starts.
 */
export class ScanBudget {
  private entriesLeft: number;
  private bytesLeft: number;
  private ranOut: HomeScanIncomplete | null = null;

  constructor(
    private readonly signal: AbortSignal = new AbortController().signal,
    readonly limits: ScanLimits = DEFAULT_SCAN_LIMITS,
  ) {
    this.entriesLeft = limits.entries;
    this.bytesLeft = limits.totalBytes;
  }

  get stopped(): boolean {
    return this.signal.aborted || this.ranOut === HOME_SCAN_INCOMPLETE.entries;
  }

  /** Why what it found is not the whole of it; null when it is. */
  get incomplete(): HomeScanIncomplete | null {
    return this.signal.aborted ? HOME_SCAN_INCOMPLETE.time : this.ranOut;
  }

  takeEntry(): boolean {
    if (this.stopped) return false;
    if (this.entriesLeft === 0) {
      this.ranOut = HOME_SCAN_INCOMPLETE.entries;
      return false;
    }
    this.entriesLeft -= 1;
    return true;
  }

  takeBytes(bytes: number): boolean {
    if (bytes > this.bytesLeft) {
      this.ranOut ??= HOME_SCAN_INCOMPLETE.bytes;
      return false;
    }
    this.bytesLeft -= bytes;
    return true;
  }
}

/** Names in a folder one at a time, each counted: a huge folder is never held in memory whole. */
async function* entriesOf(folder: string, budget: ScanBudget) {
  if (budget.stopped) return;
  const directory = await opendir(folder);
  for await (const entry of directory) {
    if (!budget.takeEntry()) return;
    yield entry;
  }
}

/** Refused for what a file really is, as opposed to one that is simply not there. */
export class ConfigFileRefused extends Error {
  constructor(
    relativePath: string,
    readonly why: HomeSkippedWhy,
  ) {
    super(`Not read: ${relativePath}`);
  }
}

// Each folder on the way, so a link in a parent never leads to anything being opened.
async function refuseLinkedFolders(root: string, relativePath: string) {
  const parts = relativePath.split("/").slice(0, -1);
  for (let depth = 1; depth <= parts.length; depth += 1) {
    const info = await lstat(join(root, ...parts.slice(0, depth)));
    if (info.isSymbolicLink()) throw new ConfigFileRefused(relativePath, HOME_SKIPPED_WHY.link);
  }
}

// What the files that must never be read really are, so another name or letter case for one is still that file.
async function neverOpenedIdentities(root: string) {
  const identities = new Set<string>();
  for (const name of NEVER_OPENED_FILES) {
    const info = await stat(join(root, name)).catch(() => null);
    if (info !== null) identities.add(`${info.dev}:${info.ino}`);
  }
  return identities;
}

// As much as it said it held and no more, should it be growing: what was allowed for is all that is ever allocated.
async function textOf(file: FileHandle, relativePath: string, size: number): Promise<string> {
  const buffer = Buffer.alloc(size + 1);
  let filled = 0;
  for (;;) {
    const { bytesRead } = await file.read(buffer, filled, buffer.length - filled, filled);
    if (bytesRead === 0) return buffer.toString("utf8", 0, filled);
    filled += bytesRead;
    if (filled > size) throw new ConfigFileRefused(relativePath, HOME_SKIPPED_WHY.tooBig);
  }
}

/**
 * A file of the configuration as text: refused for what must never be read, whoever asks, by what it really is as well
 * as by its name. It is opened without following links and then checked, as a path can change between looking and
 * opening: the open file itself must be a plain file at this very place inside the configuration, and have no other
 * name, as a hard link has no way to say what else it is.
 */
export async function readConfigFile(
  root: string,
  relativePath: string,
  budget: ScanBudget = new ScanBudget(),
): Promise<string> {
  if (!staysInside(relativePath) || !isOpenable(relativePath)) throw new Error(`Not read: ${relativePath}`);
  await refuseLinkedFolders(root, relativePath);
  const expected = join(await realpath(root), relativePath);
  const file = await open(join(root, relativePath), OPEN_FLAGS).catch((error: NodeJS.ErrnoException) => {
    throw error.code === SYMBOLIC_LINK_TOO_DEEP ? new ConfigFileRefused(relativePath, HOME_SKIPPED_WHY.link) : error;
  });
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new ConfigFileRefused(relativePath, HOME_SKIPPED_WHY.notPlain);
    if ((await openedPathOf(file.fd)) !== expected) throw new ConfigFileRefused(relativePath, HOME_SKIPPED_WHY.link);
    const secondName =
      info.nlink > SAME_FILE_LINKS || (await neverOpenedIdentities(root)).has(`${info.dev}:${info.ino}`);
    if (secondName) throw new ConfigFileRefused(relativePath, HOME_SKIPPED_WHY.secondName);
    if (info.size > budget.limits.fileBytes) throw new ConfigFileRefused(relativePath, HOME_SKIPPED_WHY.tooBig);
    if (!budget.takeBytes(info.size)) throw new ConfigFileRefused(relativePath, HOME_SKIPPED_WHY.overBudget);
    return await textOf(file, relativePath, info.size);
  } finally {
    await file.close();
  }
}

// Links are counted as themselves and never followed, or a link back up would have no end. One at a time, and only
// as far as the budget goes: a total cut short says less than there is, which the budget reports.
async function sizeOf(path: string, budget: ScanBudget, depth = 0): Promise<number> {
  const info = await lstat(path);
  if (!info.isDirectory() || depth >= HOME_REVIEW_LIMITS.scanDepth) return info.size;
  let total = 0;
  for await (const entry of entriesOf(path, budget)) {
    total += await sizeOf(join(path, entry.name), budget, depth + 1).catch(() => 0);
  }
  return total;
}

/** Backups and dumps left lying in the configuration, by name alone: nothing here is opened. */
export async function findLeftovers(root: string, budget: ScanBudget = new ScanBudget()): Promise<HomeLeftover[]> {
  const found: HomeLeftover[] = [];
  const walk = async (folder: string, depth: number) => {
    for await (const entry of entriesOf(folder, budget)) {
      const path = join(folder, entry.name);
      if (LEFTOVER_NAME.test(entry.name)) {
        const info = await lstat(path).catch(() => null);
        if (info === null) continue;
        found.push({
          path: relative(root, path),
          bytes: await sizeOf(path, budget).catch(() => info.size),
          modifiedAt: info.mtimeMs,
          folder: entry.isDirectory(),
        });
        continue;
      }
      if (entry.isDirectory() && depth < HOME_REVIEW_LIMITS.walkDepth && !NOT_WALKED.has(entry.name)) {
        await walk(path, depth + 1).catch(() => undefined);
      }
    }
  };
  await walk(root, 0);
  return found.toSorted((first, second) => second.bytes - first.bytes).slice(0, HOME_REVIEW_LIMITS.listed);
}

async function yamlNamesIn(root: string, folder: string, budget: ScanBudget, depth = 0): Promise<string[]> {
  const names: string[] = [];
  const subfolders: string[] = [];
  for await (const entry of entriesOf(join(root, folder), budget)) {
    const path = join(folder, entry.name);
    if (YAML_NAME.test(entry.name)) names.push(path);
    if (entry.isDirectory() && depth < HOME_REVIEW_LIMITS.scanDepth) subfolders.push(path);
  }
  for (const subfolder of subfolders) {
    names.push(...(await yamlNamesIn(root, subfolder, budget, depth + 1).catch(() => [])));
  }
  return names;
}

/**
 * The YAML a person keeps: at the top of the configuration, and in the usual folders for splitting it up. A few at a
 * time, from the top, so what a budget leaves out is what is deepest; what it read stays true.
 */
export async function readYamlFiles(
  root: string,
  budget: ScanBudget = new ScanBudget(),
  read: (root: string, path: string, budget: ScanBudget) => Promise<string> = readConfigFile,
): Promise<{ files: { path: string; text: string }[]; skipped: HomeSkippedFile[] }> {
  const names: string[] = [];
  for await (const entry of entriesOf(root, budget)) {
    if (YAML_NAME.test(entry.name) && !LEFTOVER_NAME.test(entry.name)) names.push(entry.name);
  }
  const nested: string[] = [];
  for (const folder of CODE_FOLDERS) {
    nested.push(...(await yamlNamesIn(root, folder, budget).catch(() => [])));
  }
  const paths = [...names.toSorted(), ...nested.toSorted()].filter(isOpenable);
  const files: { path: string; text: string }[] = [];
  const skipped: HomeSkippedFile[] = [];
  let next = 0;
  const reader = async () => {
    while (next < paths.length && !budget.stopped) {
      const path = paths[next]!;
      next += 1;
      try {
        files.push({ path, text: await read(root, path, budget) });
      } catch (error) {
        if (error instanceof ConfigFileRefused) skipped.push({ path, why: error.why });
      }
    }
  };
  await Promise.all(Array.from({ length: budget.limits.readers }, reader));
  return {
    files: files.toSorted((first, second) => paths.indexOf(first.path) - paths.indexOf(second.path)),
    skipped: skipped.slice(0, HOME_REVIEW_LIMITS.listed),
  };
}

/** Runs of lines that were code once and are comments now. Prose between them ends a run. */
export function commentedOutBlocks(file: string, text: string): HomeCommentBlock[] {
  const blocks: HomeCommentBlock[] = [];
  let start: number | null = null;
  const lines = text.split("\n");
  const close = (end: number) => {
    if (start !== null && end - start >= HOME_REVIEW_LIMITS.commentLines) {
      blocks.push({
        file,
        fromLine: start + 1,
        toLine: end,
        preview: lines[start]!.replace(LEADING_COMMENT, "").trim().slice(0, HOME_REVIEW_LIMITS.previewCharacters),
      });
    }
    start = null;
  };
  lines.forEach((line, index) => {
    if (CODE_COMMENT.test(line)) start ??= index;
    else close(index);
  });
  close(lines.length);
  return blocks;
}

/** Each entity a file names under `entity_id:`, with its line. A template says nothing plain, so it is passed over. */
export function entityReferences(text: string): { entity: string; line: number }[] {
  const found: { entity: string; line: number }[] = [];
  let listIndent: number | null = null;
  text.split("\n").forEach((line, index) => {
    if (line.trimStart().startsWith("#")) return;
    const indent = line.length - line.trimStart().length;
    const key = ENTITY_KEY.exec(line);
    if (key !== null) {
      const value = key[1]!.replace(/["'[\]]/g, "");
      listIndent = value === "" ? indent : null;
      for (const entity of value.split(",").map((each) => each.trim())) {
        if (ENTITY_ID.test(entity)) found.push({ entity, line: index + 1 });
      }
      return;
    }
    if (listIndent === null) return;
    const item = LIST_ITEM.exec(line);
    if (item !== null && indent >= listIndent) found.push({ entity: item[1]!, line: index + 1 });
    else if (!line.trim().startsWith("- ") && line.trim() !== "") listIndent = null;
  });
  return found;
}

function distance(first: string, second: string): number {
  let row = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let at = 1; at <= first.length; at += 1) {
    const next = [at];
    for (let other = 1; other <= second.length; other += 1) {
      const same = first[at - 1] === second[other - 1] ? 0 : 1;
      next.push(Math.min(next[other - 1]! + 1, row[other]! + 1, row[other - 1]! + same));
    }
    row = next;
  }
  return row[second.length]!;
}

function nearestOf(entity: string, known: readonly string[]): string | null {
  const domain = entity.split(".")[0]!;
  let best: string | null = null;
  let bestDistance = NEAR_DISTANCE + 1;
  for (const candidate of known) {
    if (!candidate.startsWith(`${domain}.`) || Math.abs(candidate.length - entity.length) > NEAR_DISTANCE) continue;
    const here = distance(entity, candidate);
    if (here < bestDistance) {
      best = candidate;
      bestDistance = here;
    }
  }
  return best;
}

/** Entities the files name that this home does not have, with the likeliest one it meant. */
export function deadReferences(
  files: readonly { path: string; text: string }[],
  known: ReadonlySet<string>,
): HomeDeadReference[] {
  const list = [...known];
  const nearest = new Map<string, string | null>();
  const found: HomeDeadReference[] = [];
  for (const { path, text } of files) {
    for (const { entity, line } of entityReferences(text)) {
      if (known.has(entity)) continue;
      if (!nearest.has(entity)) nearest.set(entity, nearestOf(entity, list));
      found.push({ file: path, line, entity, nearest: nearest.get(entity) ?? null });
      if (found.length >= HOME_REVIEW_LIMITS.listed) return found;
    }
  }
  return found;
}

const NUMBER_AS_STATE = /^\s*(?:- )?(?:to|from|state):\s*["']?(?:above\b|below\b|-?\d+(?:\.\d+)?["']?\s*$)/;
const QUOTES_MIXED = /:\s*(?:'[^']*"|"[^"]*')\s*$/;

/** What a plain reading of a model's YAML can tell is wrong, each said once. */
export function yamlProblems(yaml: string): string[] {
  const lines = yaml.split("\n");
  return [
    ...(lines.some((line) => NUMBER_AS_STATE.test(line)) ? [HOME_REVIEW_TEXT.numberAsState] : []),
    ...(lines.some((line) => QUOTES_MIXED.test(line)) ? [HOME_REVIEW_TEXT.quotesMixed] : []),
  ];
}

/** The top-level items of an automations or scripts file, each as its own text. */
export function topLevelBlocks(text: string): string[] {
  return text
    .split(/^(?=- )/m)
    .map((block) => block.trimEnd())
    .filter((block) => block.startsWith("- "));
}

export const aliasOf = (block: string) => /^\s*(?:- )?alias:\s*["']?(.*?)["']?\s*$/m.exec(block)?.[1] ?? null;
