import type { FastifyInstance } from "fastify";
import { API_ERRORS, type ApiErrorCode } from "../../shared/api.js";
import {
  API_PREFIX,
  ACCESS_ADMIN,
  ACCESS_FULL,
  ACCESS_PUBLIC,
  ACCESS_SIGNED_IN,
  ACCESS_VERIFIED,
  HTTP_STATUS,
  ROLE_ADMIN,
  SESSION_COOKIE_NAME,
  type Access,
} from "../../shared/constants.js";
import type { ResolvedSession, SessionStore } from "./sessions.js";

declare module "fastify" {
  interface FastifyRequest {
    authSession: ResolvedSession | null;
  }
  interface FastifyContextConfig {
    access?: Access;
  }
}

interface AccessProblem {
  statusCode: number;
  error: ApiErrorCode;
}

export function accessProblem(access: Access, session: ResolvedSession | null): AccessProblem | null {
  if (access === ACCESS_PUBLIC) {
    return null;
  }
  if (session === null) {
    return { statusCode: HTTP_STATUS.unauthorized, error: API_ERRORS.notSignedIn };
  }
  if (access === ACCESS_SIGNED_IN) {
    return null;
  }
  if (session.user.totpEnabled && !session.secondFactorDone) {
    return { statusCode: HTTP_STATUS.forbidden, error: API_ERRORS.secondFactorRequired };
  }
  if (access === ACCESS_VERIFIED) {
    return null;
  }
  if (session.user.mustChangePassword) {
    return { statusCode: HTTP_STATUS.forbidden, error: API_ERRORS.passwordChangeRequired };
  }
  if (!session.user.totpEnabled) {
    return { statusCode: HTTP_STATUS.forbidden, error: API_ERRORS.totpSetupRequired };
  }
  if (access === ACCESS_ADMIN && session.user.role !== ROLE_ADMIN) {
    return { statusCode: HTTP_STATUS.forbidden, error: API_ERRORS.adminOnly };
  }
  return null;
}

export function registerSessionResolution(app: FastifyInstance, sessions: SessionStore) {
  app.decorateRequest("authSession", null);
  app.addHook("onRequest", async (request) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    request.authSession = token ? sessions.resolve(token) : null;
  });
}

/**
 * API routes are full-access by default: a route must say so to be reachable with less. Outside
 * /api/ there is only the app shell and its assets, which hold no data and must load before sign-in.
 * The route that matched decides, never the address as sent: the router decodes it, so
 * /%61pi/users reaches /api/users.
 */
export function registerAccessControl(app: FastifyInstance) {
  app.addHook("onRequest", async (request, reply) => {
    const route = request.routeOptions.url;
    const isApiRoute = route !== undefined && route.startsWith(API_PREFIX);
    const access = isApiRoute ? (request.routeOptions.config.access ?? ACCESS_FULL) : ACCESS_PUBLIC;
    const problem = accessProblem(access, request.authSession);
    if (problem !== null) {
      return reply.code(problem.statusCode).send({ error: problem.error });
    }
  });
}
