import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NODE_TO_OCI_ARCHITECTURE } from "../shared/constants.js";
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

  beforeEach(async () => {
    requests = [];
    realm = "";
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
      repository: "library/cinesort",
      tag: "latest",
    });
    await expect(local).rejects.toThrow("not public on Docker Hub: private, or built on this host");
  });

  it("says what the registry answered when it has no such image", async () => {
    const asking = new RegistryClient().digest({ registry: base, repository: "team/missing", tag: "latest" });
    await expect(asking).rejects.toThrow("the registry answered HTTP 404");
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
