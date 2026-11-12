import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NODE_TO_OCI_ARCHITECTURE, REGISTRY, REGISTRY_MESSAGES } from "../shared/constants.js";
import { RegistryClient, RegistryError, imageLabelsOf, parseImageReference } from "./registry-client.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("parseImageReference", () => {
  it.each([
    ["nginx", "registry-1.docker.io", "library/nginx", "latest"],
    ["linuxserver/sonarr:4", "registry-1.docker.io", "linuxserver/sonarr", "4"],
    ["docker.io/library/redis:7", "registry-1.docker.io", "library/redis", "7"],
    ["ghcr.io/paperless-ngx/paperless-ngx:2.13", "ghcr.io", "paperless-ngx/paperless-ngx", "2.13"],
    ["lscr.io/linuxserver/plex", "lscr.io", "linuxserver/plex", "latest"],
    ["localhost:5000/app", "localhost:5000", "app", "latest"],
    ["registry.lan:5000/team/app:1.2", "registry.lan:5000", "team/app", "1.2"],
  ])("reads %s", (reference, registry, repository, tag) => {
    expect(parseImageReference(reference)).toEqual({ registry, repository, tag });
  });

  it("leaves an image pinned to a digest alone: nothing newer can be behind it", () => {
    expect(parseImageReference(`nginx@${DIGEST}`)).toBeNull();
  });
});

describe("RegistryClient", () => {
  let server: Server;
  let base: string;
  let requests: { method: string; url: string; authorization: string | undefined }[];
  let realm: string;
  let challenge: "bearer" | "basic";

  beforeEach(async () => {
    requests = [];
    realm = "";
    challenge = "bearer";
    server = createServer((request: IncomingMessage, response) => {
      requests.push({ method: request.method!, url: request.url!, authorization: request.headers.authorization });
      if (request.url!.startsWith("/token")) {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(JSON.stringify({ token: "anonymous-token" }));
      }
      if (request.url === "/v2/team/missing/manifests/latest") {
        response.writeHead(404);
        return response.end();
      }
      // Private whoever asks: for the case where even a credential is turned down.
      if (request.url === "/v2/team/private/manifests/latest") {
        response.writeHead(403);
        return response.end();
      }
      if (challenge === "basic") {
        if (request.headers.authorization?.startsWith("Basic ") !== true) {
          response.writeHead(401, { "www-authenticate": 'Basic realm="registry"' });
          return response.end();
        }
        response.writeHead(200, { "docker-content-digest": DIGEST });
        return response.end();
      }
      if (request.headers.authorization !== "Bearer anonymous-token") {
        response.writeHead(401, {
          "www-authenticate": `Bearer realm="${realm}",service="registry",scope="repository:team/app:pull"`,
        });
        return response.end();
      }
      response.writeHead(200, { "docker-content-digest": DIGEST });
      return response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    realm = `http://${base}/token`;
  });

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("asks with HEAD, fetching an anonymous token when the registry wants one", async () => {
    const digest = await new RegistryClient().digest({ registry: base, repository: "team/app", tag: "2.1" });
    expect(digest).toBe(DIGEST);
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "HEAD /v2/team/app/manifests/2.1",
      "GET /token?service=registry&scope=repository%3Ateam%2Fapp%3Apull",
      "HEAD /v2/team/app/manifests/2.1",
    ]);
  });

  it("refuses to fetch a token from anywhere but https or the registry's own loopback", async () => {
    realm = "http://tokens.example.com/token";
    const asking = new RegistryClient().digest({ registry: base, repository: "team/app", tag: "2.1" });
    await expect(asking).rejects.toThrow(RegistryError);
    expect(requests).toHaveLength(1);
  });

  it("never fetches a token over plain http for a registry elsewhere, even from a local address", async () => {
    const asked: string[] = [];
    const remoteRegistry = (async (url: string | URL | Request) => {
      asked.push(String(url));
      const challenge = 'Bearer realm="http://127.0.0.1:9/token",service="registry",scope="repository:team/app:pull"';
      return new Response(null, { status: 401, headers: { "www-authenticate": challenge } });
    }) as typeof fetch;
    const asking = new RegistryClient(remoteRegistry).digest({
      registry: "registry.example.com",
      repository: "team/app",
      tag: "1",
    });
    await expect(asking).rejects.toThrow("refused a token address at http://127.0.0.1:9");
    expect(asked).toEqual(["https://registry.example.com/v2/team/app/manifests/1"]);
  });

  it("says an image is not public when the registry refuses an anonymous token, as ghcr.io does", async () => {
    const refusing = (async (url: string | URL | Request) => {
      if (String(url).includes("/token")) {
        return new Response(null, { status: 403 });
      }
      const challenge = 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:owner/private:pull"';
      return new Response(null, { status: 401, headers: { "www-authenticate": challenge } });
    }) as typeof fetch;
    const asking = new RegistryClient(refusing).digest({ registry: "ghcr.io", repository: "owner/private", tag: "1" });
    await expect(asking).rejects.toThrow("not public on ghcr.io: private, or built on this host");

    // Docker Hub gives the token, then refuses the image itself: one built here under a name nobody published.
    const hub = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/token")) {
        return Response.json({ token: "anonymous-token" });
      }
      const challenge = 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"';
      const withToken = new Headers(init?.headers).has("authorization");
      return new Response(null, { status: 401, headers: withToken ? {} : { "www-authenticate": challenge } });
    }) as typeof fetch;
    const local = new RegistryClient(hub).digest({
      registry: "registry-1.docker.io",
      repository: "library/notebook",
      tag: "latest",
    });
    await expect(local).rejects.toThrow("not public on Docker Hub: private, or built on this host");
  });

  it("says what the registry answered when it has no such image", async () => {
    const asking = new RegistryClient().digest({ registry: base, repository: "team/missing", tag: "latest" });
    await expect(asking).rejects.toThrow("the registry answered HTTP 404");
  });

  describe("a token answer", () => {
    const TOKEN_REALM = "https://registry.example.com/token";
    const REFERENCE = { registry: "registry.example.com", repository: "team/app", tag: "1" };
    const PADDING_CHUNK_BYTES = 16 * 1024;
    // Far past any token answer, and still small enough for a test to send.
    const PADDING_BYTES = 2 * 1024 * 1024;

    // A token service answering with `answer`, in front of a registry that takes any token and asks for one otherwise.
    const registryAnswering = (answer: () => Response) => {
      const asked: string[] = [];
      const fetching = (async (url: string | URL | Request, init?: RequestInit) => {
        asked.push(String(url));
        if (String(url).startsWith(TOKEN_REALM)) return answer();
        if (new Headers(init?.headers).has("authorization")) {
          return new Response(null, { status: 200, headers: { "docker-content-digest": DIGEST } });
        }
        const challenge = `Bearer realm="${TOKEN_REALM}",service="registry",scope="repository:team/app:pull"`;
        return new Response(null, { status: 401, headers: { "www-authenticate": challenge } });
      }) as typeof fetch;
      return { asked, digest: () => new RegistryClient(fetching).digest(REFERENCE) };
    };

    // A token and then padding, with no length said: how much of it was pulled, and whether the rest was let go.
    const paddedToken = () => {
      const encoder = new TextEncoder();
      const padding = encoder.encode("x".repeat(PADDING_CHUNK_BYTES));
      const parts = [
        encoder.encode('{"token":"made-up-token","padding":"'),
        ...Array.from({ length: PADDING_BYTES / PADDING_CHUNK_BYTES }, () => padding),
        encoder.encode('"}'),
      ];
      const seen = { pulled: 0, cancelled: false };
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const part = parts.shift();
          if (part === undefined) return controller.close();
          seen.pulled += part.byteLength;
          controller.enqueue(part);
        },
        cancel() {
          seen.cancelled = true;
        },
      });
      return { seen, body };
    };

    it("reads no more of it than a token answer can be, lets the rest go and asks nothing more", async () => {
      const answer = paddedToken();
      const registry = registryAnswering(() => new Response(answer.body));
      await expect(registry.digest()).rejects.toThrow(REGISTRY_MESSAGES.tokenTooLarge);
      expect(answer.seen.pulled).toBeLessThanOrEqual(REGISTRY.tokenBytesLimit + 2 * PADDING_CHUNK_BYTES);
      expect(answer.seen.cancelled).toBe(true);
      expect(registry.asked).toHaveLength(2);
    });

    it.each([[403], [500]])("lets go of a token answer it turns down, with HTTP %i", async (status) => {
      const answer = paddedToken();
      const registry = registryAnswering(() => new Response(answer.body, { status }));
      await expect(registry.digest()).rejects.toThrow(RegistryError);
      expect(answer.seen.cancelled).toBe(true);
    });

    it.each([
      ["one that is not JSON", "made-up-token-text, not JSON"],
      ["a token that cannot be sent as one", JSON.stringify({ token: "made-up-token-text\r\nX-Other: 1" })],
    ])("refuses %s without repeating any of it", async (_what, text) => {
      const registry = registryAnswering(() => new Response(text));
      const failure = await registry.digest().then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(RegistryError);
      expect((failure as Error).message).not.toContain("made-up");
      expect(registry.asked).toHaveLength(2);
    });

    it("still takes a token as registries give one", async () => {
      const token = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIifQ.c2lnbmF0dXJl";
      const registry = registryAnswering(() => Response.json({ token, access_token: token, expires_in: 300 }));
      expect(await registry.digest()).toBe(DIGEST);
    });
  });
});

describe("RegistryClient.labels", () => {
  const sha = (character: string) => `sha256:${character.repeat(64)}`;
  const INDEX = sha("1");
  const CONFIG = sha("c");
  const ARCHITECTURE = NODE_TO_OCI_ARCHITECTURE[process.arch] ?? process.arch;
  // The index names a manifest per platform; only this machine's leads to a configuration.
  const PLATFORM = sha("2");
  const OTHER = sha("3");
  const LIMIT = 1024 * 1024;
  let server: Server;
  let base: string;
  let requests: string[];

  beforeEach(async () => {
    requests = [];
    server = createServer((request: IncomingMessage, response) => {
      requests.push(`${request.method} ${request.url}`);
      const json = (body: unknown) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.url!.startsWith("/token")) {
        return json({ token: "anonymous-token" });
      }
      if (request.headers.authorization !== "Bearer anonymous-token") {
        response.writeHead(401, {
          "www-authenticate": `Bearer realm="http://${base}/token",service="registry",scope="repository:team/app:pull"`,
        });
        return response.end(JSON.stringify({ errors: [{ code: "UNAUTHORIZED" }] }));
      }
      const url = request.url!;
      if (url === `/v2/team/app/manifests/${INDEX}`) {
        return json({
          mediaType: "application/vnd.oci.image.index.v1+json",
          manifests: [
            { digest: sha("4"), platform: { os: "unknown", architecture: "unknown" } },
            { digest: OTHER, platform: { os: "linux", architecture: ARCHITECTURE === "s390x" ? "riscv64" : "s390x" } },
            { digest: PLATFORM, platform: { os: "linux", architecture: ARCHITECTURE } },
          ],
        });
      }
      if (url === `/v2/team/app/manifests/${PLATFORM}`) {
        return json({ mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: CONFIG } });
      }
      // As registries do, the configuration is served from a storage address.
      if (url === `/v2/team/app/blobs/${CONFIG}`) {
        response.writeHead(307, { location: `/storage/${CONFIG}` });
        return response.end();
      }
      if (url === `/storage/${CONFIG}`) {
        return json({
          architecture: ARCHITECTURE,
          config: {
            Labels: {
              "org.opencontainers.image.version": "v1.120.2",
              "org.opencontainers.image.revision": "4b3c2a1",
              "org.opencontainers.image.source": "https://github.com/immich-app/immich",
              "org.opencontainers.image.created": "2026-10-20T08:15:00Z",
            },
          },
        });
      }
      if (url === `/v2/team/one-platform/manifests/${INDEX}`) {
        return json({ manifests: [{ digest: OTHER, platform: { os: "windows", architecture: ARCHITECTURE } }] });
      }
      if (url === `/v2/team/declared/manifests/${INDEX}`) {
        response.writeHead(200, { "content-type": "application/json", "content-length": String(LIMIT + 1) });
        return response.end();
      }
      if (url === `/v2/team/endless/manifests/${INDEX}`) {
        // No length said: it is counted as it comes.
        response.writeHead(200, { "content-type": "application/json" });
        response.write(`{"padding":"${"x".repeat(LIMIT)}`);
        return response.end(`"}`);
      }
      response.writeHead(404);
      return response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const labelsOf = (repository: string) =>
    new RegistryClient().labels({ registry: base, repository, tag: "release" }, INDEX);

  it("reads the labels of this machine's image through an index, with one token for every request", async () => {
    expect(await labelsOf("team/app")).toEqual({
      version: "v1.120.2",
      revision: "4b3c2a1",
      source: "https://github.com/immich-app/immich",
      createdAt: Date.UTC(2026, 9, 20, 8, 15),
      configDigest: CONFIG,
    });
    expect(requests).toEqual([
      `GET /v2/team/app/manifests/${INDEX}`,
      "GET /token?service=registry&scope=repository%3Ateam%2Fapp%3Apull",
      `GET /v2/team/app/manifests/${INDEX}`,
      `GET /v2/team/app/manifests/${PLATFORM}`,
      `GET /v2/team/app/blobs/${CONFIG}`,
      `GET /storage/${CONFIG}`,
    ]);
  });

  it("says when the image has no variant for this machine", async () => {
    await expect(labelsOf("team/one-platform")).rejects.toThrow(`the image has no linux/${ARCHITECTURE} variant`);
  });

  it("refuses an answer larger than a manifest can be, said or not", async () => {
    await expect(labelsOf("team/declared")).rejects.toThrow("the registry's answer was larger than a manifest can be");
    await expect(labelsOf("team/endless")).rejects.toThrow("the registry's answer was larger than a manifest can be");
  });

  it("keeps a source only when it is a whole web link", async () => {
    const answering = (labels: Record<string, string>) =>
      (async (url: string | URL | Request) =>
        String(url).includes("/blobs/")
          ? Response.json({ config: { Labels: labels } })
          : Response.json({ config: { digest: CONFIG } })) as typeof fetch;
    const read = (labels: Record<string, string>) =>
      new RegistryClient(answering(labels)).labels(
        { registry: "registry.example.com", repository: "team/app", tag: "1" },
        INDEX,
      );
    expect(await read({ "org.opencontainers.image.source": "javascript:alert(1)" })).toMatchObject({ source: null });
    expect(await read({ "org.opencontainers.image.source": `https://example.com/${"a".repeat(600)}` })).toMatchObject({
      source: null,
    });
    expect(
      await read({ "org.opencontainers.image.version": "  ", "org.opencontainers.image.created": "soon" }),
    ).toEqual({
      version: null,
      revision: null,
      source: null,
      createdAt: null,
      configDigest: CONFIG,
    });
  });
});

describe("imageLabelsOf", () => {
  it("reads the Label Schema labels of an image without OCI ones, as Radicale's", () => {
    expect(
      imageLabelsOf({
        "org.label-schema.version": "3.8.3",
        "org.label-schema.vcs-ref": "",
        "org.label-schema.vcs-url": "https://github.com/tomsquest/docker-radicale",
        "org.label-schema.build-date": "2026-10-23T21:04:00Z",
      }),
    ).toEqual({
      version: "3.8.3",
      revision: null,
      source: "https://github.com/tomsquest/docker-radicale",
      createdAt: Date.UTC(2026, 9, 23, 21, 4),
    });
  });

  it("prefers the OCI label where an image has both", () => {
    expect(
      imageLabelsOf({ "org.opencontainers.image.version": "2.1.0", "org.label-schema.version": "2.0.0" }),
    ).toMatchObject({ version: "2.1.0" });
  });
});

describe("RegistryClient with a stored credential", () => {
  let server: Server;
  let base: string;
  let requests: { url: string; authorization: string | undefined }[];
  let realm: string;
  let basicOnly: boolean;
  const owner = { registry: "", repository: "team/app", username: "owner", password: "a-token" };
  const basic = `Basic ${Buffer.from("owner:a-token").toString("base64")}`;

  beforeEach(async () => {
    requests = [];
    basicOnly = false;
    server = createServer((request: IncomingMessage, response) => {
      requests.push({ url: request.url!, authorization: request.headers.authorization });
      if (request.url!.startsWith("/token")) {
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(JSON.stringify({ token: "scoped-token" }));
      }
      if (request.url === "/v2/team/private/manifests/latest") {
        response.writeHead(403);
        return response.end();
      }
      const allowed = basicOnly ? basic : "Bearer scoped-token";
      if (request.headers.authorization !== allowed) {
        response.writeHead(401, {
          "www-authenticate": basicOnly ? 'Basic realm="registry"' : `Bearer realm="${realm}",service="registry"`,
        });
        return response.end();
      }
      response.writeHead(200, { "docker-content-digest": DIGEST });
      return response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    realm = `http://${base}/token`;
    owner.registry = base;
  });

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const client = (...available: (typeof owner)[]) => new RegistryClient(fetch, () => available);

  it("proves the credential to the token address, so a private repository answers", async () => {
    const digest = await client(owner).digest({ registry: base, repository: "team/app", tag: "latest" });

    expect(digest).toBe(DIGEST);
    expect(requests.map(({ url }) => url)).toEqual([
      "/v2/team/app/manifests/latest",
      "/token?service=registry",
      "/v2/team/app/manifests/latest",
    ]);
    expect(requests[1]!.authorization).toBe(basic);
    expect(requests[2]!.authorization).toBe("Bearer scoped-token");
  });

  it("asks anonymously for a repository no credential covers", async () => {
    await client({ ...owner, repository: "team/other" })
      .digest({ registry: base, repository: "team/app", tag: "latest" })
      .catch(() => undefined);

    expect(requests[1]!.authorization).toBeUndefined();
  });

  it("tells the registry itself when it asks for basic authentication", async () => {
    basicOnly = true;

    expect(await client(owner).digest({ registry: base, repository: "team/app", tag: "latest" })).toBe(DIGEST);
    expect(requests.map(({ authorization }) => authorization)).toEqual([undefined, basic]);
  });

  it("will not send the credential to a token address the registry picked elsewhere", async () => {
    realm = "https://token.example.com/token";

    await expect(client(owner).digest({ registry: base, repository: "team/app", tag: "latest" })).rejects.toThrow(
      /would not send the credential to a token address at https:\/\/token.example.com/,
    );
    expect(requests).toHaveLength(1);
  });

  it("says the registry refused the stored credential, naming the user and not the password", async () => {
    const refused = client({ ...owner, repository: "team/private" })
      .digest({ registry: base, repository: "team/private", tag: "latest" })
      .catch((error: Error) => error.message);

    expect(await refused).toBe(`${base} refused the stored credential for owner`);
    expect(await refused).not.toContain("a-token");
  });

  it("says an image is simply not public there when no credential covers it", async () => {
    const refused = client()
      .digest({ registry: base, repository: "team/private", tag: "latest" })
      .catch((error: Error) => error.message);

    expect(await refused).toContain("not public");
  });
});

describe("a stored credential, when its registry sends the request on", () => {
  const TOKEN = "scoped-token";
  const ELSEWHERE_TOKEN = "elsewhere-token";
  const basic = `Basic ${Buffer.from("owner:a-token").toString("base64")}`;
  let registry: Server;
  let elsewhere: Server;
  let registryHost: string;
  let elsewhereHost: string;
  // What reaches the other address, and what it asks for when nothing is sent.
  let seenElsewhere: (string | undefined)[];
  let challengeElsewhere: string;

  const listen = async (handler: (request: IncomingMessage, response: import("node:http").ServerResponse) => void) => {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, host: `127.0.0.1:${(server.address() as AddressInfo).port}` };
  };
  const found = (response: import("node:http").ServerResponse) => {
    response.writeHead(200, { "docker-content-digest": DIGEST });
    response.end();
  };
  const tokenAnswer = (response: import("node:http").ServerResponse, token: string) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ token }));
  };

  beforeEach(async () => {
    seenElsewhere = [];
    ({ server: elsewhere, host: elsewhereHost } = await listen((request, response) => {
      if (request.url!.startsWith("/token")) return tokenAnswer(response, ELSEWHERE_TOKEN);
      seenElsewhere.push(request.headers.authorization);
      if (request.headers.authorization !== undefined) return found(response);
      response.writeHead(401, { "www-authenticate": challengeElsewhere });
      response.end();
    }));
    ({ server: registry, host: registryHost } = await listen((request, response) => {
      if (request.url!.startsWith("/token")) return tokenAnswer(response, TOKEN);
      if (request.url === "/v2/team/renamed/manifests/latest") {
        response.writeHead(307, { location: "/v2/team/app/manifests/latest" });
        return response.end();
      }
      if (request.url === "/v2/team/app/manifests/latest") {
        if (request.headers.authorization === basic) return found(response);
        response.writeHead(401, { "www-authenticate": 'Basic realm="registry"' });
        return response.end();
      }
      response.writeHead(307, { location: `http://${elsewhereHost}${request.url}` });
      response.end();
    }));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => registry.close(() => resolve()));
    await new Promise<void>((resolve) => elsewhere.close(() => resolve()));
  });

  const team = () => ({ registry: registryHost, repository: "team", username: "owner", password: "a-token" });
  const moved = () => ({ registry: registryHost, repository: "team/moved", tag: "latest" });

  const answerTo = (reference: ReturnType<typeof moved>) =>
    new RegistryClient(fetch, () => [team()]).digest(reference).then(
      (digest) => digest,
      (error: Error) => error.message,
    );

  it("never sends it on where a registry asking for basic authentication sent the request", async () => {
    challengeElsewhere = 'Basic realm="elsewhere"';

    const answer = await answerTo(moved());

    expect(seenElsewhere).toEqual([undefined]);
    expect(answer).toBe(REGISTRY_MESSAGES.refusedCredentialRedirect(`http://${elsewhereHost}`));
  });

  it("never sends a token got with it on to another address either", async () => {
    challengeElsewhere = `Bearer realm="http://${registryHost}/token",service="registry"`;

    const answer = await answerTo(moved());

    expect(seenElsewhere).toEqual([undefined]);
    expect(answer).toBe(REGISTRY_MESSAGES.refusedCredentialRedirect(`http://${elsewhereHost}`));
  });

  it("follows a registry that moves the request within itself, credential and all", async () => {
    const renamed = { registry: registryHost, repository: "team/renamed", tag: "latest" };
    expect(await new RegistryClient(fetch, () => [team()]).digest(renamed)).toBe(DIGEST);
  });

  it("still asks wherever a registry sends the request when there is no credential to keep, as lscr.io does", async () => {
    challengeElsewhere = `Bearer realm="http://${elsewhereHost}/token",service="elsewhere"`;

    expect(await new RegistryClient(fetch, () => []).digest(moved())).toBe(DIGEST);
    expect(seenElsewhere).toEqual([undefined, `Bearer ${ELSEWHERE_TOKEN}`]);
  });
});

describe("RegistryClient.tags", () => {
  let server: Server;
  let base: string;
  let asked: string[];
  let nextLink: string;

  beforeEach(async () => {
    asked = [];
    nextLink = '</v2/team/app/tags/list?last=1.1.0&n=1000>; rel="next"';
    server = createServer((request, response) => {
      asked.push(request.url!);
      if (request.headers.authorization !== "Bearer anonymous-token" && !request.url!.startsWith("/token")) {
        response.writeHead(401, {
          "www-authenticate": `Bearer realm="http://${base}/token",service="registry",scope="repository:team/app:pull"`,
        });
        return response.end();
      }
      response.writeHead(200, {
        "content-type": "application/json",
        ...(request.url!.includes("last=") ? {} : { link: nextLink }),
      });
      if (request.url!.startsWith("/token")) return response.end(JSON.stringify({ token: "anonymous-token" }));
      const tags = request.url!.includes("last=") ? ["1.2.0", "latest"] : ["1.0.0", "1.1.0", "bad tag", 7];
      return response.end(JSON.stringify({ name: "team/app", tags }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("reads every page its Link header leads to, keeping only well-formed tags", async () => {
    const tags = await new RegistryClient().tags({ registry: base, repository: "team/app", tag: "1.0.0" });

    expect(tags).toEqual(["1.0.0", "1.1.0", "1.2.0", "latest"]);
    expect(asked.filter((url) => url.startsWith("/v2/") && url.includes("last="))).toHaveLength(1);
  });

  it("does not follow a next page on another address, which would be handed the token", async () => {
    nextLink = '<http://elsewhere.invalid/v2/team/app/tags/list?last=1.1.0>; rel="next"';

    const tags = await new RegistryClient().tags({ registry: base, repository: "team/app", tag: "1.0.0" });

    expect(tags).toEqual(["1.0.0", "1.1.0"]);
  });
});
