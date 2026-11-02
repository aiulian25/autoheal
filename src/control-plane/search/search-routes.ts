import type { FastifyInstance } from "fastify";
import { API_ROUTES } from "../../shared/api.js";
import { HTTP_HEADERS, NO_STORE } from "../../shared/constants.js";
import { searchRequestSchema } from "../../shared/search.js";
import { parseBody } from "../http/errors.js";
import type { SearchService } from "./search-service.js";
/** Every supported entity has the existing full-session viewer read boundary; no admin-only entity is indexed. */
export function registerSearchRoutes(app: FastifyInstance, service: SearchService) {
  app.get(API_ROUTES.search, async (request, reply) => {
    reply.header(HTTP_HEADERS.cacheControl, NO_STORE);
    return service.search(parseBody(searchRequestSchema, request.query));
  });
}
