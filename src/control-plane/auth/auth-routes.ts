import type { CookieSerializeOptions } from "@fastify/cookie";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ERRORS, API_ROUTES } from "../../shared/api.js";
import {
  ACCESS_PUBLIC,
  ACCESS_SIGNED_IN,
  ACCESS_VERIFIED,
  COOKIE_PATH,
  HTTP_HEADERS,
  HTTP_STATUS,
  LOGIN_FIELD_MAXIMUM_LENGTH,
  MILLISECONDS_PER_SECOND,
  RATE_LIMIT_WINDOW_MILLISECONDS,
  SESSION_ABSOLUTE_MILLISECONDS,
  SESSION_COOKIE_NAME,
  SIGN_IN_RATE_LIMIT_PER_MINUTE,
} from "../../shared/constants.js";
import { HttpError, parseBody } from "../http/errors.js";
import { requestContext } from "../http/request-context.js";
import { sessionView, type AuthService } from "./auth-service.js";

const field = z.string().min(1).max(LOGIN_FIELD_MAXIMUM_LENGTH);
const loginBody = z.object({ username: field, password: field });
const changePasswordBody = z.object({ currentPassword: field, newPassword: field });

export const sessionCookie: CookieSerializeOptions = {
  path: COOKIE_PATH,
  httpOnly: true,
  secure: true,
  sameSite: "strict",
  maxAge: SESSION_ABSOLUTE_MILLISECONDS / MILLISECONDS_PER_SECOND,
};

export const signInRateLimit = { max: SIGN_IN_RATE_LIMIT_PER_MINUTE, timeWindow: RATE_LIMIT_WINDOW_MILLISECONDS };
// A step that gives a session a new token found it gone: signed out, or expired, meanwhile.
export const sessionEnded = () => new HttpError(HTTP_STATUS.unauthorized, API_ERRORS.notSignedIn);

export function registerAuthRoutes(app: FastifyInstance, authService: AuthService) {
  app.post(
    API_ROUTES.login,
    { config: { access: ACCESS_PUBLIC, rateLimit: signInRateLimit } },
    async (request, reply) => {
      const result = await authService.login(parseBody(loginBody, request.body), requestContext(request));
      if (result.kind === "throttled") {
        reply.header(HTTP_HEADERS.retryAfter, String(result.retryAfterSeconds));
        throw new HttpError(HTTP_STATUS.tooManyRequests, API_ERRORS.tooManyAttempts, {
          retryAfterSeconds: result.retryAfterSeconds,
        });
      }
      if (result.kind === "rejected") {
        throw new HttpError(HTTP_STATUS.unauthorized, API_ERRORS.wrongCredentials);
      }
      reply.setCookie(SESSION_COOKIE_NAME, result.token, sessionCookie);
      return result.session;
    },
  );

  app.post(API_ROUTES.logout, { config: { access: ACCESS_SIGNED_IN } }, async (request, reply) => {
    authService.logout(request.authSession!, requestContext(request));
    reply.clearCookie(SESSION_COOKIE_NAME, sessionCookie);
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.get(API_ROUTES.session, { config: { access: ACCESS_SIGNED_IN } }, async (request) =>
    sessionView(request.authSession!),
  );

  // It checks the current password, so it gets sign-in's tighter limit: a stolen session buys no fast guessing.
  const changePasswordRoute = { config: { access: ACCESS_VERIFIED, rateLimit: signInRateLimit } } as const;
  app.post(API_ROUTES.changePassword, changePasswordRoute, async (request, reply) => {
    const change = parseBody(changePasswordBody, request.body);
    const result = await authService.changePassword(request.authSession!, change, requestContext(request));
    if (result.kind === "wrong_password") {
      throw new HttpError(HTTP_STATUS.badRequest, API_ERRORS.wrongPassword);
    }
    if (result.kind === "same_password") {
      throw new HttpError(HTTP_STATUS.badRequest, API_ERRORS.samePassword);
    }
    if (result.kind === "policy") {
      throw new HttpError(HTTP_STATUS.badRequest, API_ERRORS.passwordPolicy, { problems: result.problems });
    }
    if (result.kind === "session_ended") {
      throw sessionEnded();
    }
    reply.setCookie(SESSION_COOKIE_NAME, result.token, sessionCookie);
    return reply.code(HTTP_STATUS.noContent).send();
  });
}
