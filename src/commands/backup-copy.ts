import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Decrypter, Encrypter } from "age-encryption";
import { z } from "zod";
import {
  BACKUP_UNREADABLE,
  CONTAINER_BACKUP,
  COPY_COMMAND,
  backupManifestSchema,
  backupReadme,
  type BackupManifest,
} from "../shared/container-backups.js";
import { describeError } from "../shared/errors.js";

const TOOL = "/app/checkpoint-tool/tar";
const TOOL_LIBRARIES = "/app/checkpoint-tool/lib";
// What tar says when a file changed as it read it: possible only for a writer outside Docker, and not worth failing.
const TAR_CHANGED_WHILE_READING = 1;
const CAPTURE_FLAGS = ["--numeric-owner", "--acls", "--xattrs", "--sparse"];
// What a host labels by itself, as Docker's own settings decide: it says nothing of the file.
const NOT_THE_FILES_OWN = "security.selinux";

export interface BackupCopyRoots {
  data: string;
  backups: string;
  copy: string;
  tar: string;
  progress: (line: object) => void;
}

const DEFAULT_ROOTS: BackupCopyRoots = {
  data: "/backup-data",
  backups: "/backups",
  copy: "/backup-copy",
  tar: TOOL,
  progress: (line) => console.log(JSON.stringify(line)),
};

const relativeFolder = z.string().refine((path) => !path.startsWith("/") && !path.split("/").includes(".."));
const fileName = z.string().regex(/^[a-z0-9.-]+$/);
const identity = z.string().min(40).max(128);
const recipient = z.string().min(40).max(128);

function tarProcess({ tar }: BackupCopyRoots, args: string[], stdin: "pipe" | "ignore") {
  return spawn(tar, args, {
    stdio: [stdin, "pipe", "pipe"],
    env: tar === TOOL ? { LD_LIBRARY_PATH: TOOL_LIBRARIES } : process.env,
  });
}

function finished(process: ChildProcess, allowed: readonly number[] = [0]): Promise<void> {
  let stderr = "";
  process.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-2000);
  });
  return new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("close", (code) => {
      if (allowed.includes(code ?? -1)) resolve();
      else reject(new Error(`tar stopped with ${code ?? "a signal"}: ${stderr.trim()}`));
    });
  });
}

// How tar stopping early looks from the side that still writes to it.
const TAR_LEFT_EARLY: ReadonlySet<string | undefined> = new Set(["EPIPE", "ERR_STREAM_PREMATURE_CLOSE"]);

/**
 * An archive fed to tar, however that goes by tar's own exit. It may leave at the end-of-archive mark with padding
 * still on its way, which is no failure; a source that fails, such as a sealed file that does not open, still is.
 */
async function feedTar(source: Readable, tar: ChildProcess, ended: Promise<void>) {
  await pipeline(source, tar.stdin!).catch((error: NodeJS.ErrnoException) => {
    if (!TAR_LEFT_EARLY.has(error.code)) throw error;
  });
  await ended;
}

function counting(onChunk: (chunk: Buffer) => void) {
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      onChunk(chunk);
      done(null, chunk);
    },
  });
}

/** Encrypts a stream into a file, as it comes: nothing is held in memory but what is passing through. */
async function encryptInto(
  roots: BackupCopyRoots,
  source: Readable,
  path: string,
  to: string,
): Promise<{ bytes: number; sha256: string; sourceBytes: number }> {
  const encrypter = new Encrypter();
  encrypter.addRecipient(to);
  let sourceBytes = 0;
  let toldAt = Date.now();
  const plain = source.pipe(
    counting((chunk) => {
      sourceBytes += chunk.length;
      if (Date.now() - toldAt < CONTAINER_BACKUP.progressMilliseconds) return;
      toldAt = Date.now();
      roots.progress({ copied: sourceBytes });
    }),
  );
  source.once("error", (error) => plain.destroy(error));
  const encrypted = await encrypter.encrypt(Readable.toWeb(plain) as ReadableStream<Uint8Array>);
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    Readable.fromWeb(encrypted as never),
    counting((chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    }),
    createWriteStream(path, { flush: true, mode: 0o600 }),
  );
  return { bytes, sha256: hash.digest("hex"), sourceBytes };
}

function decrypted(path: string, key: string) {
  const decrypter = new Decrypter();
  decrypter.addIdentity(key);
  return decrypter
    .decrypt(Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>)
    .then((stream) => Readable.fromWeb(stream as never));
}

async function measured(path: string, deadline: number): Promise<number | null> {
  const info = await lstat(path);
  if (!info.isDirectory()) return info.size;
  let bytes = 0;
  const waiting = [path];
  while (waiting.length > 0) {
    if (Date.now() > deadline) return null;
    const folder = waiting.pop()!;
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const inside = join(folder, entry.name);
      if (entry.isDirectory()) {
        waiting.push(inside);
        continue;
      }
      bytes += (await lstat(inside).catch(() => ({ size: 0 }))).size;
    }
  }
  return bytes;
}

/** How big each mount is, and the room left where backups go. A mount not measured in time says so. */
export async function measure(roots: BackupCopyRoots, mounts: number, milliseconds: number) {
  const deadline = Date.now() + milliseconds;
  const sizes: (number | null)[] = [];
  for (let index = 0; index < mounts; index += 1) {
    sizes.push(await measured(join(roots.data, String(index)), deadline).catch(() => null));
  }
  const room = await statfs(roots.backups);
  return { sizes, freeBytes: room.bavail * room.bsize };
}

const captureInput = z.object({ folder: relativeFolder, file: fileName, index: z.number().int().min(0), recipient });

/** A mount, as tar makes it and age seals it. A file mounted alone is tarred from beside it. */
export async function capture(roots: BackupCopyRoots, raw: unknown) {
  const input = captureInput.parse(raw);
  const root = join(roots.data, String(input.index));
  const singleFile = !(await lstat(root)).isDirectory();
  const where = singleFile ? ["-C", roots.data, String(input.index)] : ["-C", root, "."];
  const folder = join(roots.backups, input.folder);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const tar = tarProcess(roots, ["-cf", "-", ...CAPTURE_FLAGS, ...where], "ignore");
  const ended = finished(tar, [0, TAR_CHANGED_WHILE_READING]);
  const written = await encryptInto(roots, tar.stdout!, join(folder, input.file), input.recipient);
  await ended;
  return { ...written, singleFile };
}

/** What arrives on stdin, sealed: a database's dump as it is made, or a stack's settings. */
export async function store(roots: BackupCopyRoots, folder: string, file: string, to: string, stdin: Readable) {
  const target = join(roots.backups, relativeFolder.parse(folder));
  await mkdir(target, { recursive: true, mode: 0o700 });
  const written = await encryptInto(roots, stdin, join(target, fileName.parse(file)), recipient.parse(to));
  if (written.sourceBytes === 0) throw new Error("Nothing arrived to store.");
  return written;
}

const verifyInput = z.object({
  folder: relativeFolder,
  identity,
  files: z.array(z.object({ file: fileName, sha256: z.string(), isTar: z.boolean() })),
});

/** Every file as it is on disk: its checksum matches, it decrypts, and a tar lists to its end. */
export async function verify(roots: BackupCopyRoots, raw: unknown) {
  const input = verifyInput.parse(raw);
  for (const { file, sha256, isTar } of input.files) {
    const path = join(roots.backups, input.folder, file);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    if (hash.digest("hex") !== sha256) throw new Error(`${file} does not match its checksum.`);
    const plain = await decrypted(path, input.identity);
    if (isTar) {
      const tar = tarProcess(roots, ["-tf", "-"], "pipe");
      tar.stdout!.resume();
      await feedTar(plain, tar, finished(tar));
    } else {
      plain.resume();
      await new Promise((resolve, reject) => plain.once("end", resolve).once("error", reject));
    }
  }
  return {};
}

const finishInput = z.object({
  parent: relativeFolder,
  unfinished: relativeFolder,
  manifest: backupManifestSchema,
  key: z.string().min(40).max(4096),
  name: z.string(),
  copy: z.boolean(),
  // A backup being restored at this moment: however old, it is not let go of yet.
  protect: z.string().nullable().default(null),
});

const backupsIn = async (folder: string) =>
  (await readdir(folder).catch(() => [] as string[])).filter((name) => /^\d{8}T\d{6}Z$/.test(name)).toSorted();

async function keepNewest(folder: string, kept: number, protect: string | null = null) {
  const all = await backupsIn(folder);
  for (const old of all.slice(0, Math.max(0, all.length - kept)).filter((name) => name !== protect)) {
    await rm(join(folder, old), { recursive: true, force: true });
  }
  // One a crash left half-made is no use to anyone. Only one runs on a host at a time, so none of these is in use.
  for (const name of await readdir(folder)) {
    if (name.startsWith(CONTAINER_BACKUP.unfinishedPrefix))
      await rm(join(folder, name), { recursive: true, force: true });
  }
}

/** Makes a checked backup real, all at once, and only then lets go of the oldest. A failed second copy fails nothing. */
export async function finish(roots: BackupCopyRoots, raw: unknown) {
  const input = finishInput.parse(raw);
  const unfinished = join(roots.backups, input.unfinished);
  await writeFile(join(unfinished, CONTAINER_BACKUP.manifestFile), JSON.stringify(input.manifest, null, 2), {
    mode: 0o600,
  });
  await writeFile(join(unfinished, CONTAINER_BACKUP.keyFile), Buffer.from(input.key, "base64"), { mode: 0o600 });
  await writeFile(join(unfinished, CONTAINER_BACKUP.readmeFile), backupReadme(input.name), { mode: 0o600 });
  const parent = join(roots.backups, input.parent);
  const final = join(parent, input.manifest.id);
  await rename(unfinished, final);
  await keepNewest(parent, CONTAINER_BACKUP.kept, input.protect);
  if (!input.copy) return { copyError: null };
  const copyParent = join(roots.copy, input.parent);
  try {
    const copying = join(copyParent, `${CONTAINER_BACKUP.unfinishedPrefix}${input.manifest.id}`);
    await cp(final, copying, { recursive: true });
    await rename(copying, join(copyParent, input.manifest.id));
    await keepNewest(copyParent, CONTAINER_BACKUP.kept);
    return { copyError: null };
  } catch (error) {
    return { copyError: describeError(error) };
  }
}

const listInput = z.object({ folders: z.array(relativeFolder) });

/** One backup's manifest, or why it cannot be offered. Each is read alone: none can cost the others their place. */
async function manifestIn(folder: string, id: string): Promise<{ manifest: BackupManifest } | { reason: string }> {
  const path = join(folder, id, CONTAINER_BACKUP.manifestFile);
  const status = await lstat(path).catch(() => null);
  if (status === null || !status.isFile()) return { reason: BACKUP_UNREADABLE.unreadable };
  if (status.size > CONTAINER_BACKUP.manifestBytes) return { reason: BACKUP_UNREADABLE.tooBig };
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return { reason: BACKUP_UNREADABLE.unreadable };
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return { reason: BACKUP_UNREADABLE.notJson };
  }
  const parsed = backupManifestSchema.safeParse(decoded);
  // One saying it is another backup would be listed under a name that restores something else.
  return parsed.success && parsed.data.id === id ? { manifest: parsed.data } : { reason: BACKUP_UNREADABLE.notValid };
}

/** What backups are here, and which could not be read: those stay as they are, for a person to look at. */
export async function list(roots: BackupCopyRoots, raw: unknown) {
  const manifests: unknown[] = [];
  const unreadable: { folder: string; id: string; reason: string }[] = [];
  for (const folder of listInput.parse(raw).folders) {
    const parent = join(roots.backups, folder);
    for (const id of await backupsIn(parent)) {
      const found = await manifestIn(parent, id);
      if ("manifest" in found)
        manifests.push({ manifest: found.manifest, sizeBytes: sizeOf(found.manifest.files), folder });
      else unreadable.push({ folder, id, reason: found.reason });
    }
  }
  return {
    manifests,
    unreadable: unreadable.slice(0, CONTAINER_BACKUP.unreadableShown),
    unreadableCount: unreadable.length,
  };
}

const sizeOf = (files: readonly { bytes: number }[]) => files.reduce((sum, { bytes }) => sum + bytes, 0);

const readInput = z.object({ folder: relativeFolder });

/** A backup's manifest and sealed key, for a restore. */
export async function read(roots: BackupCopyRoots, raw: unknown) {
  const folder = join(roots.backups, readInput.parse(raw).folder);
  const [manifest, key] = await Promise.all([
    readFile(join(folder, CONTAINER_BACKUP.manifestFile), "utf8"),
    readFile(join(folder, CONTAINER_BACKUP.keyFile)),
  ]);
  return { manifest: backupManifestSchema.parse(JSON.parse(manifest)), key: key.toString("base64") };
}

const emptyInput = z.object({ indexes: z.array(z.number().int().min(0)) });

/** Takes away what a mount holds, leaving the mount: Docker holds it open. */
export async function empty(roots: BackupCopyRoots, raw: unknown) {
  for (const index of emptyInput.parse(raw).indexes) {
    const root = join(roots.data, String(index));
    if (!(await lstat(root)).isDirectory()) continue;
    for (const entry of await readdir(root)) await rm(join(root, entry), { recursive: true, force: true });
  }
  return {};
}

const restoreInput = z.object({
  folder: relativeFolder,
  file: fileName,
  index: z.number().int().min(0),
  identity,
  singleFile: z.boolean(),
});

/** One plain file's mode, owner, size, time to the second, access list and extended attributes, as an archive says. */
async function metadataOfOnlyFile(roots: BackupCopyRoots, archive: Readable): Promise<string> {
  const tar = tarProcess(roots, ["-tvvf", "-", "--full-time", "--numeric-owner", "--acls", "--xattrs"], "pipe");
  let listed = "";
  tar.stdout!.on("data", (chunk: Buffer) => {
    listed += chunk.toString();
  });
  await feedTar(archive, tar, finished(tar));
  const lines = listed.split("\n").filter((line) => line !== "");
  const entries = lines.filter((line) => !line.startsWith(" "));
  const [entry = ""] = entries;
  if (entries.length !== 1 || !entry.startsWith("-")) throw new Error("This archive does not hold just one file.");
  const [mode, owner, size, date, time = ""] = entry.split(/\s+/);
  const attributes = lines.filter((line) => line.startsWith(" ") && !line.includes(NOT_THE_FILES_OWN));
  return [
    `${mode} ${owner} ${size} ${date} ${time.split(".")[0]}`,
    ...attributes.map((line) => line.trim()).sort(),
  ].join("; ");
}

/**
 * A file mounted alone, on the very file Docker holds open: its contents, mode, owner, time and access list. Tar with
 * --xattrs would replace the file, which a mount refuses, so its extended attributes stay as the file has them. So what
 * the file ends up with is compared with what was backed up, and anything different is said rather than called
 * restored. Values of extended attributes compare by length alone, which is what tar lists.
 */
async function restoreSingleFile(roots: BackupCopyRoots, sealed: string, secret: string, index: number) {
  const archived = await metadataOfOnlyFile(roots, await decrypted(sealed, secret));
  const name = String(index);
  const flags = ["--overwrite", "--numeric-owner", "--same-owner", "--acls", `--transform=s,.*,${name},`];
  const tar = tarProcess(roots, ["-xpf", "-", ...flags, "-C", roots.data], "pipe");
  tar.stdout!.resume();
  await feedTar(await decrypted(sealed, secret), tar, finished(tar));
  const reading = tarProcess(roots, ["-cf", "-", ...CAPTURE_FLAGS, "-C", roots.data, name], "ignore");
  const read = finished(reading, [0, TAR_CHANGED_WHILE_READING]);
  const restored = await metadataOfOnlyFile(roots, reading.stdout!);
  await read;
  if (restored !== archived) {
    throw new Error(`Its contents came back, but not all its metadata. Backed up: ${archived}. Now: ${restored}.`);
  }
}

/** Puts a mount back from its tar. */
export async function restore(roots: BackupCopyRoots, raw: unknown) {
  const input = restoreInput.parse(raw);
  const root = join(roots.data, String(input.index));
  const sealed = join(roots.backups, input.folder, input.file);
  if (input.singleFile) {
    await restoreSingleFile(roots, sealed, input.identity, input.index);
    return {};
  }
  const plain = await decrypted(sealed, input.identity);
  await empty(roots, { indexes: [input.index] });
  const tar = tarProcess(roots, ["-xpf", "-", "--numeric-owner", "--acls", "--xattrs", "-C", root], "pipe");
  tar.stdout!.resume();
  await feedTar(plain, tar, finished(tar));
  return {};
}

const revealInput = z.object({ folder: relativeFolder, file: fileName, identity });

/** A sealed file, opened onto stdout: a dump on its way into its database, or settings on their way back. */
export async function reveal(roots: BackupCopyRoots, raw: unknown, out: NodeJS.WritableStream) {
  const input = revealInput.parse(raw);
  await pipeline(await decrypted(join(roots.backups, input.folder, input.file), input.identity), out);
}

async function stdinJson() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

const discardInput = z.object({ folder: relativeFolder });

/** What a backup that did not finish had written. Its name marks it as such, and nothing else is reachable. */
export async function discard(roots: BackupCopyRoots, raw: unknown) {
  const { folder } = discardInput.parse(raw);
  if (!folder.split("/").at(-1)!.startsWith(CONTAINER_BACKUP.unfinishedPrefix)) throw new Error("Not unfinished.");
  await rm(join(roots.backups, folder), { recursive: true, force: true });
  return {};
}

const JSON_COMMANDS: Record<string, (roots: BackupCopyRoots, input: unknown) => Promise<object>> = {
  [COPY_COMMAND.capture]: capture,
  [COPY_COMMAND.verify]: verify,
  [COPY_COMMAND.finish]: finish,
  [COPY_COMMAND.list]: list,
  [COPY_COMMAND.read]: read,
  [COPY_COMMAND.discard]: discard,
  [COPY_COMMAND.empty]: empty,
  [COPY_COMMAND.restore]: restore,
};

/**
 * What the helper a backup starts can do: a short-lived container of Autoheal's own image, with no network. Only the
 * runner asks it anything. Keys arrive on stdin, never as arguments, so they show in no process list or inspect.
 */
export async function runBackupCopy(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  if (command === COPY_COMMAND.wait) {
    await new Promise(() => setInterval(() => undefined, 60_000));
    return 0;
  }
  try {
    if (command === COPY_COMMAND.reveal) {
      await reveal(DEFAULT_ROOTS, await stdinJson(), process.stdout);
      return 0;
    }
    const answer =
      command === COPY_COMMAND.measure
        ? await measure(DEFAULT_ROOTS, Number(rest[0]), Number(rest[1]))
        : command === COPY_COMMAND.store
          ? await store(DEFAULT_ROOTS, rest[0] ?? "", rest[1] ?? "", rest[2] ?? "", process.stdin)
          : await JSON_COMMANDS[command ?? ""]!(DEFAULT_ROOTS, await stdinJson());
    console.log(JSON.stringify({ ok: true, ...answer }));
    return 0;
  } catch (error) {
    console.log(JSON.stringify({ ok: false, message: describeError(error) }));
    return 1;
  }
}
