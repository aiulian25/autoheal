import { z } from "zod";
import { IMAGE_PROVENANCE } from "./constants.js";
import { coversRepository, registryHostOf } from "./registry-credentials.js";

/**
 * What is known about who published an image, for the one proof Autoheal reads: a cosign signature made with a key,
 * kept beside the image in its own registry. A registry label is a claim, not proof, and is never treated as one.
 *
 * - `verified`: a signature over this very digest opened with a publisher's key an admin trusts.
 * - `unsigned`: the registry holds no signature for this digest.
 * - `invalid`: it holds one, and no trusted key opens it, or it is for another image.
 * - `unreachable`: the registry could not be asked. Never an allow: a scope that requires proof refuses.
 * - `notChecked`: nothing asked for proof here.
 */
export const PROVENANCE_STATUS = {
  verified: "verified",
  unsigned: "unsigned",
  invalid: "invalid",
  unreachable: "unreachable",
  notChecked: "not_checked",
} as const;
export const PROVENANCE_STATUSES = Object.values(PROVENANCE_STATUS);
export type ProvenanceStatus = (typeof PROVENANCE_STATUS)[keyof typeof PROVENANCE_STATUS];

export const provenanceSchema = z.object({
  status: z.enum(PROVENANCE_STATUSES),
  // The digest the evidence is about: an immutable image, never a tag.
  digest: z.string().nullable(),
  // The publisher whose key opened the signature; null when none did.
  publisher: z.string().max(IMAGE_PROVENANCE.publisherNameLength).nullable(),
  // Every trusted publisher whose signature over this digest holds, `publisher` first: a rule may require any of them.
  publishers: z
    .array(z.string().max(IMAGE_PROVENANCE.publisherNameLength))
    .max(IMAGE_PROVENANCE.publishersLimit)
    .optional(),
  checkedAt: z.number().int().positive(),
  // Why it is not verified, in words fit to show; null when it is.
  problem: z.string().max(IMAGE_PROVENANCE.problemLength).nullable(),
});
export type ImageProvenance = z.infer<typeof provenanceSchema>;

/** A publisher an admin trusts: a name to show, and the public half of the key its signatures are made with. */
export interface TrustedPublisher {
  name: string;
  publicKey: string;
}

/** Where proof is required, and from which publishers; an empty publisher list means any trusted one. */
export interface TrustRule {
  registry: string;
  repository: string | null;
  publishers: string[];
}

/** What a runner is given: the keys to open signatures with, where proof is required, and which policy this is. */
export interface ImageTrustPolicy {
  // Changes with every change to the policy, so evidence read under an older one is not reused.
  revision: number;
  publishers: TrustedPublisher[];
  required: TrustRule[];
}

export const EMPTY_TRUST_POLICY: ImageTrustPolicy = { revision: 0, publishers: [], required: [] };

const sameRegistry = (rule: TrustRule, image: { registry: string }) =>
  registryHostOf(rule.registry) === registryHostOf(image.registry);

/** The rule for an image, the most closely scoped first; null where nothing requires proof for it. */
export function ruleForImage(
  policy: ImageTrustPolicy,
  image: { registry: string; repository: string },
): TrustRule | null {
  const covering = policy.required.filter(
    (rule) => sameRegistry(rule, image) && coversRepository(rule.repository, image.repository),
  );
  const byScope = [...covering].sort(
    (first, second) => (second.repository ?? "").length - (first.repository ?? "").length,
  );
  return byScope[0] ?? null;
}

/**
 * Whether proof good enough for this scope is in hand: a signature over this exact digest, opened with a key of a
 * publisher the rule names. Anything else — unsigned, invalid, a registry that could not be asked, evidence about
 * another digest — is not proof, so the update waits for a person.
 */
export function satisfiesRule(rule: TrustRule, provenance: ImageProvenance | null, digest: string | null): boolean {
  if (provenance === null || provenance.status !== PROVENANCE_STATUS.verified) return false;
  if (digest === null || provenance.digest !== digest) return false;
  if (provenance.publisher === null) return false;
  const signedBy = provenance.publishers ?? [provenance.publisher];
  return rule.publishers.length === 0 || signedBy.some((publisher) => rule.publishers.includes(publisher));
}

/** Where the registry keeps the signature for a digest, as cosign writes it: a tag beside the image itself. */
export const signatureTagOf = (digest: string) =>
  `${digest.replace(IMAGE_PROVENANCE.digestSeparator, IMAGE_PROVENANCE.tagSeparator)}${IMAGE_PROVENANCE.signatureSuffix}`;
