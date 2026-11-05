import { TAG_VERSION } from "./constants.js";

/** A tag read as a version: the text around its numbers, and the numbers in order. */
interface TagVersion {
  shape: string;
  numbers: readonly bigint[];
}

/**
 * "2.7.0.5723-ls166" → shape "#.#.#.#-ls#" with 2, 7, 0, 5723 and 166. A tag with no number (latest, stable) or one
 * holding a commit hash is no version: only its digest can say whether it moved.
 */
function tagVersion(tag: string): TagVersion | null {
  const runs = tag.match(TAG_VERSION.numberRun) ?? [];
  if (runs.length === 0 || TAG_VERSION.commitLike.test(tag)) return null;
  return { shape: tag.replace(TAG_VERSION.numberRun, TAG_VERSION.placeholder), numbers: runs.map(BigInt) };
}

// Left to right, the first number that differs decides; tags of one shape always have as many numbers.
function compareNumbers(left: readonly bigint[], right: readonly bigint[]): number {
  const differing = left.findIndex((number, index) => number !== right[index]);
  if (differing === -1) return 0;
  return left[differing]! > right[differing]! ? 1 : -1;
}

/**
 * The tags newer than `current` on its own line, newest first. A line is every tag with the same text around its
 * numbers, so `16-alpine` meets `17-alpine` but never `17`, `1.2.0` meets `1.10.0` but never `1.3` or `1.3.0-rc1`:
 * a prerelease, another flavour or a broader channel tag is never offered in place of what the person chose.
 * Knows nothing of any image; any newer version is offered, majors included.
 */
export function newerTags(current: string, tags: readonly string[]): string[] {
  const own = tagVersion(current);
  if (own === null) return [];
  return tags
    .map((tag) => ({ tag, version: tagVersion(tag) }))
    .filter(
      (candidate): candidate is { tag: string; version: TagVersion } =>
        candidate.version?.shape === own.shape && compareNumbers(candidate.version.numbers, own.numbers) > 0,
    )
    .sort((left, right) => compareNumbers(right.version.numbers, left.version.numbers))
    .map(({ tag }) => tag);
}

/** Whether a tag names a version at all, so a newer one can be looked for: `1.2.0` does, `latest` does not. */
export const isVersionTag = (tag: string) => tagVersion(tag) !== null;

/** Whether `candidate` is a later version than `current` on the same line, as `newerTags` reads them. */
export const isNewerTag = (current: string, candidate: string) => newerTags(current, [candidate]).length > 0;
