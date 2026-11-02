import { spawnSync } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { generateX25519Identity, identityToRecipient } from "age-encryption";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BACKUP_UNREADABLE,
  BACKUP_WHY,
  CONTAINER_BACKUP,
  backupAnswerSchema,
  backupManifestSchema,
  type BackupManifest,
} from "../shared/container-backups.js";
import {
  capture,
  empty,
  finish,
  list,
  measure,
  read,
  restore,
  reveal,
  store,
  verify,
  type BackupCopyRoots,
} from "./backup-copy.js";

const FOLDER = "app/.unfinished-20261101T000000Z";
const KEY = Buffer.from("x".repeat(64)).toString("base64");
interface ListedBackups {
  manifests: { manifest: BackupManifest }[];
  unreadable: { folder: string; id: string; reason: string }[];
  unreadableCount: number;
}
const PAST = new Date("2020-02-03T04:05:06Z");

const manifestOf = (id: string, files: BackupManifest["files"] = []): BackupManifest =>
  backupManifestSchema.parse({
    format: CONTAINER_BACKUP.format,
    id,
    createdAt: 1,
    target: { container: "app", stack: null },
    why: BACKUP_WHY.asked,
    members: [{ name: "app", image: "app:1", imageId: "sha256:a", method: "files", mounts: [], dump: null }],
    hasSettings: false,
    leftOut: [],
    files,
  });

describe("a backup's manifest as written", () => {
  const valid = manifestOf("20261101T000000Z");
  const mount = {
    type: "bind",
    source: "/srv",
    target: "/data",
    file: "data-0.tar.age",
    singleFile: false,
    sourceBytes: 1,
  };
  const withMount = (one: object) => ({ ...valid, members: [{ ...valid.members[0]!, mounts: [one] }] });

  it("reads the older format, for listing, and keeps a seal", () => {
    expect(backupManifestSchema.safeParse({ ...valid, format: CONTAINER_BACKUP.unsealedFormat }).success).toBe(true);
    expect(backupManifestSchema.parse({ ...valid, seal: "a".repeat(64) }).seal).toBe("a".repeat(64));
  });

  it("refuses a mount of any kind but a folder or a volume, a malformed seal, and fields it does not know", () => {
    expect(backupManifestSchema.safeParse(withMount(mount)).success).toBe(true);
    for (const type of ["tmpfs", "npipe", "cluster", ""]) {
      expect(backupManifestSchema.safeParse(withMount({ ...mount, type })).success).toBe(false);
    }
    expect(backupManifestSchema.safeParse({ ...valid, seal: "not-a-seal" }).success).toBe(false);
    expect(backupManifestSchema.safeParse({ ...valid, approvedBy: "admin" }).success).toBe(false);
  });
});

describe("the helper's copying", () => {
  let root: string;
  let roots: BackupCopyRoots;
  let identity: string;
  let recipient: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "backup-copy-"));
    roots = {
      data: join(root, "data"),
      backups: join(root, "backups"),
      copy: join(root, "copy"),
      tar: "tar",
      progress: () => undefined,
    };
    await mkdir(join(roots.data, "0"), { recursive: true });
    await mkdir(roots.backups);
    await mkdir(roots.copy);
    identity = await generateX25519Identity();
    recipient = await identityToRecipient(identity);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const data = (...parts: string[]) => join(roots.data, "0", ...parts);
  const captured = () => capture(roots, { folder: FOLDER, file: "data-0.tar.age", index: 0, recipient });

  it("brings a folder back whole: contents, modes, links and an empty folder", async () => {
    await writeFile(data("a.txt"), "hello");
    await chmod(data("a.txt"), 0o640);
    await mkdir(data("sub", "empty"), { recursive: true });
    await symlink("../a.txt", data("sub", "link"));
    await link(data("a.txt"), data("hard"));
    const { singleFile, sourceBytes } = await captured();
    expect(singleFile).toBe(false);
    expect(sourceBytes).toBeGreaterThan(0);

    await writeFile(data("a.txt"), "changed since");
    await writeFile(data("new"), "should go");
    await restore(roots, { folder: FOLDER, file: "data-0.tar.age", index: 0, identity, singleFile: false });

    expect(await readFile(data("a.txt"), "utf8")).toBe("hello");
    expect((await stat(data("a.txt"))).mode & 0o777).toBe(0o640);
    expect((await lstat(data("sub", "link"))).isSymbolicLink()).toBe(true);
    expect((await stat(data("hard"))).ino).toBe((await stat(data("a.txt"))).ino);
    expect((await stat(data("sub", "empty"))).isDirectory()).toBe(true);
    await expect(stat(data("new"))).rejects.toThrow();
  });

  it("keeps a file mounted alone as that same file, as Docker holds it open", async () => {
    await rm(join(roots.data, "0"), { recursive: true });
    await writeFile(join(roots.data, "0"), "the config");
    const { inode } = { inode: (await stat(join(roots.data, "0"))).ino };
    const { singleFile } = await captured();
    expect(singleFile).toBe(true);
    await writeFile(join(roots.data, "0"), "broken");
    await restore(roots, { folder: FOLDER, file: "data-0.tar.age", index: 0, identity, singleFile: true });
    expect(await readFile(join(roots.data, "0"), "utf8")).toBe("the config");
    expect((await stat(join(roots.data, "0"))).ino).toBe(inode);
  });

  describe("a file mounted alone, as more than its bytes", () => {
    const FILE_RESTORE = { folder: FOLDER, file: "data-0.tar.age", index: 0, singleFile: true };
    const mounted = () => join(roots.data, "0");
    const putBack = () => restore(roots, { ...FILE_RESTORE, identity });
    const shell = (command: string, ...args: string[]) => spawnSync(command, args, { encoding: "utf8" });
    const backedUp = async () => {
      await rm(mounted(), { recursive: true });
      await writeFile(mounted(), "the config");
      await chmod(mounted(), 0o640);
      await utimes(mounted(), PAST, PAST);
    };
    const canSetAcl = () => shell("setfacl", "-m", "u:65534:r", mounted()).status === 0;
    const canSetAttribute = (name: string, value: string) =>
      shell(
        "python3",
        "-c",
        "import os,sys; os.setxattr(sys.argv[1], sys.argv[2], sys.argv[3].encode())",
        mounted(),
        name,
        value,
      ).status === 0;
    const sealedArchive = async (...tarArguments: string[]) => {
      const made = spawnSync("tar", ["-cf", "-", ...tarArguments], { maxBuffer: 1 << 24 });
      expect(made.status).toBe(0);
      await store(roots, FOLDER, "data-0.tar.age", recipient, Readable.from([made.stdout]));
    };

    it("brings back its mode and time, and its contents, on that same file", async () => {
      await backedUp();
      const { ino } = await stat(mounted());
      await captured();
      await writeFile(mounted(), "broken and longer than it was");
      await chmod(mounted(), 0o600);
      await putBack();
      const after = await stat(mounted());
      expect(await readFile(mounted(), "utf8")).toBe("the config");
      expect(after.ino).toBe(ino);
      expect(after.mode & 0o7777).toBe(0o640);
      expect(Math.floor(after.mtimeMs / 1000)).toBe(PAST.getTime() / 1000);
    });

    it("brings back its access list", async (context) => {
      await backedUp();
      if (!canSetAcl()) return context.skip();
      await captured();
      shell("setfacl", "-b", mounted());
      await putBack();
      expect(shell("getfacl", "-cn", mounted()).stdout).toContain("user:65534:r--");
    });

    it("takes away an access list that came after the backup", async (context) => {
      await backedUp();
      await captured();
      if (!canSetAcl()) return context.skip();
      await putBack();
      expect(shell("getfacl", "-cn", mounted()).stdout).not.toContain("user:65534");
      expect((await stat(mounted())).mode & 0o7777).toBe(0o640);
    });

    it("accepts extended attributes the file still has, as they stay with it", async (context) => {
      await backedUp();
      if (!canSetAttribute("user.note", "kept")) return context.skip();
      await captured();
      await writeFile(mounted(), "broken");
      await putBack();
      expect(await readFile(mounted(), "utf8")).toBe("the config");
    });

    it("refuses when an extended attribute it had is gone, as it cannot be put back on this file", async (context) => {
      await backedUp();
      if (!canSetAttribute("user.note", "kept")) return context.skip();
      await captured();
      const removed = shell("python3", "-c", "import os,sys; os.removexattr(sys.argv[1], 'user.note')", mounted());
      expect(removed.status).toBe(0);
      await expect(putBack()).rejects.toThrow("metadata");
    });

    it("refuses an owner it may not give, rather than leave the file as someone else's", async () => {
      if (process.getuid?.() === 0) return;
      await backedUp();
      await sealedArchive("--owner=65534", "--numeric-owner", "-C", roots.data, "0");
      await expect(putBack()).rejects.toThrow();
    });

    it("refuses an archive of anything but one plain file, leaving the file as it is", async () => {
      await backedUp();
      await writeFile(join(roots.data, "other"), "other");
      await sealedArchive("-C", roots.data, "0", "other");
      await expect(putBack()).rejects.toThrow("one file");
      expect(await readFile(mounted(), "utf8")).toBe("the config");

      await symlink("/etc/passwd", join(roots.data, "link"));
      await sealedArchive("-C", roots.data, "link");
      await expect(putBack()).rejects.toThrow("one file");
      expect(await readFile(mounted(), "utf8")).toBe("the config");
    });

    it("writes where the mount is, whatever name the archive gave it", async () => {
      await backedUp();
      await writeFile(join(roots.data, "7"), "under another name");
      await sealedArchive("-C", roots.data, "7");
      await writeFile(join(roots.data, "7"), "untouched");
      await putBack();
      expect(await readFile(mounted(), "utf8")).toBe("under another name");
      expect(await readFile(join(roots.data, "7"), "utf8")).toBe("untouched");
    });
  });

  it("holds nothing readable: what is on disk does not show what went in", async () => {
    await writeFile(data("secret"), "PASSWORD=hunter2");
    await captured();
    const onDisk = await readFile(join(roots.backups, FOLDER, "data-0.tar.age"));
    expect(onDisk.includes("hunter2")).toBe(false);
  });

  it("finds a damaged copy, and a wrong key", async () => {
    await writeFile(data("a"), "x".repeat(100_000));
    const { sha256 } = await captured();
    const files = [{ file: "data-0.tar.age", sha256, isTar: true }];
    await expect(verify(roots, { folder: FOLDER, identity, files })).resolves.toEqual({});
    await expect(verify(roots, { folder: FOLDER, identity: await generateX25519Identity(), files })).rejects.toThrow();
    const path = join(roots.backups, FOLDER, "data-0.tar.age");
    const damaged = await readFile(path);
    damaged[damaged.length - 10]! ^= 0xff;
    await writeFile(path, damaged);
    await expect(verify(roots, { folder: FOLDER, identity, files })).rejects.toThrow("checksum");
  });

  it("seals what arrives on stdin, opens it again, and refuses nothing at all", async () => {
    const stored = await store(roots, FOLDER, "dump-0.sql.age", recipient, Readable.from([Buffer.from("SELECT 1;")]));
    expect(stored.sourceBytes).toBe(9);
    const chunks: Buffer[] = [];
    const out = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk);
        done();
      },
    });
    await reveal(roots, { folder: FOLDER, file: "dump-0.sql.age", identity }, out);
    expect(Buffer.concat(chunks).toString()).toBe("SELECT 1;");
    await expect(store(roots, FOLDER, "empty.sql.age", recipient, Readable.from([]))).rejects.toThrow();
  });

  it("empties a mount but leaves the mount itself", async () => {
    await writeFile(data("a"), "x");
    await empty(roots, { indexes: [0] });
    expect(await readdir(data())).toEqual([]);
  });

  it("measures, and says when it ran out of time rather than guessing", async () => {
    await writeFile(data("a"), "12345");
    const measured = await measure(roots, 1, 5_000);
    expect(measured.sizes).toEqual([5]);
    expect(measured.freeBytes).toBeGreaterThan(0);
    expect((await measure(roots, 1, -1)).sizes).toEqual([null]);
  });

  describe("finishing", () => {
    const finished = async (id: string, extra: object = {}) => {
      const unfinished = `app/${CONTAINER_BACKUP.unfinishedPrefix}${id}`;
      await mkdir(join(roots.backups, unfinished), { recursive: true });
      return finish(roots, {
        parent: "app",
        unfinished,
        manifest: manifestOf(id),
        key: KEY,
        name: "app",
        copy: false,
        ...extra,
      });
    };
    const idOf = (n: number) => `2026110${n}T000000Z`;

    it("makes it appear only once whole, with what it takes to restore by hand", async () => {
      await finished(idOf(1));
      const names = await readdir(join(roots.backups, "app", idOf(1)));
      expect(names.toSorted()).toEqual(["README.txt", "key.age", "manifest.json"]);
      expect(await readdir(join(roots.backups, "app"))).toEqual([idOf(1)]);
      const { manifest, key } = await read(roots, { folder: `app/${idOf(1)}` });
      expect(manifest.id).toBe(idOf(1));
      expect(key).toBe(KEY);
    });

    it("keeps the newest five, but not at the cost of the one being restored", async () => {
      for (let day = 1; day <= 5; day += 1) await finished(idOf(day));
      await finished(idOf(6), { protect: idOf(1) });
      expect(await readdir(join(roots.backups, "app"))).toContain(idOf(1));
      await finished(idOf(7));
      const left = (await readdir(join(roots.backups, "app"))).toSorted();
      expect(left).toEqual([3, 4, 5, 6, 7].map(idOf));
    });

    it("clears away what a crash left half-made", async () => {
      await mkdir(join(roots.backups, "app", `${CONTAINER_BACKUP.unfinishedPrefix}${idOf(9)}`), { recursive: true });
      await finished(idOf(1));
      expect(await readdir(join(roots.backups, "app"))).toEqual([idOf(1)]);
    });

    it("passes over one unreadable, and never lists one unfinished", async () => {
      await finished(idOf(1));
      await mkdir(join(roots.backups, "app", idOf(2)));
      await mkdir(join(roots.backups, "app", `${CONTAINER_BACKUP.unfinishedPrefix}${idOf(3)}`));
      const { manifests } = await list(roots, { folders: ["app", "nothing-here"] });
      expect(manifests).toHaveLength(1);
    });

    describe("a backup whose manifest is no good", () => {
      const SECRET = "secret-looking-value";
      const manifestAt = (id: string) => join(roots.backups, "app", id, CONTAINER_BACKUP.manifestFile);
      const damaged = async (id: string, content: string) => {
        await mkdir(join(roots.backups, "app", id), { recursive: true });
        await writeFile(manifestAt(id), content);
      };
      const listed = () => list(roots, { folders: ["app"] }) as Promise<ListedBackups>;

      it("lists those around it in order, and names it with why, in no words of its own", async () => {
        await finished(idOf(1));
        await damaged(idOf(2), `{ "password": "${SECRET}"`);
        await finished(idOf(3));
        await damaged(idOf(4), JSON.stringify({ format: 999, password: SECRET }));
        await finished(idOf(5));
        const { manifests, unreadable } = await listed();
        expect(manifests.map(({ manifest }) => manifest.id)).toEqual([idOf(1), idOf(3), idOf(5)]);
        expect(unreadable).toEqual([
          { folder: "app", id: idOf(2), reason: BACKUP_UNREADABLE.notJson },
          { folder: "app", id: idOf(4), reason: BACKUP_UNREADABLE.notValid },
        ]);
        expect(JSON.stringify(unreadable)).not.toContain(SECRET);
        // What the control plane takes from a runner, and the broken ones left for a person to repair.
        expect(
          backupAnswerSchema.safeParse({ refusal: null, backups: [], unreadable, unreadableCount: 2 }).success,
        ).toBe(true);
        expect(await readFile(manifestAt(idOf(2)), "utf8")).toContain(SECRET);
      });

      it("will not read one past its size, or anything but a plain file", async () => {
        await finished(idOf(1));
        await damaged(idOf(2), " ".repeat(CONTAINER_BACKUP.manifestBytes + 1));
        await mkdir(join(roots.backups, "app", idOf(3)));
        await symlink("/etc/passwd", manifestAt(idOf(3)));
        await mkdir(join(roots.backups, "app", idOf(4)));
        expect(spawnSync("mkfifo", [manifestAt(idOf(4))]).status).toBe(0);
        const { manifests, unreadable } = await listed();
        expect(manifests).toHaveLength(1);
        expect(unreadable.map(({ reason }) => reason)).toEqual([
          BACKUP_UNREADABLE.tooBig,
          BACKUP_UNREADABLE.unreadable,
          BACKUP_UNREADABLE.unreadable,
        ]);
      }, 5_000);

      it("does not offer one saying it is another backup than its folder", async () => {
        await finished(idOf(1));
        const other = await readFile(manifestAt(idOf(1)), "utf8");
        await damaged(idOf(2), other);
        const { manifests, unreadable } = await listed();
        expect(manifests.map(({ manifest }) => manifest.id)).toEqual([idOf(1)]);
        expect(unreadable).toEqual([{ folder: "app", id: idOf(2), reason: BACKUP_UNREADABLE.notValid }]);
      });

      it("says how many it left unnamed rather than grow without end", async () => {
        const many = CONTAINER_BACKUP.unreadableShown + 2;
        for (let index = 1; index <= many; index += 1) {
          await damaged(`202611${String(index).padStart(2, "0")}T000000Z`, "{");
        }
        const { unreadable, unreadableCount } = await listed();
        expect(unreadable).toHaveLength(CONTAINER_BACKUP.unreadableShown);
        expect(unreadableCount).toBe(many);
      });

      it("is still refused when asked for by name", async () => {
        await damaged(idOf(2), "{");
        await expect(read(roots, { folder: `app/${idOf(2)}` })).rejects.toThrow();
      });
    });

    it("says when the second copy failed, and the backup still stands", async () => {
      await rm(roots.copy, { recursive: true });
      await writeFile(roots.copy, "a file, not a folder");
      const { copyError } = await finished(idOf(1), { copy: true });
      expect(copyError).not.toBeNull();
      expect(await readdir(join(roots.backups, "app"))).toEqual([idOf(1)]);
    });

    it("makes the second copy", async () => {
      expect((await finished(idOf(1), { copy: true })).copyError).toBeNull();
      expect(await readdir(join(roots.copy, "app"))).toEqual([idOf(1)]);
    });
  });
});
