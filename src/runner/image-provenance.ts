import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { DIGEST_SEPARATOR, IMAGE_PROVENANCE, PROVENANCE_MESSAGES } from "../shared/constants.js";
import { describeError } from "../shared/errors.js";
import {
  PROVENANCE_STATUS,
  ruleForImage,
  satisfiesRule,
  type ImageProvenance,
  type ImageTrustPolicy,
  type TrustedPublisher,
} from "../shared/image-provenance.js";
import { canonicalRepository } from "../shared/rollouts.js";
import type { ImageDetails } from "./docker-client.js";
import type { ProvenanceSource } from "./image-updates.js";
import { parseImageReference, type ImageReference, type SignatureArtifact } from "./registry-client.js";

/** What a signature is over: Red Hat's simple signing document, which names the one image it is for. */
interface SimpleSigning {
  critical?: {
    type?: unknown;
    identity?: { "docker-reference"?: unknown };
    image?: { "docker-manifest-digest"?: unknown };
  };
}

interface Reader {
  signatures(reference: ImageReference, digest: string): Promise<SignatureArtifact[] | null>;
}

/** Evidence, with what it was read under: another policy or another digest is another question. */
interface Remembered {
  revision: number;
  provenance: ImageProvenance;
}

const keyOf = (reference: ImageReference, digest: string) =>
  JSON.stringify([reference.registry, reference.repository, digest]);

/** Whether the document names this very image: the digest asked about, and the repository it was read from. */
function documentNames(payload: string, reference: ImageReference, digest: string): boolean {
  const document = JSON.parse(payload) as SimpleSigning;
  const critical = document.critical;
  if (critical?.type !== IMAGE_PROVENANCE.payloadType) return false;
  if (critical.image?.["docker-manifest-digest"] !== digest) return false;
  const named = critical.identity?.["docker-reference"];
  if (typeof named !== "string") return false;
  return canonicalRepository(named) === canonicalRepository(`${reference.registry}/${reference.repository}`);
}

/**
 * Whether this publisher's key made this signature. The verifying itself is Node's own (OpenSSL): nothing about the
 * signature is worked out here, only which bytes are checked against which key.
 */
function opens(publisher: { key: KeyObject }, artifact: SignatureArtifact, payload: Buffer): boolean {
  try {
    return verify(IMAGE_PROVENANCE.digestAlgorithm, payload, publisher.key, Buffer.from(artifact.signature, "base64"));
  } catch {
    return false;
  }
}

function publicKeyOf(publisher: TrustedPublisher): { name: string; key: KeyObject } | null {
  try {
    return { name: publisher.name, key: createPublicKey(publisher.publicKey) };
  } catch {
    return null;
  }
}

/**
 * Who published an image, as far as its registry can show: a cosign signature made with a key, over the very digest
 * that was pulled, opened with the public half an admin pasted into Settings. Keyless signatures (a certificate from
 * a signing service, with a transparency log to check) are not read here: one carrying a certificate instead of
 * standing up to a trusted key is reported as unverified, never as proof.
 *
 * Evidence is remembered by registry, repository and digest, under the policy revision it was read for, so a changed
 * policy is a changed question. A registry that cannot be asked is `unreachable`, which no rule accepts.
 */
export class ImageProvenanceReader {
  private readonly remembered = new Map<string, Remembered>();

  constructor(
    private readonly registry: Reader,
    private readonly policy: () => ImageTrustPolicy,
    private readonly clock: () => number = Date.now,
  ) {}

  /** What is known about a digest now, reading the registry only when nothing fresh is remembered. */
  async read(reference: ImageReference, digest: string): Promise<ImageProvenance> {
    const policy = this.policy();
    const key = keyOf(reference, digest);
    const known = this.remembered.get(key);
    const fresh = this.clock() - IMAGE_PROVENANCE.freshMilliseconds;
    if (known !== undefined && known.revision === policy.revision && known.provenance.checkedAt >= fresh) {
      return known.provenance;
    }
    const provenance = await this.look(reference, digest, policy);
    this.remember(key, { revision: policy.revision, provenance });
    return provenance;
  }

  /** What is remembered about a digest, without asking any registry; null where nothing is. */
  known(reference: ImageReference, digest: string): ImageProvenance | null {
    const known = this.remembered.get(keyOf(reference, digest));
    return known === undefined || known.revision !== this.policy().revision ? null : known.provenance;
  }

  private async look(reference: ImageReference, digest: string, policy: ImageTrustPolicy): Promise<ImageProvenance> {
    const answer = (status: ImageProvenance["status"], publisher: string | null, problem: string | null) => ({
      status,
      digest,
      publisher,
      checkedAt: this.clock(),
      problem,
    });
    const publishers = policy.publishers.flatMap((publisher) => publicKeyOf(publisher) ?? []);
    if (publishers.length === 0) {
      return answer(PROVENANCE_STATUS.invalid, null, PROVENANCE_MESSAGES.noPublishers);
    }
    const artifacts = await this.registry.signatures(reference, digest).catch((error: unknown) => error as Error);
    if (artifacts instanceof Error) {
      return answer(PROVENANCE_STATUS.unreachable, null, describeError(artifacts));
    }
    if (artifacts === null || artifacts.length === 0) {
      return answer(PROVENANCE_STATUS.unsigned, null, PROVENANCE_MESSAGES.noSignature);
    }
    // Every signature is read, whatever order the registry keeps them in: the one a rule requires may come after
    // another trusted publisher's, or after one for another image.
    const signedBy = new Set<string>();
    let forOtherImage = false;
    for (const artifact of artifacts) {
      const payload = Buffer.from(artifact.payload);
      const opened = publishers.filter((publisher) => opens(publisher, artifact, payload));
      if (opened.length === 0) continue;
      if (!this.namesImage(artifact.payload, reference, digest)) {
        forOtherImage = true;
        continue;
      }
      opened.forEach(({ name }) => signedBy.add(name));
    }
    const [first = null] = signedBy;
    if (first !== null) {
      return { ...answer(PROVENANCE_STATUS.verified, first, null), publishers: [...signedBy] };
    }
    if (forOtherImage) {
      return answer(PROVENANCE_STATUS.invalid, null, PROVENANCE_MESSAGES.otherImage);
    }
    const keyless = artifacts.some((artifact) => artifact.certificate !== null);
    return answer(
      PROVENANCE_STATUS.invalid,
      null,
      keyless ? PROVENANCE_MESSAGES.keylessNotRead : PROVENANCE_MESSAGES.noTrustedKey,
    );
  }

  private namesImage(payload: string, reference: ImageReference, digest: string): boolean {
    try {
      return documentNames(payload, reference, digest);
    } catch {
      return false;
    }
  }

  // Oldest out first, so a fleet with many images cannot grow this without end.
  private remember(key: string, entry: Remembered) {
    this.remembered.delete(key);
    this.remembered.set(key, entry);
    for (const oldest of this.remembered.keys()) {
      if (this.remembered.size <= IMAGE_PROVENANCE.cacheLimit) break;
      this.remembered.delete(oldest);
    }
  }
}

/**
 * The digest Docker recorded for what it just pulled, for this very repository: what a signature must be over.
 * Null where Docker knows no digest for it, such as an image built on the host under the same name.
 */
function pulledDigest(image: ImageDetails | null, reference: string): string | null {
  const wanted = canonicalRepository(reference);
  const found = (image?.RepoDigests ?? []).find((entry) => canonicalRepository(entry) === wanted);
  return found?.split("@")[1] ?? null;
}

/**
 * Why the image just pulled may not be put in place: a scope that asks for a signed image, and this digest is not
 * one that holds up. Asked after the pull and about the digest Docker recorded for it, never about the tag, and
 * before anything is stopped. Null where no rule covers the image, or where the proof is in hand.
 */
export async function provenanceRefusal(
  source: ProvenanceSource | null,
  reference: string,
  newImage: ImageDetails | null,
): Promise<string | null> {
  // A rule covers a repository however its image is named: pinned to a digest too, which update checks pass over.
  const image = parseImageReference(reference.split(DIGEST_SEPARATOR)[0]!);
  if (source === null || image === null) return null;
  const rule = ruleForImage(source.policy(), image);
  if (rule === null) return null;
  const pulled = pulledDigest(newImage, reference);
  if (pulled === null) return PROVENANCE_MESSAGES.heldBackUnknown(reference);
  const found = await source.read(image, pulled).catch((error: unknown) => describeError(error));
  if (typeof found === "string") return PROVENANCE_MESSAGES.heldBack(reference, found);
  if (satisfiesRule(rule, found, pulled)) return null;
  return PROVENANCE_MESSAGES.heldBack(reference, found.problem ?? found.status);
}
