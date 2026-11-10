// A read-only registry for the drills: serves one image, saved by `docker save` as an OCI layout, under any tag.
// Older images named after the port are still served by digest, as a registry keeps the versions it had.
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";

const [root, port, ...older] = process.argv.slice(2);
const tagged = JSON.parse(readFileSync(`${root}/index.json`, "utf8")).manifests[0];
const blobPath = (digest) =>
  [root, ...older].map((folder) => `${folder}/blobs/${digest.replace(":", "/")}`).find((path) => existsSync(path)) ??
  null;
const ROUTE = /^\/v2\/.+\/(manifests|blobs)\/([^/]+)$/;

createServer((request, response) => {
  const { pathname } = new URL(request.url, "http://registry");
  if (pathname === "/v2/") return response.writeHead(200).end("{}");
  const [, kind, reference] = pathname.match(ROUTE) ?? [];
  const digest = kind === "manifests" && !reference.startsWith("sha256:") ? tagged.digest : reference;
  const path = digest === undefined ? null : blobPath(digest);
  if (path === null || !existsSync(path)) return response.writeHead(404).end();
  const type =
    kind === "manifests"
      ? (JSON.parse(readFileSync(path, "utf8")).mediaType ?? tagged.mediaType)
      : "application/octet-stream";
  response.writeHead(200, {
    "content-type": type,
    "docker-content-digest": digest,
    "content-length": statSync(path).size,
  });
  if (request.method === "HEAD") return response.end();
  createReadStream(path).pipe(response);
}).listen(Number(port), "127.0.0.1");
