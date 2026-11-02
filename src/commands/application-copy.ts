import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Decrypter, Encrypter } from "age-encryption";
import Database from "better-sqlite3";
import { z } from "zod";
import { APPLICATION_BACKUPS, applicationPlanDefinitionSchema } from "../shared/application-backups.js";
import { CHECKPOINT } from "../shared/constants.js";
import { requireCopier, runCopier, scanMount } from "./volume-copy.js";

const flags = [
  "--archive",
  "--hard-links",
  "--acls",
  "--xattrs",
  "--atimes",
  "--open-noatime",
  "--numeric-ids",
  "--checksum",
  "--modify-window=-1",
  "--no-inc-recursive",
  "--quiet",
];
const manifestSchema = z
  .object({
    format: z.literal(APPLICATION_BACKUPS.format),
    fidelity: z.literal(CHECKPOINT.fidelity),
    coverage: z.string().regex(/^[a-f0-9]{64}$/u),
    roots: z
      .array(
        z.object({
          batchBytes: z.number().int().positive(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          tree: z.string().regex(/^[a-f0-9]{64}$/u),
        }),
      )
      .min(1)
      .max(APPLICATION_BACKUPS.mounts),
  })
  .strict();
export interface ApplicationCopyRoots {
  mounts: string[];
  work: string;
  artifact: string;
  program?: string;
  coverage: string;
}
const bounded = (maximum: number) => {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maximum ? new Error("Application backup exceeded its byte limit.") : null, chunk);
    },
  });
};
async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
/** Byte/identity/root metadata proof independent of inode numbers in the isolated clone. */
async function treeProof(root: string): Promise<string> {
  const hash = createHash("sha256"),
    links = new Map<string, string>();
  let entries = 0;
  const visit = async (path: string, relative: string): Promise<void> => {
    if (++entries > CHECKPOINT.entryLimit) throw new Error("Too many application backup entries.");
    const item = await lstat(path);
    const inode = `${item.dev}:${item.ino}`;
    const first = links.get(inode);
    if (item.nlink > 1 && !item.isDirectory() && !first) links.set(inode, relative);
    hash.update(
      JSON.stringify([
        relative,
        item.mode,
        item.uid,
        item.gid,
        Math.trunc(item.mtimeMs),
        item.isFile() ? item.size : null,
        first ?? null,
        item.isSymbolicLink() ? await readlink(path) : null,
      ]),
    );
    if (item.isDirectory())
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), `${relative}/${name}`);
    else if (item.isFile()) hash.update(await digest(path));
  };
  await visit(root, "");
  return hash.digest("hex");
}
async function validateRoots(roots: ApplicationCopyRoots) {
  if (!roots.mounts.length || roots.mounts.length > APPLICATION_BACKUPS.mounts)
    throw new Error("Application mount count is unsupported.");
  let bytes = 0;
  for (const root of roots.mounts) {
    if (!(await lstat(root)).isDirectory()) throw new Error("Application backups currently require directory mounts.");
    bytes += await scanMount(root, APPLICATION_BACKUPS.sourceBytes - bytes);
    if (bytes > APPLICATION_BACKUPS.sourceBytes)
      throw new Error("Application data exceeds the 32 MiB supported limit.");
  }
  await requireCopier(roots.program ?? CHECKPOINT.copyProgram);
  await mkdir(roots.work, { recursive: true });
}
/** Plaintext batches exist only in the helper's bounded tmpfs; both manifest and payload are age encrypted. */
export async function captureApplication(roots: ApplicationCopyRoots, recipient: string) {
  await validateRoots(roots);
  const records = [];
  let batchBytes = 0;
  for (const [index, root] of roots.mounts.entries()) {
    const empty = join(roots.work, `empty-${index}`),
      batch = join(roots.work, `batch-${index}`);
    await mkdir(empty);
    const before = await treeProof(root);
    await runCopier(roots.program ?? CHECKPOINT.copyProgram, [
      ...flags,
      `--only-write-batch=${batch}`,
      "--",
      `${root}/`,
      `${empty}/`,
    ]);
    const size = (await stat(batch)).size;
    batchBytes += size;
    if (batchBytes > APPLICATION_BACKUPS.sourceBytes)
      throw new Error("Application backup metadata exceeds its 32 MiB staging limit.");
    if (before !== (await treeProof(root))) throw new Error("Application data changed while stopped; backup refused.");
    records.push({ batchBytes: size, sha256: await digest(batch), tree: before });
  }
  const manifest = Buffer.from(
    JSON.stringify({
      format: APPLICATION_BACKUPS.format,
      fidelity: CHECKPOINT.fidelity,
      coverage: roots.coverage,
      roots: records,
    }),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(manifest.length);
  const source = Readable.from(
    (async function* () {
      yield length;
      yield manifest;
      for (let i = 0; i < records.length; i++)
        for await (const chunk of createReadStream(join(roots.work, `batch-${i}`))) yield chunk;
    })(),
  );
  const encryption = new Encrypter();
  encryption.addRecipient(recipient);
  const encrypted = await encryption.encrypt(Readable.toWeb(source) as ReadableStream<Uint8Array>);
  await pipeline(
    Readable.fromWeb(encrypted as unknown as import("node:stream/web").ReadableStream<Uint8Array>),
    bounded(APPLICATION_BACKUPS.payloadBytes),
    createWriteStream(roots.artifact, { flags: "wx", mode: 0o600 }),
  );
  return {
    payloadBytes: (await stat(roots.artifact)).size,
    payloadSha256: await digest(roots.artifact),
    integrity: "metadata-verified" as const,
  };
}
/** Decrypt and verify every batch before touching any destination; this function runs only on isolated or stopped mounts. */
export async function restoreApplication(
  roots: ApplicationCopyRoots,
  identity: string,
  sqlite: z.infer<typeof applicationPlanDefinitionSchema>["sqlite"] = null,
  sqliteMountIndex = -1,
) {
  await validateRoots(roots);
  const decoder = new Decrypter();
  decoder.addIdentity(identity);
  const decrypted = await decoder.decrypt(
    Readable.toWeb(createReadStream(roots.artifact)) as ReadableStream<Uint8Array>,
  );
  const bundle = join(roots.work, "bundle");
  await pipeline(
    Readable.fromWeb(decrypted as unknown as import("node:stream/web").ReadableStream<Uint8Array>),
    bounded(APPLICATION_BACKUPS.sourceBytes + 64 * 1024),
    createWriteStream(bundle, { flags: "wx", mode: 0o600 }),
  );
  const handle = await open(bundle, "r");
  let manifest: z.infer<typeof manifestSchema>;
  let offset = 4;
  try {
    const length = Buffer.alloc(4);
    if ((await handle.read(length, 0, 4, 0)).bytesRead !== 4)
      throw new Error("Application backup header is incomplete.");
    const size = length.readUInt32BE();
    if (size > 64 * 1024) throw new Error("Application backup manifest is too large.");
    const bytes = Buffer.alloc(size);
    if ((await handle.read(bytes, 0, size, 4)).bytesRead !== size)
      throw new Error("Application backup manifest is incomplete.");
    manifest = manifestSchema.parse(JSON.parse(bytes.toString()));
    offset += size;
    if (manifest.coverage !== roots.coverage)
      throw new Error("Historical application mount coverage changed; restore refused.");
    if (manifest.roots.length !== roots.mounts.length) throw new Error("Application backup mount coverage differs.");
    for (const [index, record] of manifest.roots.entries()) {
      const path = join(roots.work, `batch-${index}`);
      await pipeline(
        createReadStream(bundle, { start: offset, end: offset + record.batchBytes - 1 }),
        createWriteStream(path, { flags: "wx", mode: 0o600 }),
      );
      offset += record.batchBytes;
      if ((await stat(path)).size !== record.batchBytes || (await digest(path)) !== record.sha256)
        throw new Error("Application backup batch checksum differs.");
    }
    if (offset !== (await stat(bundle)).size) throw new Error("Application backup has unexpected trailing bytes.");
  } finally {
    await handle.close();
  }
  // Release the decrypted aggregate before applying batches so tmpfs use remains below 2x the staging bound.
  await rm(bundle);
  for (const [index, root] of roots.mounts.entries()) {
    for (const entry of await readdir(root)) await rm(join(root, entry), { recursive: true, force: true });
    await runCopier(roots.program ?? CHECKPOINT.copyProgram, [
      ...flags,
      `--read-batch=${join(roots.work, `batch-${index}`)}`,
      "--",
      `${root}/`,
    ]);
    if ((await treeProof(root)) !== manifest.roots[index]!.tree)
      throw new Error("Restored application file identity or metadata differs.");
  }
  if (sqlite) {
    const root = roots.mounts[sqliteMountIndex];
    if (!root) throw new Error("SQLite integrity mount is missing.");
    const path = resolve(root, sqlite.path);
    if (!path.startsWith(`${resolve(root)}/`)) throw new Error("SQLite path is outside the restored mount.");
    // Refuse symlink traversal, then open an immutable isolated file. No SQL, extensions or paths come from a model.
    let current = root;
    for (const segment of sqlite.path.split("/")) {
      current = join(current, segment);
      if ((await lstat(current)).isSymbolicLink()) throw new Error("SQLite integrity path cannot contain symlinks.");
    }
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      db.pragma("trusted_schema = OFF");
      if (db.pragma("integrity_check", { simple: true }) !== "ok")
        throw new Error("SQLite isolated integrity check failed.");
    } finally {
      db.close();
    }
    return { integrity: "sqlite-integrity-ok" as const };
  }
  return { integrity: "metadata-verified" as const };
}
export async function runApplicationCopy(args: string[]): Promise<number> {
  if (args[0] === "wait") {
    await new Promise(() => {
      setInterval(() => {}, 60000);
    });
    return 0;
  }
  try {
    const operation = args[0];
    const count = Number(args[1]);
    if (!Number.isInteger(count) || count < 1 || count > APPLICATION_BACKUPS.mounts)
      throw new Error("Unsupported application mount count.");
    const roots = {
      mounts: Array.from({ length: count }, (_, i) => `/application/${i}`),
      work: "/work",
      artifact: "/artifact/payload.age",
      coverage: args[3] ?? "",
    };
    if (operation !== "capture") roots.coverage = args[2] ?? "";
    let result;
    if (operation === "capture") result = await captureApplication(roots, args[2] ?? "");
    else if (operation === "restore" || operation === "drill") {
      const chunks: Buffer[] = [];
      let received = 0;
      for await (const chunk of process.stdin) {
        received += chunk.length;
        if (received > 1024) throw new Error("Invalid application restore identity.");
        chunks.push(Buffer.from(chunk));
      }
      const secret = Buffer.concat(chunks).toString("utf8");
      if (secret.length > 1024) throw new Error("Invalid application restore identity.");
      const input = z
        .object({
          identity: z.string().min(40).max(128),
          sqlite: applicationPlanDefinitionSchema.shape.sqlite,
          index: z.number().int(),
        })
        .strict()
        .parse(JSON.parse(secret));
      result = await restoreApplication(roots, input.identity, input.sqlite, input.index);
    } else throw new Error("Unsupported application copy operation.");
    console.log(JSON.stringify({ ok: true, ...result }));
    return 0;
  } catch {
    console.log(
      JSON.stringify({
        ok: false,
        message: "Application copy or integrity verification failed; no success was recorded.",
      }),
    );
    return 1;
  }
}
