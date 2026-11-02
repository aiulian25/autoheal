import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { API_ERRORS, API_ROUTES, CSRF_HEADER } from "../../shared/api.js";
import { HTTP_STATUS, UNSAFE_METHODS, WIDGET_KEY_HEADER } from "../../shared/constants.js";

const KEYED_ROUTES = new Set<string>([API_ROUTES.jarvisHeard]);

const sameSecret = (sent: string, expected: string) => {
  const sentBytes = Buffer.from(sent);
  const expectedBytes = Buffer.from(expected);
  return sentBytes.length === expectedBytes.length && timingSafeEqual(sentBytes, expectedBytes);
};

/**
 * Every state change must come from the dashboard's own origin; once signed in it must also
 * carry the session's CSRF token, which another site cannot read.
 */
export function registerCsrfProtection(app: FastifyInstance, publicOrigin: string) {
  app.addHook("onRequest", async (request, reply) => {
    if (!UNSAFE_METHODS.has(request.method)) {
      return;
    }
    // Home Assistant has no origin and no session: the route itself refuses anything but its key.
    if (KEYED_ROUTES.has(request.url) && typeof request.headers[WIDGET_KEY_HEADER] === "string") {
      return;
    }
    const forbidden = () => reply.code(HTTP_STATUS.forbidden).send({ error: API_ERRORS.csrfFailed });
    if (request.headers.origin !== publicOrigin) {
      return forbidden();
    }
    const session = request.authSession;
    if (session === null) {
      return;
    }
    const sent = request.headers[CSRF_HEADER];
    if (typeof sent !== "string" || !sameSecret(sent, session.csrfToken)) {
      return forbidden();
    }
  });
}
