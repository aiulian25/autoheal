import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { HOST_HELPER, MILLISECONDS_PER_SECOND, TAR, VOLUME_LOOK } from "../shared/constants.js";
import { describeError } from "../shared/errors.js";
import type { VolumeLookAnswer, VolumeLookEntry } from "../shared/volumes.js";
import type { DockerClient, ImageSummary } from "./docker-client.js";
import { modifiedOf, parseHeader } from "./tar.js";

type Look = Pick<DockerClient, "inspectVolume" | "images" | "inspectImage" | "create" | "remove" | "getArchiveStream">;

const refused = (error: string): VolumeLookAnswer => ({ error, entries: [], partial: false });
const paddingOf = (size: number) => (TAR.blockBytes - (size % TAR.blockBytes)) % TAR.blockBytes;
const FOLDER_ENDING = /\/+$/;

// A PAX record: "<length> path=<name>\n".
function paxPathOf(records: Buffer): string | null {
  const match = new RegExp(`(?:^|\\n)\\d+ ${TAR.paxPathKey}=([^\\n]*)\\n`).exec(records.toString("utf8"));
  return match?.[1] ?? null;
}

/**
 * The names in a tar stream, read as it comes and its files' contents skipped: what a folder holds, without keeping
 * any of it. It stops early, and says so, at the limits of entries, bytes or time.
 */
export async function listArchive(
  stream: Readable,
  clock: () => number = Date.now,
): Promise<{ entries: VolumeLookEntry[]; partial: boolean }> {
  const entries: VolumeLookEntry[] = [];
  const started = clock();
  let pending: Buffer = Buffer.alloc(0);
  let skip = 0;
  let read = 0;
  let longName: string | null = null;
  let extended: { kind: string; bytes: number } | null = null;
  const stopEarly = () =>
    entries.length >= VOLUME_LOOK.entries ||
    read >= VOLUME_LOOK.readBytes ||
    clock() - started >= VOLUME_LOOK.milliseconds;
  try {
    for await (const chunk of stream) {
      read += (chunk as Buffer).length;
      pending = pending.length === 0 ? (chunk as Buffer) : Buffer.concat([pending, chunk as Buffer]);
      for (;;) {
        if (skip > 0) {
          const dropped = Math.min(skip, pending.length);
          pending = pending.subarray(dropped);
          skip -= dropped;
          if (skip > 0) break;
        }
        if (extended !== null) {
          const whole = extended.bytes + paddingOf(extended.bytes);
          if (pending.length < whole) break;
          const body = pending.subarray(0, extended.bytes);
          if (extended.kind === TAR.types.pax) longName = paxPathOf(body) ?? longName;
          if (extended.kind === TAR.types.gnuLongName) longName = body.toString("utf8").replace(/\0+$/, "");
          pending = pending.subarray(whole);
          extended = null;
        }
        if (pending.length < TAR.blockBytes) break;
        const block = pending.subarray(0, TAR.blockBytes);
        pending = pending.subarray(TAR.blockBytes);
        if (block.every((byte) => byte === 0)) continue;
        const header = parseHeader(block);
        if (TAR.extendedTypes.has(header.type)) {
          extended = { kind: header.type, bytes: header.size };
          continue;
        }
        const path = (longName ?? header.name).replace(FOLDER_ENDING, "");
        longName = null;
        const inside = path.slice(path.indexOf("/") + 1);
        if (path.includes("/")) {
          entries.push({
            path: inside.slice(0, VOLUME_LOOK.pathCharacters),
            folder: header.type === TAR.types.folder,
            sizeBytes: header.size,
            modifiedAt: modifiedOf(block) * MILLISECONDS_PER_SECOND,
          });
        }
        skip = header.size + paddingOf(header.size);
      }
      if (stopEarly()) return { entries: entries.slice(0, VOLUME_LOOK.entries), partial: true };
    }
    return { entries, partial: false };
  } finally {
    stream.destroy();
  }
}

// Created to read from, never started: it needs no more of its image than that it exists. An image declaring volumes
// of its own would make one more nameless volume, the very thing being cleared.
async function imageToBorrow(docker: Pick<DockerClient, "images" | "inspectImage">): Promise<ImageSummary | null> {
  const smallestFirst = (await docker.images()).toSorted((first, second) => first.Size - second.Size);
  for (const image of smallestFirst) {
    const details = await docker.inspectImage(image.Id);
    if (details !== null && Object.keys(details.Config?.Volumes ?? {}).length === 0) return image;
  }
  return null;
}

/**
 * What a volume holds, read through a container that never runs: nothing executes, no image is downloaded, and it
 * works with any image on the host, even one without a shell. Read only, and it is gone when this ends.
 */
export async function lookInsideVolume(
  docker: Look,
  settings: { containerAccess: boolean; dryRun: boolean },
  name: string,
): Promise<VolumeLookAnswer> {
  if (!settings.containerAccess) return refused(VOLUME_LOOK.errors.accessOff);
  if (settings.dryRun) return refused(VOLUME_LOOK.errors.watching);
  try {
    if ((await docker.inspectVolume(name)) === null) return refused(VOLUME_LOOK.errors.gone);
    const image = await imageToBorrow(docker);
    if (image === null) return refused(VOLUME_LOOK.errors.noImage);
    const helper = `${HOST_HELPER.containerPrefix}${VOLUME_LOOK.helperPrefix}${randomUUID()}`;
    await docker.create(helper, {
      Image: image.Id,
      Cmd: [VOLUME_LOOK.target],
      Labels: { [HOST_HELPER.label]: HOST_HELPER.labelValue },
      NetworkDisabled: true,
      HostConfig: {
        NetworkMode: HOST_HELPER.network,
        Mounts: [
          { Type: "volume", Source: name, Target: VOLUME_LOOK.target, ReadOnly: true, VolumeOptions: { NoCopy: true } },
        ],
      },
    });
    try {
      const { entries, partial } = await listArchive(await docker.getArchiveStream(helper, VOLUME_LOOK.target));
      return { error: null, entries, partial };
    } finally {
      await docker.remove(helper).catch(() => undefined);
    }
  } catch (error) {
    return refused(describeError(error));
  }
}
