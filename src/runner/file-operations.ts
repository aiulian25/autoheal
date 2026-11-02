import {
  OPERATOR_REFUSAL,
  OPERATOR_ISOLATION_REFUSAL,
  operatorAccessTarget,
  type OperatorAccessAuthorizer,
} from "./operator-authorization.js";
import {
  FILE_COMMANDS,
  FILE_CONTENT_LIMIT_BYTES,
  FILE_ENTRIES_LIMIT,
  FILE_ERRORS,
  FILE_FIELD_CHARACTERS,
  FILE_KIND,
  FILE_LISTING_LIMIT_BYTES,
  FILE_OPERATION,
  GO_FILE_MODE,
  NEW_FILE_MODE,
  NEW_FOLDER_MODE,
  RUNNER_MESSAGES,
  TAR,
  type FileKind,
  type FileOperation,
} from "../shared/constants.js";
import { describeError } from "../shared/errors.js";
import { log } from "../shared/log.js";
import type { FileAnswer, FileEntry, FileRequest } from "../shared/protocol.js";
import { containerAccessRefusal, type ContainerAccessSettings } from "./container-access-guard.js";
import type { DockerClient } from "./docker-client.js";
import { singleEntryArchive } from "./tar.js";

export interface FileOperationsDependencies {
  authorizeOperator?: OperatorAccessAuthorizer;
  docker: Pick<DockerClient, "inspect" | "runCommand" | "pathStat" | "readEntry" | "putArchive"> &
    Partial<Pick<DockerClient, "containerSummaries" | "inspectVolume">>;
  settings: ContainerAccessSettings;
}

// One line of `ls -la` in C's words: kind and permissions, links, owner, group, size (or a device's numbers),
// the date as ls prints it (a time this year, a year before), and the name, with "-> target" for a link.
const LISTING_LINE =
  /^([-dlcbpsD?])([-rwxsStT]{9})\S*\s+\d+\s+(\S+)\s+(\S+)\s+(?:(\d+)|\d+,\s*\d+)\s+([A-Z][a-z]{2}\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4}))\s(.*)$/u;
const KINDS: Record<string, FileKind> = { "-": FILE_KIND.file, d: FILE_KIND.folder, l: FILE_KIND.link };
const LINK_ARROW = " -> ";
const OWN_ENTRIES = new Set([".", ".."]);
// A command the container does not have: "not found" (127), or found but not runnable (126).
const MISSING_COMMAND_EXIT_CODES = new Set([126, 127]);
const ENOUGH_LINK_HOPS = 8;

const answered = (fields: Partial<FileAnswer>): FileAnswer => ({
  error: null,
  entries: null,
  truncated: false,
  content: null,
  ...fields,
});
const failed = (error: string) => answered({ error });
const done = () => answered({});
const field = (text: string) => text.slice(0, FILE_FIELD_CHARACTERS);
const folderOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const isFolder = (mode: number) => (mode & GO_FILE_MODE.folder) !== 0;
const isLink = (mode: number) => (mode & GO_FILE_MODE.link) !== 0;

/** A folder's entries as `ls -la` printed them, itself and its parent left out; lines it could not read too. */
export function parseListing(output: string): FileEntry[] {
  return output.split("\n").flatMap((line): FileEntry[] => {
    const match = LISTING_LINE.exec(line.trimEnd());
    if (match === null) {
      return [];
    }
    const [, kindLetter, permissions, owner, group, size, modified, rest] = match as unknown as string[];
    const kind = KINDS[kindLetter!] ?? FILE_KIND.other;
    const arrow = kind === FILE_KIND.link ? rest!.indexOf(LINK_ARROW) : -1;
    const name = arrow < 0 ? rest! : rest!.slice(0, arrow);
    if (OWN_ENTRIES.has(name)) {
      return [];
    }
    return [
      {
        name: field(name),
        kind,
        size: Number(size ?? 0),
        mode: `${kindLetter}${permissions}`,
        owner: field(owner!),
        group: field(group!),
        modified: field(modified!.replace(/\s+/gu, " ")),
        linkTarget: arrow < 0 ? null : rest!.slice(arrow + LINK_ARROW.length),
      },
    ];
  });
}

/**
 * A container's files, as people ask for them in the dashboard. Reading and writing go through Docker's
 * archive calls, which work in any container and keep a file's owner and mode; listing, renaming and removing
 * run `ls`, `mv` and `rm` in it, as its own user, given as arguments (never through a shell).
 */
export class FileOperations {
  private readonly handlers: Record<FileOperation, (request: FileRequest) => Promise<FileAnswer>> = {
    [FILE_OPERATION.list]: (request) => this.list(request),
    [FILE_OPERATION.read]: (request) => this.read(request),
    [FILE_OPERATION.write]: (request) => this.write(request),
    [FILE_OPERATION.makeFolder]: (request) => this.makeFolder(request),
    [FILE_OPERATION.rename]: (request) => this.rename(request),
    [FILE_OPERATION.remove]: (request) => this.remove(request),
  };

  constructor(private readonly dependencies: FileOperationsDependencies) {}

  async answer(request: FileRequest): Promise<FileAnswer> {
    const { settings, docker } = this.dependencies;
    try {
      const refusal = await containerAccessRefusal(request.containerName, settings, docker);
      if (refusal !== null) {
        return failed(refusal);
      }
      await this.requireOperator(request);
      return await this.handlers[request.operation](request);
    } catch (error) {
      return failed(describeError(error));
    }
  }

  private async requireOperator(request: FileRequest) {
    if (request.operatorUserId === undefined) return;
    const target = await operatorAccessTarget(request.containerName, this.dependencies.docker);
    if (target === null) throw new Error(OPERATOR_ISOLATION_REFUSAL);
    if (!(await this.dependencies.authorizeOperator?.(request.id, target).catch(() => false)))
      throw new Error(OPERATOR_REFUSAL);
  }

  private async list(request: FileRequest): Promise<FileAnswer> {
    // A trailing slash lists what a link to a folder leads to, not the link.
    const folder = request.path === "/" ? "/" : `${request.path}/`;
    const result = await this.dependencies.docker.runCommand(
      request.containerName,
      [...FILE_COMMANDS.list, folder],
      FILE_LISTING_LIMIT_BYTES,
    );
    if (result.exitCode !== null && MISSING_COMMAND_EXIT_CODES.has(result.exitCode)) {
      return failed(FILE_ERRORS.noList);
    }
    const entries = parseListing(result.stdout);
    if (result.exitCode !== 0 && entries.length === 0) {
      return failed(result.stderr.trim() || result.stdout.trim());
    }
    const followed = await this.followLinks(request.containerName, folder, entries);
    return answered({
      entries: followed.slice(0, FILE_ENTRIES_LIMIT),
      truncated: result.truncated || entries.length > FILE_ENTRIES_LIMIT,
    });
  }

  // A link is shown as what it leads to, a folder or a file, its target beside it; one that leads nowhere stays
  // a link. Asked only of a folder that has links.
  private async followLinks(containerName: string, folder: string, entries: FileEntry[]): Promise<FileEntry[]> {
    if (!entries.some((entry) => entry.kind === FILE_KIND.link)) {
      return entries;
    }
    const result = await this.dependencies.docker.runCommand(
      containerName,
      [...FILE_COMMANDS.listFollowingLinks, folder],
      FILE_LISTING_LIMIT_BYTES,
    );
    const kinds = new Map(parseListing(result.stdout).map((entry) => [entry.name, entry.kind]));
    return entries.map((entry) =>
      entry.kind === FILE_KIND.link ? { ...entry, kind: kinds.get(entry.name) ?? FILE_KIND.link } : entry,
    );
  }

  private async read(request: FileRequest): Promise<FileAnswer> {
    const path = await this.resolveLinks(request.containerName, request.path);
    const stat = await this.dependencies.docker.pathStat(request.containerName, path);
    if (stat === null) {
      return failed(FILE_ERRORS.notFound(request.path));
    }
    if (isFolder(stat.mode)) {
      return failed(FILE_ERRORS.folder(request.path));
    }
    if (stat.size > FILE_CONTENT_LIMIT_BYTES) {
      return failed(FILE_ERRORS.tooBig(request.path));
    }
    const entry = await this.dependencies.docker.readEntry(request.containerName, path, FILE_CONTENT_LIMIT_BYTES);
    if (entry === null || entry.content === null) {
      return failed(FILE_ERRORS.notFound(request.path));
    }
    return answered({ content: entry.content.toString("base64") });
  }

  // A file keeps its owner and mode, and one reached through a link is written where it leads; a new one takes
  // its folder's owner.
  private async write(request: FileRequest): Promise<FileAnswer> {
    const { docker } = this.dependencies;
    const content = Buffer.from(request.content ?? "", "base64");
    const path = await this.resolveLinks(request.containerName, request.path);
    const existing = await docker.readEntry(request.containerName, path, 0);
    if (existing !== null && existing.header.type === TAR.types.folder) {
      return failed(FILE_ERRORS.folder(request.path));
    }
    const owner = existing ?? (await docker.readEntry(request.containerName, folderOf(path), 0));
    if (owner === null) {
      return failed(FILE_ERRORS.notFound(folderOf(path)));
    }
    const mode = existing === null ? NEW_FILE_MODE : existing.header.mode;
    const archive = singleEntryArchive(
      { name: nameOf(path), type: TAR.types.file, mode, uid: owner.header.uid, gid: owner.header.gid },
      content,
    );
    await this.requireOperator(request);
    await docker.putArchive(request.containerName, folderOf(path), archive);
    this.logChange(request);
    return done();
  }

  private async makeFolder(request: FileRequest): Promise<FileAnswer> {
    const { docker } = this.dependencies;
    if ((await docker.pathStat(request.containerName, request.path)) !== null) {
      return failed(FILE_ERRORS.exists(request.path));
    }
    const parent = await docker.readEntry(request.containerName, folderOf(request.path), 0);
    if (parent === null) {
      return failed(FILE_ERRORS.notFound(folderOf(request.path)));
    }
    const { uid, gid } = parent.header;
    const folder = { name: nameOf(request.path), type: TAR.types.folder, mode: NEW_FOLDER_MODE, uid, gid };
    await this.requireOperator(request);
    await docker.putArchive(request.containerName, folderOf(request.path), singleEntryArchive(folder, Buffer.alloc(0)));
    this.logChange(request);
    return done();
  }

  // Never over what is there: mv would replace it without asking.
  private async rename(request: FileRequest): Promise<FileAnswer> {
    const to = request.to ?? request.path;
    if ((await this.dependencies.docker.pathStat(request.containerName, to)) !== null) {
      return failed(FILE_ERRORS.exists(to));
    }
    return this.runChange(request, [...FILE_COMMANDS.move, request.path, to]);
  }

  private remove(request: FileRequest): Promise<FileAnswer> {
    return this.runChange(request, [...FILE_COMMANDS.remove, request.path]);
  }

  private async runChange(request: FileRequest, command: string[]): Promise<FileAnswer> {
    await this.requireOperator(request);
    const result = await this.dependencies.docker.runCommand(request.containerName, command, FILE_LISTING_LIMIT_BYTES);
    if (result.exitCode !== 0) {
      return failed(FILE_ERRORS.failed(command[0]!, (result.stderr || result.stdout).trim()));
    }
    this.logChange(request);
    return done();
  }

  // Docker's archive of a link is the link itself: a file read through one is read where it leads.
  private async resolveLinks(containerName: string, path: string): Promise<string> {
    let current = path;
    for (let hop = 0; hop < ENOUGH_LINK_HOPS; hop += 1) {
      const stat = await this.dependencies.docker.pathStat(containerName, current);
      if (stat === null || !isLink(stat.mode)) {
        return current;
      }
      current = stat.linkTarget.startsWith("/") ? stat.linkTarget : `${folderOf(current)}/${stat.linkTarget}`;
    }
    return current;
  }

  private logChange(request: FileRequest) {
    log(RUNNER_MESSAGES.fileChanged(request.operation, request.containerName, request.path, request.requestedBy));
  }
}
