import {
  BEARER_PREFIX,
  DIGEST_PATTERN,
  DIGEST_SEPARATOR,
  HTTP_HEADERS,
  HTTP_STATUS,
  IMAGE_LABEL_CHARACTERS,
  IMAGE_REFERENCE,
  LABEL_SCHEMA_LABELS,
  LOOPBACK_HOST_PATTERN,
  NODE_TO_OCI_ARCHITECTURE,
  OCI_LABELS,
  REGISTRY,
  IMAGE_PROVENANCE,
  REGISTRY_CREDENTIALS,
  REGISTRY_MESSAGES,
  URL_PROTOCOL_SUFFIX,
} from "../shared/constants.js";
import { splitTag } from "../shared/image-reference.js";
import type { ImageFacts } from "../shared/install.js";
import type { ImageLabels } from "../shared/protocol.js";
import { signatureTagOf } from "../shared/image-provenance.js";
import { accessForImage, type RegistryAccess } from "../shared/registry-credentials.js";
import { webLinkOf } from "../shared/urls.js";

export interface ImageReference {
  registry: string;
  repository: string;
  tag: string;
}

export class RegistryError extends Error {}

const DOCKER_HUB_NAMES: ReadonlySet<string> = new Set(REGISTRY.dockerHubNames);
const { tagSeparator, pathSeparator } = IMAGE_REFERENCE;

// A first path part is a registry when it looks like a host: it has a dot or a port, or is localhost.
const isRegistryHost = (part: string) =>
  part.includes(".") || part.includes(tagSeparator) || part === IMAGE_REFERENCE.localHost;

/**
 * "nginx" → registry-1.docker.io, library/nginx, latest; "ghcr.io/owner/app:2.1" → as written.
 * Null for a reference pinned to a digest, which has nothing newer to point at.
 */
export function parseImageReference(reference: string): ImageReference | null {
  if (reference.includes(DIGEST_SEPARATOR)) {
    return null;
  }
  const { name, tag } = splitTag(reference);
  const [first = "", ...rest] = name.split(pathSeparator);
  const explicitRegistry = rest.length > 0 && isRegistryHost(first);
  const registry = explicitRegistry ? first : REGISTRY.dockerHubHost;
  const path = explicitRegistry ? rest.join(pathSeparator) : name;
  const onDockerHub = DOCKER_HUB_NAMES.has(registry);
  const repository = onDockerHub && !path.includes(pathSeparator) ? `${REGISTRY.officialNamespace}/${path}` : path;
  return { registry: onDockerHub ? REGISTRY.dockerHubHost : registry, repository, tag };
}

const isLoopback = (host: string) => LOOPBACK_HOST_PATTERN.test(host);
const registryName = (registry: string) => (registry === REGISTRY.dockerHubHost ? REGISTRY.dockerHubName : registry);
const isRefusal = (status: number) => status === HTTP_STATUS.unauthorized || status === HTTP_STATUS.forbidden;
const schemeOf = (host: string) => (isLoopback(host) ? REGISTRY.plainScheme : REGISTRY.secureScheme);

const CHALLENGE_PARAMETER = /(\w+)="([^"]*)"/g;

/** What a registry is told to prove a credential: the user name and the password, as HTTP basic authentication. */
const basicHeader = ({ username, password }: RegistryAccess) =>
  `${REGISTRY_CREDENTIALS.basicScheme}${Buffer.from(`${username}:${password}`).toString("base64")}`;

/**
 * A stored credential goes to the registry it is for, and to the one token address Docker Hub names. Nowhere else:
 * a registry that answers with a token address of its own choosing must not be able to collect it.
 */
const mayHaveCredential = (registry: string, realmHost: string) => {
  if (realmHost === registry) return true;
  if (registry === REGISTRY.dockerHubHost && realmHost === REGISTRY.dockerHubTokenHost) return true;
  return isLoopback(registry) && isLoopback(realmHost);
};

/** The parameters of a `Bearer realm="…",service="…",scope="…"` challenge. */
function challengeOf(header: string | null): Map<string, string> | null {
  if (header === null || !header.toLowerCase().startsWith(REGISTRY.bearerScheme)) {
    return null;
  }
  return new Map([...header.matchAll(CHALLENGE_PARAMETER)].map((match) => [match[1]!, match[2]!]));
}

// The token address must be https; plain http only when the registry and the address are both on
// this machine, as Docker allows for a local registry.
function tokenUrlOf(challenge: Map<string, string>, registry: string): URL {
  const realm = new URL(challenge.get(REGISTRY.challengeRealm) ?? "");
  const secure = realm.protocol === `${REGISTRY.secureScheme}${URL_PROTOCOL_SUFFIX}`;
  const local = isLoopback(registry) && isLoopback(realm.host);
  if (!secure && !local) {
    throw new RegistryError(REGISTRY_MESSAGES.refusedRealm(realm.origin));
  }
  for (const parameter of REGISTRY.challengeParameters) {
    const value = challenge.get(parameter);
    if (value !== undefined) {
      realm.searchParams.set(parameter, value);
    }
  }
  return realm;
}

/** One signature kept beside an image: the document it is over, and the signature itself. */
export interface SignatureArtifact {
  payload: string;
  signature: string;
  // Set where the signature came with a certificate instead of being made with a key: not read here.
  certificate: string | null;
}

/** What a manifest, an index or an image configuration holds that is read here; all of it is the registry's word. */
interface RegistryDocument {
  mediaType?: unknown;
  manifests?: { digest?: unknown; platform?: { os?: unknown; architecture?: unknown } }[];
  layers?: { mediaType?: unknown; digest?: unknown; annotations?: Record<string, unknown> | null }[];
  config?: {
    digest?: unknown;
    Labels?: Record<string, unknown> | null;
    ExposedPorts?: Record<string, unknown> | null;
    Volumes?: Record<string, unknown> | null;
    Env?: unknown;
    User?: unknown;
  };
}

type RequestMethod = "HEAD" | "GET";

const isIndex = (document: RegistryDocument) =>
  REGISTRY.indexTypes.some((type) => type === document.mediaType) || Array.isArray(document.manifests);

// The body as text, refused past `limit` bytes whatever the registry declares: its answers are not trusted.
async function textWithin(response: Response, limit: number): Promise<string> {
  if (Number(response.headers.get(HTTP_HEADERS.contentLength)) > limit) {
    await response.body?.cancel();
    throw new RegistryError(REGISTRY_MESSAGES.tooLarge);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > limit) {
      throw new RegistryError(REGISTRY_MESSAGES.tooLarge);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString();
}

function labelOf(labels: Record<string, unknown>, key: string): string | null {
  const value = labels[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * What an image's labels say it is, a running image's or a newer one's alike: the OCI ones, else the Label
 * Schema ones images built before OCI's (and some since, such as Radicale's) still carry.
 */
export function imageLabelsOf(labels: Record<string, unknown>): ImageLabels {
  const valueOf = (key: keyof typeof OCI_LABELS) =>
    labelOf(labels, OCI_LABELS[key]) ?? labelOf(labels, LABEL_SCHEMA_LABELS[key]);
  const textOf = (key: keyof typeof OCI_LABELS) => valueOf(key)?.slice(0, IMAGE_LABEL_CHARACTERS) ?? null;
  const createdAt = Date.parse(valueOf("created") ?? "");
  return {
    version: textOf("version"),
    revision: textOf("revision"),
    source: webLinkOf(valueOf("source")),
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : null,
  };
}

/**
 * Asks registries which image a tag points to now, anonymously and with HEAD requests: Docker Hub doesn't
 * count those against its pull limit, and nothing is downloaded. Only a newer image's labels take GETs.
 */
// "3000/tcp" and "53/udp": the numbers, TCP first, as what a person would open is on TCP.
export function portsIn(exposed: Record<string, unknown> | null | undefined): number[] {
  const keys = Object.keys(exposed ?? {}).sort((a, b) => Number(b.endsWith("/tcp")) - Number(a.endsWith("/tcp")));
  return keys.map((key) => Number(key.split("/")[0])).filter((port) => Number.isInteger(port) && port > 0);
}

/** What an image says it is, and its configuration's digest: Docker's id for it, on the classic image store. */
export type RemoteImage = ImageLabels & { configDigest?: string };

/** What a runner may use right now, which its heartbeat answers keep current. */
export type RegistryCredentials = () => readonly RegistryAccess[];

export class RegistryClient {
  constructor(
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly credentials: RegistryCredentials = () => [],
  ) {}

  /** The digest a tag points to now; `given` is a credential to use instead of the stored ones, for a test. */
  async digest(reference: ImageReference, given: RegistryAccess | null = null): Promise<string> {
    const { response } = await this.authorized(
      this.manifestUrl(reference, reference.tag),
      "HEAD",
      reference,
      null,
      given,
    );
    return this.digestOf(response);
  }

  /**
   * What an image's build says it is: the labels of its configuration, this machine's variant of it. Its
   * manifest GET counts as one pull on Docker Hub (with the platform's manifest an index points to); the
   * configuration does not. One anonymous token serves every request.
   */
  async labels(reference: ImageReference, digest: string): Promise<RemoteImage> {
    const configuration = await this.configuration(reference, digest);
    return { ...imageLabelsOf(configuration.config?.Labels ?? {}), configDigest: configuration.digest };
  }

  /**
   * The signatures a registry keeps for one image, which cosign writes to a tag of its digest. Each is the document
   * it signs and the signature over it, as the registry holds them: nothing here says whether either is any good.
   * `null` when the registry holds no signature for that image at all.
   */
  async signatures(reference: ImageReference, digest: string): Promise<SignatureArtifact[] | null> {
    const tag = signatureTagOf(digest);
    const found = await this.authorized(this.manifestUrl(reference, tag), "GET", reference, null);
    // No such tag: this image carries no signature, which is not the same as one that does not hold up.
    if (found.response.status === HTTP_STATUS.notFound) {
      await found.response.body?.cancel();
      return null;
    }
    const manifest = await this.documentOf(found.response);
    const layers = (manifest.layers ?? []).filter(
      (layer) => layer.mediaType === IMAGE_PROVENANCE.payloadMediaType && typeof layer.digest === "string",
    );
    const artifacts: SignatureArtifact[] = [];
    for (const layer of layers.slice(0, IMAGE_PROVENANCE.signaturesPerImage)) {
      const signature = layer.annotations?.[IMAGE_PROVENANCE.signatureAnnotation];
      if (typeof signature !== "string") continue;
      const certificate = layer.annotations?.[IMAGE_PROVENANCE.certificateAnnotation];
      const blobUrl = `${this.repositoryUrl(reference)}/blobs/${String(layer.digest)}`;
      const blob = await this.authorized(blobUrl, "GET", reference, found.token);
      artifacts.push({
        payload: await textWithin(blob.response, IMAGE_PROVENANCE.payloadBytesLimit),
        signature,
        certificate: typeof certificate === "string" ? certificate : null,
      });
    }
    return artifacts;
  }

  /** What an image's build says it needs, without pulling it: for a machine of this architecture, if it runs there. */
  async facts(reference: ImageReference, architecture: string | null): Promise<ImageFacts> {
    const { config } = await this.configuration(reference, await this.digest(reference), architecture);
    const environment = (Array.isArray(config?.Env) ? (config.Env as unknown[]) : [])
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => {
        const at = entry.indexOf("=");
        return at < 0 ? { name: entry, value: "" } : { name: entry.slice(0, at), value: entry.slice(at + 1) };
      });
    return {
      ports: portsIn(config?.ExposedPorts),
      volumes: Object.keys(config?.Volumes ?? {}),
      environment,
      user: typeof config?.User === "string" ? config.User : "",
    };
  }

  private async configuration(
    reference: ImageReference,
    digest: string,
    architecture: string | null = null,
  ): Promise<RegistryDocument & { digest: string }> {
    const first = await this.authorized(this.manifestUrl(reference, digest), "GET", reference, null);
    const manifest = await this.platformManifest(
      reference,
      await this.documentOf(first.response),
      first.token,
      architecture,
    );
    const configDigest = manifest.config?.digest;
    if (typeof configDigest !== "string" || !DIGEST_PATTERN.test(configDigest)) {
      throw new RegistryError(REGISTRY_MESSAGES.noConfig);
    }
    const blobUrl = `${this.repositoryUrl(reference)}/blobs/${configDigest}`;
    const configuration = await this.documentOf(
      (await this.authorized(blobUrl, "GET", reference, first.token)).response,
    );
    return { ...configuration, digest: configDigest };
  }

  // An index lists one manifest per platform: this machine's is the one it would run.
  private async platformManifest(
    reference: ImageReference,
    document: RegistryDocument,
    token: string | null,
    asked: string | null = null,
  ): Promise<RegistryDocument> {
    if (!isIndex(document)) {
      return document;
    }
    const architecture = asked ?? NODE_TO_OCI_ARCHITECTURE[process.arch] ?? process.arch;
    const entry = (document.manifests ?? []).find(
      ({ platform }) => platform?.os === REGISTRY.platformOs && platform.architecture === architecture,
    );
    if (typeof entry?.digest !== "string" || !DIGEST_PATTERN.test(entry.digest)) {
      throw new RegistryError(REGISTRY_MESSAGES.noPlatform(architecture));
    }
    const { response } = await this.authorized(this.manifestUrl(reference, entry.digest), "GET", reference, token);
    return this.documentOf(response);
  }

  private repositoryUrl(reference: ImageReference) {
    return `${schemeOf(reference.registry)}://${reference.registry}/v2/${reference.repository}`;
  }

  private manifestUrl(reference: ImageReference, tagOrDigest: string) {
    return `${this.repositoryUrl(reference)}/manifests/${tagOrDigest}`;
  }

  /** Asks with the token it has, or asks for one; refused even so, the image is not there for whoever asked. */
  private async authorized(
    url: string,
    method: RequestMethod,
    reference: ImageReference,
    token: string | null,
    given: RegistryAccess | null = null,
  ): Promise<{ response: Response; token: string | null }> {
    const access = given ?? this.accessFor(reference);
    const answer =
      token === null
        ? await this.asAllowed(url, method, reference, access)
        : { response: await this.request(url, method, token), token };
    if (isRefusal(answer.response.status)) {
      await answer.response.body?.cancel();
      throw new RegistryError(this.refusal(reference.registry, access));
    }
    return answer;
  }

  /** The stored credential for this image, the one scoped most closely to it; null where none is. */
  private accessFor(reference: ImageReference): RegistryAccess | null {
    return accessForImage(this.credentials(), reference);
  }

  // What a refusal means: with no credential the image is simply not there for whoever asked; with one, the
  // registry turned that credential down, which is what a person has to be told.
  private refusal(registry: string, access: RegistryAccess | null) {
    const name = registryName(registry);
    return access === null
      ? REGISTRY_MESSAGES.wantsCredentials(name)
      : REGISTRY_MESSAGES.refusedCredential(name, access.username);
  }

  // Asks as it is; on a bearer challenge, fetches a token — with the stored credential where there is one, so the
  // token covers a private repository — and asks again where the registry sent the first request (lscr.io
  // redirects to ghcr.io). A registry asking for basic authentication is told directly.
  private async asAllowed(
    url: string,
    method: RequestMethod,
    reference: ImageReference,
    access: RegistryAccess | null,
  ) {
    const first = await this.request(url, method, null);
    if (first.status !== HTTP_STATUS.unauthorized) {
      return { response: first, token: null };
    }
    await first.body?.cancel();
    const challenge = challengeOf(first.headers.get(REGISTRY.challengeHeader));
    if (challenge === null) {
      if (access === null)
        throw new RegistryError(REGISTRY_MESSAGES.wantsCredentials(registryName(reference.registry)));
      return { response: await this.request(first.url || url, method, null, access), token: null };
    }
    const token = await this.token(tokenUrlOf(challenge, reference.registry), reference.registry, access);
    return { response: await this.request(first.url || url, method, token), token };
  }

  // A blob's GET may be redirected to a storage service; fetch drops the token on a hop to another origin.
  private request(url: string, method: RequestMethod, token: string | null, access: RegistryAccess | null = null) {
    const headers: Record<string, string> = { [HTTP_HEADERS.accept]: REGISTRY.manifestTypes.join(", ") };
    if (token !== null) {
      headers[HTTP_HEADERS.authorization] = `${BEARER_PREFIX}${token}`;
    } else if (access !== null) {
      headers[HTTP_HEADERS.authorization] = basicHeader(access);
    }
    return this.fetchImplementation(url, {
      method,
      headers,
      signal: AbortSignal.timeout(REGISTRY.timeoutMilliseconds),
    });
  }

  private async documentOf(response: Response): Promise<RegistryDocument> {
    if (!response.ok) {
      await response.body?.cancel();
      throw new RegistryError(REGISTRY_MESSAGES.badStatus(response.status));
    }
    try {
      return JSON.parse(await textWithin(response, REGISTRY.documentBytesLimit)) as RegistryDocument;
    } catch (error) {
      throw error instanceof RegistryError ? error : new RegistryError(REGISTRY_MESSAGES.notJson);
    }
  }

  // ghcr.io refuses a token for a private image, or one it does not have, with 403: anonymously, and with a
  // credential that does not reach it.
  private async token(url: URL, registry: string, access: RegistryAccess | null): Promise<string> {
    if (access !== null && !mayHaveCredential(registry, url.host)) {
      throw new RegistryError(REGISTRY_MESSAGES.refusedCredentialRealm(url.origin));
    }
    const response = await this.fetchImplementation(url, {
      headers: access === null ? {} : { [HTTP_HEADERS.authorization]: basicHeader(access) },
      signal: AbortSignal.timeout(REGISTRY.timeoutMilliseconds),
    });
    if (isRefusal(response.status)) {
      throw new RegistryError(this.refusal(registry, access));
    }
    if (!response.ok) {
      throw new RegistryError(REGISTRY_MESSAGES.tokenStatus(response.status));
    }
    const body = (await response.json()) as Record<string, unknown>;
    const token = REGISTRY.tokenFields.map((field) => body[field]).find((value) => typeof value === "string" && value);
    if (typeof token !== "string") {
      throw new RegistryError(REGISTRY_MESSAGES.noToken);
    }
    return token;
  }

  private digestOf(response: Response): string {
    if (!response.ok) {
      throw new RegistryError(REGISTRY_MESSAGES.badStatus(response.status));
    }
    const digest = response.headers.get(REGISTRY.digestHeader) ?? "";
    if (!DIGEST_PATTERN.test(digest)) {
      throw new RegistryError(REGISTRY_MESSAGES.noDigest);
    }
    return digest;
  }
}
