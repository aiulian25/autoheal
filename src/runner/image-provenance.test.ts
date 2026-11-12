import { generateKeyPairSync, sign } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { PROVENANCE_STATUS, type ImageTrustPolicy } from "../shared/image-provenance.js";
import { PROVENANCE_MESSAGES } from "../shared/constants.js";
import { ImageProvenanceReader, provenanceRefusal } from "./image-provenance.js";
import type { ImageReference, SignatureArtifact } from "./registry-client.js";

const IMAGE: ImageReference = { registry: "ghcr.io", repository: "owner/app", tag: "2.1" };
const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;

const publisherKeys = () => generateKeyPairSync("ec", { namedCurve: "P-256" });
const owner = publisherKeys();
const stranger = publisherKeys();

const pemOf = (key: ReturnType<typeof publisherKeys>) =>
  key.publicKey.export({ type: "spki", format: "pem" }).toString();

/** The document cosign signs: the image the signature is for, and nothing else that is read here. */
const payloadFor = (digest: string, reference = "ghcr.io/owner/app") =>
  JSON.stringify({
    critical: {
      identity: { "docker-reference": reference },
      image: { "docker-manifest-digest": digest },
      type: "cosign container image signature",
    },
    optional: null,
  });

const signedWith = (key: ReturnType<typeof publisherKeys>, payload: string): SignatureArtifact => ({
  payload,
  signature: sign("sha256", Buffer.from(payload), key.privateKey).toString("base64"),
  certificate: null,
});

const policyWith = (change: Partial<ImageTrustPolicy> = {}): ImageTrustPolicy => ({
  revision: 1,
  publishers: [{ name: "owner", publicKey: pemOf(owner) }],
  required: [{ registry: "ghcr.io", repository: "owner/app", publishers: [] }],
  ...change,
});

describe("who published an image", () => {
  let kept: SignatureArtifact[] | null;
  let failure: Error | null;
  let asked: string[];
  let policy: ImageTrustPolicy;
  let now: number;

  const registry = {
    signatures: async (reference: ImageReference, digest: string) => {
      asked.push(`${reference.repository}@${digest}`);
      if (failure !== null) throw failure;
      return kept;
    },
  };
  const reader = () =>
    new ImageProvenanceReader(
      registry,
      () => policy,
      () => now,
    );

  beforeEach(() => {
    kept = [signedWith(owner, payloadFor(DIGEST))];
    failure = null;
    asked = [];
    policy = policyWith();
    now = Date.UTC(2026, 10, 4);
  });

  it("is verified when a trusted publisher's key opens a signature over that very digest", async () => {
    const provenance = await reader().read(IMAGE, DIGEST);

    expect(provenance).toMatchObject({
      status: PROVENANCE_STATUS.verified,
      digest: DIGEST,
      publisher: "owner",
      problem: null,
    });
  });

  it("is invalid when the signature is a stranger's, and says so without naming one", async () => {
    kept = [signedWith(stranger, payloadFor(DIGEST))];

    const provenance = await reader().read(IMAGE, DIGEST);

    expect(provenance.status).toBe(PROVENANCE_STATUS.invalid);
    expect(provenance.publisher).toBeNull();
    expect(provenance.problem).toContain("no trusted publisher");
  });

  it("is invalid when the signature it keeps is for another image, however well it opens", async () => {
    kept = [signedWith(owner, payloadFor(OTHER_DIGEST))];

    const provenance = await reader().read(IMAGE, DIGEST);

    expect(provenance.status).toBe(PROVENANCE_STATUS.invalid);
    expect(provenance.problem).toContain("another image");
  });

  it("is invalid when the signature it keeps is for another repository under the same digest", async () => {
    kept = [signedWith(owner, payloadFor(DIGEST, "ghcr.io/someone/else"))];

    expect((await reader().read(IMAGE, DIGEST)).status).toBe(PROVENANCE_STATUS.invalid);
  });

  it("is invalid when the signature does not hold up at all", async () => {
    kept = [{ ...signedWith(owner, payloadFor(DIGEST)), signature: Buffer.from("not-a-signature").toString("base64") }];

    expect((await reader().read(IMAGE, DIGEST)).status).toBe(PROVENANCE_STATUS.invalid);
  });

  it("is unsigned when the registry keeps no signature for the image", async () => {
    kept = null;

    const provenance = await reader().read(IMAGE, DIGEST);

    expect(provenance.status).toBe(PROVENANCE_STATUS.unsigned);
    expect(provenance.problem).toContain("no signature");
  });

  it("is unreachable when the registry could not be asked, never an allow", async () => {
    failure = new Error("getaddrinfo ENOTFOUND ghcr.io");

    const provenance = await reader().read(IMAGE, DIGEST);

    expect(provenance.status).toBe(PROVENANCE_STATUS.unreachable);
    expect(provenance.problem).toContain("ENOTFOUND");
  });

  it("will not read a keyless signature as proof, and says that is why", async () => {
    kept = [{ ...signedWith(stranger, payloadFor(DIGEST)), certificate: "-----BEGIN CERTIFICATE-----" }];

    const provenance = await reader().read(IMAGE, DIGEST);

    expect(provenance.status).toBe(PROVENANCE_STATUS.invalid);
    expect(provenance.problem).toContain("signing certificate");
  });

  it("refuses rather than allows when no publisher key is set up at all", async () => {
    policy = policyWith({ publishers: [] });

    const provenance = await reader().read(IMAGE, DIGEST);

    expect(provenance.status).toBe(PROVENANCE_STATUS.invalid);
    expect(asked).toEqual([]);
  });

  it("takes the signature of whichever trusted publisher made it, where several are trusted", async () => {
    policy = policyWith({
      publishers: [
        { name: "someone", publicKey: pemOf(stranger) },
        { name: "owner", publicKey: pemOf(owner) },
      ],
    });

    expect((await reader().read(IMAGE, DIGEST)).publisher).toBe("owner");
  });

  it("asks a registry once for a digest, and again once the policy changes", async () => {
    const reading = reader();
    await reading.read(IMAGE, DIGEST);
    await reading.read(IMAGE, DIGEST);
    expect(asked).toHaveLength(1);

    policy = policyWith({ revision: 2 });
    await reading.read(IMAGE, DIGEST);
    expect(asked).toHaveLength(2);
    // What was read under the older policy is no longer an answer to this question.
    policy = policyWith({ revision: 3 });
    expect(reading.known(IMAGE, DIGEST)).toBeNull();
  });

  it("asks again once what it remembers has grown old", async () => {
    const reading = reader();
    await reading.read(IMAGE, DIGEST);

    now += 7 * 60 * 60 * 1000;
    await reading.read(IMAGE, DIGEST);

    expect(asked).toHaveLength(2);
  });

  it("keeps each digest's evidence apart, so a moved tag cannot borrow the last one's", async () => {
    const reading = reader();
    await reading.read(IMAGE, DIGEST);
    kept = [signedWith(stranger, payloadFor(OTHER_DIGEST))];

    expect((await reading.read(IMAGE, OTHER_DIGEST)).status).toBe(PROVENANCE_STATUS.invalid);
    expect((await reading.read(IMAGE, DIGEST)).status).toBe(PROVENANCE_STATUS.verified);
  });
});

describe("an image named by its digest, as a staged rollout names it", () => {
  const PINNED = `ghcr.io/owner/app@${DIGEST}`;
  const pulled = { Id: "sha256:config", RepoDigests: [PINNED] };
  const sourceSaying = (status: (typeof PROVENANCE_STATUS)[keyof typeof PROVENANCE_STATUS], policy = policyWith()) => ({
    policy: () => policy,
    read: async () => ({
      status,
      digest: DIGEST,
      publisher: status === PROVENANCE_STATUS.verified ? "owner" : null,
      checkedAt: 1,
      problem: null,
    }),
  });

  it("is held to the rule over its repository: unsigned, it is refused", async () => {
    expect(await provenanceRefusal(sourceSaying(PROVENANCE_STATUS.unsigned), PINNED, pulled)).toBe(
      PROVENANCE_MESSAGES.heldBack(PINNED, PROVENANCE_STATUS.unsigned),
    );
  });

  it("goes ahead signed by a publisher the rule allows", async () => {
    expect(await provenanceRefusal(sourceSaying(PROVENANCE_STATUS.verified), PINNED, pulled)).toBeNull();
  });

  it("is not held where no rule covers its repository", async () => {
    const elsewhere = policyWith({ required: [{ registry: "ghcr.io", repository: "someone/else", publishers: [] }] });
    expect(await provenanceRefusal(sourceSaying(PROVENANCE_STATUS.unsigned, elsewhere), PINNED, pulled)).toBeNull();
  });
});

describe("an image more than one trusted publisher signed", () => {
  const second = publisherKeys();
  const REFERENCE = "ghcr.io/owner/app:2.1";
  const pulled = { Id: "sha256:config", RepoDigests: [`ghcr.io/owner/app@${DIGEST}`] };
  const ownerSigned = signedWith(owner, payloadFor(DIGEST));
  const secondSigned = signedWith(second, payloadFor(DIGEST));
  const sourceWith = (kept: SignatureArtifact[], requiring: string[]) => {
    const policy = policyWith({
      publishers: [
        { name: "owner", publicKey: pemOf(owner) },
        { name: "second", publicKey: pemOf(second) },
      ],
      required: [{ registry: "ghcr.io", repository: "owner/app", publishers: requiring }],
    });
    const reader = new ImageProvenanceReader({ signatures: async () => kept }, () => policy);
    return { policy: () => policy, read: (image: ImageReference, digest: string) => reader.read(image, digest) };
  };
  const refusalWith = (kept: SignatureArtifact[], requiring: string[]) =>
    provenanceRefusal(sourceWith(kept, requiring), REFERENCE, pulled);

  it.each([
    ["first", [secondSigned, ownerSigned]],
    ["last", [ownerSigned, secondSigned]],
  ])("goes ahead when the publisher its rule requires signed it, that signature %s", async (_where, kept) => {
    expect(await refusalWith(kept, ["second"])).toBeNull();
  });

  it("goes ahead past a trusted signature for another image, to the one for this image", async () => {
    expect(await refusalWith([signedWith(owner, payloadFor(OTHER_DIGEST)), secondSigned], ["second"])).toBeNull();
  });

  it("is still refused when the publisher required signed nothing of it that holds up", async () => {
    const broken = { ...secondSigned, signature: Buffer.from("not a signature").toString("base64") };
    expect(await refusalWith([ownerSigned], ["second"])).not.toBeNull();
    expect(await refusalWith([ownerSigned, signedWith(second, payloadFor(OTHER_DIGEST))], ["second"])).not.toBeNull();
    expect(await refusalWith([ownerSigned, broken], ["second"])).not.toBeNull();
  });
});
