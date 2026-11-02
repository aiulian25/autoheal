import {
  DIGEST_PATTERN,
  DIGEST_SEPARATOR,
  KEPT_IMAGE_TAG_SUFFIX,
  MILLISECONDS_PER_SECOND,
  REPORT_LIMITS,
  UNTAGGED_DIGEST,
  UNTAGGED_IMAGE,
} from "../shared/constants.js";
import type { UnusedImage } from "../shared/protocol.js";
import type { DockerClient, ImageSummary } from "./docker-client.js";

type ImageLister = Pick<DockerClient, "containerSummaries" | "images">;

export const namesOf = (image: ImageSummary) => (image.RepoTags ?? []).filter((name) => name !== UNTAGGED_IMAGE);

export const sizeOf = (images: readonly ImageSummary[]) => images.reduce((total, image) => total + image.Size, 0);

// The image a container ran before its last update, kept for going back to it by hand.
export const isKeptByUpdate = (image: ImageSummary) =>
  namesOf(image).some((name) => name.endsWith(KEPT_IMAGE_TAG_SUFFIX));

/** The images no container uses, not even a stopped one: Docker refuses to remove the others. */
export async function unusedImages(docker: ImageLister): Promise<ImageSummary[]> {
  const [containers, images] = await Promise.all([docker.containerSummaries(), docker.images()]);
  const inUse = new Set(containers.map((container) => container.ImageID));
  return images.filter((image) => !inUse.has(image.Id));
}

const repositoryOf = (image: ImageSummary) =>
  image.RepoDigests?.find((digest) => digest !== UNTAGGED_DIGEST)?.split(DIGEST_SEPARATOR)[0] ?? null;

/** What the dashboard hears of them, newest first. */
export async function unusedImagesReport(docker: ImageLister): Promise<UnusedImage[]> {
  return (
    (await unusedImages(docker))
      // Docker's ids are digests; anything else would have the control plane refuse the whole heartbeat.
      .filter((image) => DIGEST_PATTERN.test(image.Id))
      .sort((first, second) => second.Created - first.Created)
      .slice(0, REPORT_LIMITS.unusedImages)
      .map((image) => ({
        id: image.Id,
        tags: namesOf(image).slice(0, REPORT_LIMITS.tagsPerImage),
        repository: repositoryOf(image),
        sizeBytes: image.Size,
        createdAt: image.Created * MILLISECONDS_PER_SECOND,
        keptByUpdate: isKeptByUpdate(image),
      }))
  );
}
