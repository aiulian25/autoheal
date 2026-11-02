import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { API_ERRORS } from "../../shared/api.js";
import {
  API_PREFIX,
  CONTENT_SECURITY_POLICY,
  GLOBAL_RATE_LIMIT_PER_MINUTE,
  HSTS_MAX_AGE_SECONDS,
  HTTP_HEADERS,
  HTTP_STATUS,
  MILLISECONDS_PER_SECOND,
  NO_STORE,
  PERMISSIONS_POLICY,
  RATE_LIMIT_WINDOW_MILLISECONDS,
  REFERRER_POLICY,
} from "../../shared/constants.js";
import { HttpError } from "./errors.js";

/** Headers, rate limit and host check for every response, 404s included. */
export async function registerSecurity(app: FastifyInstance, publicHost: string) {
  await app.register(helmet, {
    contentSecurityPolicy: { useDefaults: false, directives: CONTENT_SECURITY_POLICY },
    strictTransportSecurity: { maxAge: HSTS_MAX_AGE_SECONDS, includeSubDomains: false },
    referrerPolicy: { policy: REFERRER_POLICY },
  });
  await app.register(rateLimit, {
    global: true,
    max: GLOBAL_RATE_LIMIT_PER_MINUTE,
    timeWindow: RATE_LIMIT_WINDOW_MILLISECONDS,
    // Only the API counts: the app's own page, icons and bundles cost nothing to serve, and counting them left
    // someone moving quickly between pages waiting for a minute. By the matched route, as the access check does,
    // so an encoded address that reaches the API counts too.
    allowList: (request) => !(request.routeOptions.url ?? request.url).startsWith(API_PREFIX),
    errorResponseBuilder: (_request, context) =>
      new HttpError(HTTP_STATUS.tooManyRequests, API_ERRORS.tooManyAttempts, {
        retryAfterSeconds: Math.ceil(context.ttl / MILLISECONDS_PER_SECOND),
      }),
  });
  // Behind a trusted proxy request.host is X-Forwarded-Host; anything else was not meant for us.
  app.addHook("onRequest", async (request, reply) => {
    if (request.host !== publicHost) {
      return reply.code(HTTP_STATUS.misdirectedRequest).send({ error: API_ERRORS.misdirectedRequest });
    }
  });
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header(HTTP_HEADERS.permissionsPolicy, PERMISSIONS_POLICY);
    // The matched route, as the access check uses: an encoded address still reaches the API.
    if ((request.routeOptions.url ?? request.url).startsWith(API_PREFIX)) {
      reply.header(HTTP_HEADERS.cacheControl, NO_STORE);
    }
    return payload;
  });
}
