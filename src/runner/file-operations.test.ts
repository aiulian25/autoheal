import { Readable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FILE_CONTENT_LIMIT_BYTES,
  FILE_OPERATION,
  GO_FILE_MODE,
  TAR,
  type FileOperation,
} from "../shared/constants.js";
import type { FileRequest } from "../shared/protocol.js";
import type { CommandResult, PathStat } from "./docker-client.js";
import { FileOperations, parseListing } from "./file-operations.js";
import type { ContainerDetails } from "./incident-report.js";
import { readFirstEntry } from "./tar.js";

// `ls -la /t/ /dev/null` in alpine:3.20 (BusyBox) and in Debian (GNU coreutils), as captured on 24 October.
const BUSYBOX = `crw-rw-rw-    1 root     root        1,   3 Oct 24 13:13 /dev/null

/t/:
total 16
drwxr-xr-x    3 root     root          4096 Oct 24 13:13 .
drwxr-xr-x    1 root     root          4096 Oct 24 13:13 ..
lrwxrwxrwx    1 root     root            13 Oct 24 13:13 link -> /etc/hostname
drwxr-xr-x    2 root     root          4096 Oct 24 13:13 sub
-rw-r--r--    1 root     root             3 Oct 24 13:13 with space.txt
`;
const GNU = `drwxr-xr-x 3 root root 4096 Oct 24 13:13 .
drwxr-xr-x 1 root root 4096 Oct 24 13:13 ..
lrwxrwxrwx 1 root root   13 Oct 24 13:13 link -> /etc/hostname
-rw-r--r-- 1 www-data www-data    0 Jan  2  2023 old
drwxr-xr-x 2 root root 4096 Oct 24 13:13 sub
`;

interface FakeNode {
  kind: "file" | "folder" | "link";
  mode: number;
  uid: number;
  gid: number;
  content?: Buffer;
  target?: string;
}

const TYPES = { file: TAR.types.file, folder: TAR.types.folder, link: TAR.types.link } as const;
const KIND_BITS = { file: 0, folder: GO_FILE_MODE.folder, link: GO_FILE_MODE.link } as const;

/** A running container's files in memory, behind the Docker calls the operations make. */
class FakeContainer {
  readonly nodes = new Map<string, FakeNode>();
  readonly commands: string[][] = [];
  answer: (command: string[]) => CommandResult = () => ({ exitCode: 0, stdout: "", stderr: "", truncated: false });

  readonly docker = {
    inspect: async () => ({ State: { Status: "running" } }) as ContainerDetails,
    runCommand: async (_reference: string, command: readonly string[]) => {
      this.commands.push([...command]);
      return this.answer([...command]);
    },
    pathStat: async (_reference: string, path: string): Promise<PathStat | null> => {
      const node = this.nodes.get(path);
      return node === undefined
        ? null
        : {
            name: path,
            size: node.content?.length ?? 0,
            mode: KIND_BITS[node.kind] + node.mode,
            linkTarget: node.target ?? "",
          };
    },
    readEntry: async (_reference: string, path: string, limitBytes: number) => {
      const node = this.nodes.get(path);
      if (node === undefined) {
        return null;
      }
      const size = node.content?.length ?? 0;
      const header = {
        name: path,
        type: TYPES[node.kind],
        mode: node.mode,
        uid: node.uid,
        gid: node.gid,
        size,
        linkName: "",
      };
      return { header, content: node.kind === "file" && size <= limitBytes ? node.content! : null };
    },
    putArchive: async (_reference: string, folder: string, archive: Buffer) => {
      const entry = (await readFirstEntry(Readable.from([archive]), archive.length))!;
      const kind = entry.header.type === TAR.types.folder ? "folder" : "file";
      const { mode, uid, gid } = entry.header;
      const path = `${folder === "/" ? "" : folder}/${entry.header.name}`;
      this.nodes.set(path, { kind, mode, uid, gid, ...(kind === "file" ? { content: entry.content! } : {}) });
    },
  };
}

const request = (operation: FileOperation, path: string, fields: Partial<FileRequest> = {}): FileRequest => ({
  id: "r1",
  containerName: "paperless",
  operation,
  path,
  to: null,
  content: null,
  requestedBy: "admin",
  ...fields,
});

const base64 = (text: string) => Buffer.from(text).toString("base64");

describe("a container's files", () => {
  let container: FakeContainer;
  let files: FileOperations;

  beforeEach(() => {
    container = new FakeContainer();
    container.nodes.set("/srv", { kind: "folder", mode: 0o755, uid: 33, gid: 33 });
    container.nodes.set("/srv/app.env", { kind: "file", mode: 0o640, uid: 33, gid: 34, content: Buffer.from("A=1\n") });
    container.nodes.set("/srv/current", { kind: "link", mode: 0o777, uid: 0, gid: 0, target: "app.env" });
    const settings = {
      containerAccess: true,
      dryRun: false,
      protectedContainers: new Set<string>(),
      selfContainerName: "runner",
    };
    files = new FileOperations({ docker: container.docker, settings });
  });

  it("reads ls as BusyBox and GNU print it: kinds, links, names with spaces, dates as printed", () => {
    expect(parseListing(BUSYBOX)).toEqual([
      {
        name: "/dev/null",
        kind: "other",
        size: 0,
        mode: "crw-rw-rw-",
        owner: "root",
        group: "root",
        modified: "Oct 24 13:13",
        linkTarget: null,
      },
      {
        name: "link",
        kind: "link",
        size: 13,
        mode: "lrwxrwxrwx",
        owner: "root",
        group: "root",
        modified: "Oct 24 13:13",
        linkTarget: "/etc/hostname",
      },
      {
        name: "sub",
        kind: "folder",
        size: 4096,
        mode: "drwxr-xr-x",
        owner: "root",
        group: "root",
        modified: "Oct 24 13:13",
        linkTarget: null,
      },
      {
        name: "with space.txt",
        kind: "file",
        size: 3,
        mode: "-rw-r--r--",
        owner: "root",
        group: "root",
        modified: "Oct 24 13:13",
        linkTarget: null,
      },
    ]);
    expect(parseListing(GNU).map((entry) => [entry.name, entry.owner, entry.modified])).toEqual([
      ["link", "root", "Oct 24 13:13"],
      ["old", "www-data", "Jan 2 2023"],
      ["sub", "root", "Oct 24 13:13"],
    ]);
  });

  it("lists a folder with ls, through a link to one, and says when the container has no ls", async () => {
    // Followed, the link turns out to lead to a file: it is shown as one, its target beside it.
    const followed = GNU.replace(
      "lrwxrwxrwx 1 root root   13 Oct 24 13:13 link -> /etc/hostname",
      "-rw-r--r-- 1 root root 6 Oct 24 13:13 link",
    );
    container.answer = (command) => ({
      exitCode: 0,
      stdout: command.includes("-laL") ? followed : GNU,
      stderr: "",
      truncated: false,
    });
    const listed = await files.answer(request(FILE_OPERATION.list, "/srv"));
    expect(listed.entries!.map((entry) => [entry.name, entry.kind, entry.linkTarget])).toEqual([
      ["link", "file", "/etc/hostname"],
      ["old", "file", null],
      ["sub", "folder", null],
    ]);
    expect(container.commands).toEqual([
      ["ls", "-la", "/srv/"],
      ["ls", "-laL", "/srv/"],
    ]);

    container.answer = () => ({
      exitCode: 2,
      stdout: "",
      stderr: "ls: /nope/: No such file or directory\n",
      truncated: false,
    });
    expect((await files.answer(request(FILE_OPERATION.list, "/nope"))).error).toBe(
      "ls: /nope/: No such file or directory",
    );
    container.answer = () => ({ exitCode: 127, stdout: "", stderr: "exec: ls: not found", truncated: false });
    expect((await files.answer(request(FILE_OPERATION.list, "/"))).error).toBe(
      "This container has no ls, so its folders can't be listed here.",
    );
  });

  it("reads a file, through a link too, but not a folder, and nothing past the limit", async () => {
    expect((await files.answer(request(FILE_OPERATION.read, "/srv/app.env"))).content).toBe(base64("A=1\n"));
    expect((await files.answer(request(FILE_OPERATION.read, "/srv/current"))).content).toBe(base64("A=1\n"));
    expect((await files.answer(request(FILE_OPERATION.read, "/srv"))).error).toBe("/srv is a folder.");
    expect((await files.answer(request(FILE_OPERATION.read, "/srv/gone"))).error).toBe("/srv/gone is not there.");
    container.nodes.set("/srv/huge", {
      kind: "file",
      mode: 0o644,
      uid: 0,
      gid: 0,
      content: Buffer.alloc(FILE_CONTENT_LIMIT_BYTES + 1),
    });
    expect((await files.answer(request(FILE_OPERATION.read, "/srv/huge"))).error).toMatch(/bigger than 8 MB/u);
  });

  it("writes a file keeping its owner and mode, through a link where it leads, and a new one as its folder's", async () => {
    await files.answer(request(FILE_OPERATION.write, "/srv/current", { content: base64("A=2\n") }));
    expect(container.nodes.get("/srv/app.env")).toEqual({
      kind: "file",
      mode: 0o640,
      uid: 33,
      gid: 34,
      content: Buffer.from("A=2\n"),
    });
    expect(container.nodes.get("/srv/current")!.kind).toBe("link");

    await files.answer(request(FILE_OPERATION.write, "/srv/new.txt", { content: base64("hello") }));
    expect(container.nodes.get("/srv/new.txt")).toMatchObject({ mode: 0o644, uid: 33, gid: 33 });
    expect((await files.answer(request(FILE_OPERATION.write, "/srv", { content: base64("x") }))).error).toBe(
      "/srv is a folder.",
    );
    expect((await files.answer(request(FILE_OPERATION.write, "/gone/x", { content: base64("x") }))).error).toBe(
      "/gone is not there.",
    );
  });

  it("makes a folder as its parent's, renames without replacing, and removes", async () => {
    await files.answer(request(FILE_OPERATION.makeFolder, "/srv/cache"));
    expect(container.nodes.get("/srv/cache")).toEqual({ kind: "folder", mode: 0o755, uid: 33, gid: 33 });
    expect((await files.answer(request(FILE_OPERATION.makeFolder, "/srv/cache"))).error).toBe(
      "/srv/cache is already there.",
    );

    expect((await files.answer(request(FILE_OPERATION.rename, "/srv/cache", { to: "/srv/app.env" }))).error).toBe(
      "/srv/app.env is already there.",
    );
    await files.answer(request(FILE_OPERATION.rename, "/srv/cache", { to: "/srv/store" }));
    container.answer = () => ({
      exitCode: 1,
      stdout: "",
      stderr: "rm: can't remove '/srv/x': Permission denied\n",
      truncated: false,
    });
    expect((await files.answer(request(FILE_OPERATION.remove, "/srv/x"))).error).toBe(
      "rm failed: rm: can't remove '/srv/x': Permission denied",
    );
    expect(container.commands).toEqual([
      ["mv", "/srv/cache", "/srv/store"],
      ["rm", "-rf", "/srv/x"],
    ]);
  });

  it("reaches nothing its host does not allow", async () => {
    const settings = {
      containerAccess: false,
      dryRun: false,
      protectedContainers: new Set<string>(),
      selfContainerName: "runner",
    };
    const refused = new FileOperations({ docker: container.docker, settings });
    expect((await refused.answer(request(FILE_OPERATION.read, "/srv/app.env"))).error).toBe(
      "Refused: this host's CONTAINER_ACCESS is not on.",
    );
    expect(container.commands).toEqual([]);
  });
});
