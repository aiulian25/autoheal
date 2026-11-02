import {
  DIGEST_SEPARATOR,
  IMAGE_ID_PREFIX,
  NODE_TO_OCI_ARCHITECTURE,
  REGISTRY,
  REGISTRY_MESSAGES,
  UPDATE_LABEL,
  UPDATE_POLICY,
  UPDATE_STATUS,
  type UpdateStatus,
} from "../shared/constants.js";
import { describeError } from "../shared/errors.js";
import type { ImageLabels } from "../shared/protocol.js";
import type { ContainerSummary, DockerClient } from "./docker-client.js";
import { parseImageReference, type ImageReference, type RegistryClient } from "./registry-client.js";

export interface UpdateCheck {
  status: UpdateStatus;
  checkedAt: number;
  remoteDigest: string | null;
  // What the newer image says it is; null with no update, and until its labels are read.
  remote: ImageLabels | null;
  // Why it could not be checked; null when it was.
  reason: string | null;
}

// What one check may still read from Docker Hub, where a manifest GET counts as a pull.
interface LabelBudget {
  dockerHub: number;
  reads: Map<string, Promise<ImageLabels | null>>;
  ancestry: Map<string, Promise<boolean>>;
}

export interface UpdateSummary {
  images: number;
  available: number;
  unknown: number;
}

const digestOf = (repositoryDigest: string) => repositoryDigest.slice(repositoryDigest.indexOf(DIGEST_SEPARATOR) + 1);

const platform = `${REGISTRY.platformOs}/${NODE_TO_OCI_ARCHITECTURE[process.arch] ?? process.arch}`;
const resultKey = (imageId: string, reference: ImageReference) =>
  JSON.stringify([imageId, reference.registry, reference.repository, reference.tag, platform]);
const labelKey = (reference: ImageReference, digest: string) =>
  JSON.stringify([reference.registry, reference.repository, digest, platform]);

/**
 * Whether the image each container runs still is what its tag points to, as Watchtower and Diun
 * check: the registry's digest for the tag against the digests Docker recorded when it pulled
 * the image. Tracked by configured reference and immutable image id, so tags cannot borrow another tag’s result.
 * A different digest is an update only when the registry knows the image the container runs: an
 * image built here, under a name a public image also has, must never be "updated" to that one.
 */
export class ImageUpdateChecker {
  private readonly results = new Map<string, UpdateCheck>();
  // A newer image's labels, by its digest: read once, whichever containers wait for it.
  private readonly labels = new Map<string, ImageLabels>();
  private checking: Promise<UpdateSummary> | null = null;

  constructor(
    private readonly docker: Pick<DockerClient, "containerSummaries" | "inspect" | "inspectImage">,
    private readonly registry: Pick<RegistryClient, "digest" | "labels">,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Null until checked, and for images that can't be: built here, pinned to a digest, or labelled off. */
  resultFor(imageId: string | undefined, configuredReference: string): UpdateCheck | null {
    const reference = configuredReference.startsWith(IMAGE_ID_PREFIX) ? null : parseImageReference(configuredReference);
    return imageId === undefined || reference === null
      ? null
      : (this.results.get(resultKey(imageId, reference)) ?? null);
  }

  /** One check at a time: the scheduled one and one asked for from the dashboard share a run. */
  checkAll(): Promise<UpdateSummary> {
    this.checking ??= this.checkEveryImage().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async checkEveryImage(): Promise<UpdateSummary> {
    // Repeated containers/aliases share one reference check; distinct tags on an image remain independent.
    const images = new Map<string, { imageId: string; reference: ImageReference }>();
    for (const summary of await this.docker.containerSummaries()) {
      if (summary.ImageID === undefined || summary.Labels?.[UPDATE_LABEL] === UPDATE_POLICY.off) continue;
      const reference = await this.referenceOf(summary);
      if (reference !== null)
        images.set(resultKey(summary.ImageID, reference), { imageId: summary.ImageID, reference });
    }
    const entries = [...images];
    const budget: LabelBudget = { dockerHub: REGISTRY.dockerHubLabelReads, reads: new Map(), ancestry: new Map() };
    const local = new Map<string, Promise<string[]>>();
    for (let start = 0; start < entries.length; start += REGISTRY.concurrency) {
      await Promise.all(
        entries.slice(start, start + REGISTRY.concurrency).map(([key, { imageId, reference }]) => {
          let digests = local.get(imageId);
          if (digests === undefined) {
            digests = this.localDigests(imageId).catch(() => []);
            local.set(imageId, digests);
          }
          return this.checkOne(key, reference, budget, digests);
        }),
      );
    }
    for (const key of this.results.keys()) if (!images.has(key)) this.results.delete(key);
    const awaited = new Set(
      [...images].flatMap(([key, { reference }]) => {
        const digest = this.results.get(key)?.remoteDigest;
        return digest == null ? [] : [labelKey(reference, digest)];
      }),
    );
    for (const key of this.labels.keys()) if (!awaited.has(key)) this.labels.delete(key);
    const checked = [...this.results.values()];
    return {
      images: checked.length,
      available: checked.filter((result) => result.status === UPDATE_STATUS.available).length,
      unknown: checked.filter((result) => result.status === UPDATE_STATUS.unknown).length,
    };
  }

  // Docker lists a container by its image id once its tag points to a newer image; the name it
  // was created with is still in its configuration.
  private async referenceOf(summary: ContainerSummary): Promise<ImageReference | null> {
    const listed = summary.Image ?? "";
    if (!listed.startsWith(IMAGE_ID_PREFIX)) {
      return parseImageReference(listed);
    }
    const created = (await this.docker.inspect(summary.Id).catch(() => null))?.Config.Image ?? listed;
    return created.startsWith(IMAGE_ID_PREFIX) ? null : parseImageReference(created);
  }

  // The digests the image was pulled or pushed by: none for one built here and never pushed. An
  // image whose tag moved on to a newer one lost its digests (or, rebuilt over, is gone) in the
  // containerd image store, but there an image's id is the digest it was pulled by.
  private async localDigests(imageId: string): Promise<string[]> {
    const image = await this.docker.inspectImage(imageId);
    const recorded = (image?.RepoDigests ?? []).map(digestOf);
    if (recorded.length > 0) {
      return recorded;
    }
    const stillTagged = (image?.RepoTags ?? []).length > 0;
    return stillTagged ? [] : [imageId];
  }

  private async statusOf(
    local: readonly string[],
    remoteDigest: string,
    reference: ImageReference,
    budget: LabelBudget,
  ) {
    if (local.includes(remoteDigest)) {
      return UPDATE_STATUS.current;
    }
    const known = await Promise.all(
      local.map((digest) => {
        const key = labelKey(reference, digest);
        let reading = budget.ancestry.get(key);
        if (reading === undefined) {
          reading = this.registry.digest({ ...reference, tag: digest }).then(
            () => true,
            () => false,
          );
          budget.ancestry.set(key, reading);
        }
        return reading;
      }),
    );
    return known.includes(true) ? UPDATE_STATUS.available : UPDATE_STATUS.unknown;
  }

  /**
   * What the newer image says it is, read once per digest. A failed read is tried again at the next check,
   * and past this check's Docker Hub budget it waits for a later one.
   */
  private async remoteLabels(reference: ImageReference, digest: string, budget: LabelBudget) {
    const key = labelKey(reference, digest);
    const known = this.labels.get(key);
    if (known !== undefined) return known;
    const reading = budget.reads.get(key);
    if (reading !== undefined) return reading;
    const countsAsPull = reference.registry === REGISTRY.dockerHubHost;
    if (countsAsPull && budget.dockerHub <= 0) return null;
    if (countsAsPull) budget.dockerHub -= 1;
    const request = this.registry
      .labels(reference, digest)
      .catch(() => null)
      .then((labels) => {
        if (labels !== null) this.labels.set(key, labels);
        return labels;
      });
    budget.reads.set(key, request);
    return request;
  }

  private async checkOne(key: string, reference: ImageReference, budget: LabelBudget, digests: Promise<string[]>) {
    // Docker not answering says nothing new: the last answer stays.
    const local = await digests;
    if (local.length === 0) {
      return;
    }
    const checkedAt = this.clock();
    try {
      const remoteDigest = await this.registry.digest(reference);
      const status = await this.statusOf(local, remoteDigest, reference, budget);
      const available = status === UPDATE_STATUS.available;
      this.results.set(key, {
        status,
        checkedAt,
        remoteDigest,
        remote: available ? await this.remoteLabels(reference, remoteDigest, budget) : null,
        reason: status === UPDATE_STATUS.unknown ? REGISTRY_MESSAGES.unknownImage : null,
      });
    } catch (error) {
      // A registry that is down or private says nothing about the image; the last answer stays useful.
      const reason = describeError(error);
      const previous = this.results.get(key);
      this.results.set(
        key,
        previous === undefined
          ? { status: UPDATE_STATUS.unknown, checkedAt, remoteDigest: null, remote: null, reason }
          : { ...previous, reason },
      );
    }
  }
}
