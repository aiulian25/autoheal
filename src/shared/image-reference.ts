import { DIGEST_SEPARATOR, IMAGE_REFERENCE, REGISTRY } from "./constants.js";

const { tagSeparator, pathSeparator } = IMAGE_REFERENCE;

/** "ghcr.io/owner/app:2.1" → ghcr.io/owner/app and 2.1; no tag means latest. A port is not a tag. */
export function splitTag(reference: string): { name: string; tag: string } {
  const lastSlash = reference.lastIndexOf(pathSeparator);
  const tagAt = reference.indexOf(tagSeparator, lastSlash + 1);
  return tagAt === -1
    ? { name: reference, tag: REGISTRY.defaultTag }
    : { name: reference.slice(0, tagAt), tag: reference.slice(tagAt + 1) };
}

const withoutDigest = (image: string) => image.split(DIGEST_SEPARATOR)[0]!;

/** "ghcr.io/org/app:2.13" and "app@sha256:…" both become the repository: ghcr.io/org/app, app. */
export const imageRepository = (image: string) => splitTag(withoutDigest(image)).name;

/** "ghcr.io/org/app:2.13" → 2.13; "app" → latest. */
export const imageTag = (image: string) => splitTag(withoutDigest(image)).tag;
