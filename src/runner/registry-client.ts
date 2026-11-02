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
  REGISTRY_MESSAGES,
  URL_PROTOCOL_SUFFIX,
} from "../shared/constants.js";
import { splitTag } from "../shared/image-reference.js";
import type { ImageFacts } from "../shared/install.js";
import type { ImageLabels } from "../shared/protocol.js";
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

/** What a manifest, an index or an image configuration holds that is read here; all of it is the registry's word. */
interface RegistryDocument {
  mediaType?: unknown;
  manifests?: { digest?: unknown; platform?: { os?: unknown; architecture?: unknown } }[];
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

export class RegistryClient {
  constructor(private readonly fetchImplementation: typeof fetch = fetch) {}

  async digest(reference: ImageReference): Promise<string> {
    const { response } = await this.authorized(this.manifestUrl(reference, reference.tag), "HEAD", reference, null);
    return this.digestOf(response);
  }

  /**
   * What an image's build says it is: the labels of its configuration, this machine's variant of it. Its
   * manifest GET counts as one pull on Docker Hub (with the platform's manifest an index points to); the
   * configuration does not. One anonymous token serves every request.
   */
  async labels(reference: ImageReference, digest: string): Promise<ImageLabels> {
    const configuration = await this.configuration(reference, digest);
    return imageLabelsOf(configuration.config?.Labels ?? {});
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
  ): Promise<RegistryDocument> {
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
    return configuration;
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

  /** Asks with the token it has, or anonymously; refused even so, the image is not public there. */
  private async authorized(
    url: string,
    method: RequestMethod,
    reference: ImageReference,
    token: string | null,
  ): Promise<{ response: Response; token: string | null }> {
    const answer =
      token === null
        ? await this.anonymously(url, method, reference)
        : { response: await this.request(url, method, token), token };
    if (isRefusal(answer.response.status)) {
      await answer.response.body?.cancel();
      throw new RegistryError(REGISTRY_MESSAGES.wantsCredentials(registryName(reference.registry)));
    }
    return answer;
  }

  // Asks as it is; on a bearer challenge, fetches an anonymous token and asks again where the registry sent the
  // first request (lscr.io redirects to ghcr.io).
  private async anonymously(url: string, method: RequestMethod, reference: ImageReference) {
    const first = await this.request(url, method, null);
    if (first.status !== HTTP_STATUS.unauthorized) {
      return { response: first, token: null };
    }
    await first.body?.cancel();
    const challenge = challengeOf(first.headers.get(REGISTRY.challengeHeader));
    if (challenge === null) {
      throw new RegistryError(REGISTRY_MESSAGES.wantsCredentials(registryName(reference.registry)));
    }
    const anonymous = await this.anonymousToken(tokenUrlOf(challenge, reference.registry), reference.registry);
    return { response: await this.request(first.url || url, method, anonymous), token: anonymous };
  }

  // A blob's GET may be redirected to a storage service; fetch drops the token on a hop to another origin.
  private request(url: string, method: RequestMethod, token: string | null) {
    const headers: Record<string, string> = { [HTTP_HEADERS.accept]: REGISTRY.manifestTypes.join(", ") };
    if (token !== null) {
      headers[HTTP_HEADERS.authorization] = `${BEARER_PREFIX}${token}`;
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

  // ghcr.io refuses an anonymous token for a private image, or one it does not have, with 403.
  private async anonymousToken(url: URL, registry: string): Promise<string> {
    const response = await this.fetchImplementation(url, {
      signal: AbortSignal.timeout(REGISTRY.timeoutMilliseconds),
    });
    if (isRefusal(response.status)) {
      throw new RegistryError(REGISTRY_MESSAGES.wantsCredentials(registryName(registry)));
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
