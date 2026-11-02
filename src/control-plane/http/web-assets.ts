import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { API_ERRORS } from "../../shared/api.js";
import {
  API_PREFIX,
  ASSETS_PATH_PREFIX,
  HTTP_HEADERS,
  HTTP_STATUS,
  IMMUTABLE_CACHE,
  INDEX_HTML,
  NO_CACHE,
} from "../../shared/constants.js";

// dist/server/control-plane/http → dist/web once built; in the source tree it is never served.
const BUILT_WEB_ASSETS = fileURLToPath(new URL("../../../web/", import.meta.url));

export const builtWebAssets = () => (existsSync(join(BUILT_WEB_ASSETS, INDEX_HTML)) ? BUILT_WEB_ASSETS : null);

/**
 * The React build: hashed assets cached forever, everything else that is not the API gets
 * index.html so deep links (a notification's incident link) open the app.
 */
export async function registerWebAssets(app: FastifyInstance, directory: string | null) {
  const answerNotFound = (request: { method: string; url: string }) =>
    directory === null || request.method !== "GET" || request.url.startsWith(API_PREFIX);
  if (directory !== null) {
    await app.register(fastifyStatic, {
      root: directory,
      wildcard: false,
      index: false,
      setHeaders: (response, path) => {
        const isHashedAsset = path.includes(ASSETS_PATH_PREFIX);
        response.header(HTTP_HEADERS.cacheControl, isHashedAsset ? IMMUTABLE_CACHE : NO_CACHE);
      },
    });
  }
  app.setNotFoundHandler((request, reply) => {
    if (answerNotFound(request)) {
      return reply.code(HTTP_STATUS.notFound).send({ error: API_ERRORS.notFound });
    }
    return reply.header(HTTP_HEADERS.cacheControl, NO_CACHE).sendFile(INDEX_HTML);
  });
}
