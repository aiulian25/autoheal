import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { API_ERRORS, API_ROUTES, type TotpEnabledView } from "../../shared/api.js";
import {
  ACCESS_SIGNED_IN,
  ACCESS_VERIFIED,
  HTTP_HEADERS,
  HTTP_STATUS,
  SECOND_FACTOR_CODE_MAXIMUM_LENGTH,
  SESSION_COOKIE_NAME,
} from "../../shared/constants.js";
import { TOTP_FAILURE } from "../../shared/constants.js";
import type { BackupPassphraseNotice } from "../backups/backup-passphrase.js";
import { HttpError, parseBody } from "../http/errors.js";
import { requestContext } from "../http/request-context.js";
import { sessionCookie, sessionEnded, signInRateLimit } from "./auth-routes.js";
import type { CodeRefusal, SecondFactorService } from "./second-factor-service.js";
import type { TotpFailure } from "./totp.js";

export const codeBody = z.object({ code: z.string().trim().min(1).max(SECOND_FACTOR_CODE_MAXIMUM_LENGTH) });

const alreadyEnabled = () => new HttpError(HTTP_STATUS.conflict, API_ERRORS.totpAlreadyEnabled);
// Says what to fix: wait for the next code, set the phone's clock, or pick the right entry.
export function wrongCode(failure: TotpFailure) {
  if (failure.reason === TOTP_FAILURE.alreadyUsed) {
    return new HttpError(HTTP_STATUS.badRequest, API_ERRORS.codeAlreadyUsed);
  }
  if (failure.reason === TOTP_FAILURE.clock) {
    return new HttpError(HTTP_STATUS.badRequest, API_ERRORS.clockDrift, { clockOffsetSeconds: failure.offsetSeconds });
  }
  return new HttpError(HTTP_STATUS.badRequest, API_ERRORS.wrongCode);
}

/** A refused code as the answer to send: wrong (saying why), or too many tries (saying when). */
export function codeRefused(refusal: CodeRefusal, reply: FastifyReply): HttpError {
  if (refusal.kind === "wrong_code") {
    return wrongCode(refusal.failure);
  }
  reply.header(HTTP_HEADERS.retryAfter, String(refusal.retryAfterSeconds));
  return new HttpError(HTTP_STATUS.tooManyRequests, API_ERRORS.tooManyAttempts, {
    retryAfterSeconds: refusal.retryAfterSeconds,
  });
}

export function registerSecondFactorRoutes(
  app: FastifyInstance,
  secondFactor: SecondFactorService,
  passphraseNotice: BackupPassphraseNotice,
) {
  app.post(API_ROUTES.totpSetup, { config: { access: ACCESS_VERIFIED } }, async (request) => {
    const result = secondFactor.beginSetup(request.authSession!);
    if (result.kind === "already_enabled") {
      throw alreadyEnabled();
    }
    return result.setup;
  });

  // The first admin also gets the backup passphrase Autoheal made, once, next to the recovery codes.
  app.post(
    API_ROUTES.totpConfirm,
    { config: { access: ACCESS_VERIFIED } },
    async (request, reply): Promise<TotpEnabledView> => {
      const { code } = parseBody(codeBody, request.body);
      const result = secondFactor.confirmSetup(request.authSession!, code, requestContext(request));
      if (result.kind === "already_enabled") {
        throw alreadyEnabled();
      }
      if (result.kind === "not_started") {
        throw new HttpError(HTTP_STATUS.conflict, API_ERRORS.totpSetupNotStarted);
      }
      if (result.kind === "wrong_code") {
        throw wrongCode(result.failure);
      }
      if (result.kind === "session_ended") {
        throw sessionEnded();
      }
      reply.setCookie(SESSION_COOKIE_NAME, result.token, sessionCookie);
      return { ...result.codes, backupPassphrase: passphraseNotice.takeFor(request.authSession!.user.role) };
    },
  );

  const secondFactorRoute = { config: { access: ACCESS_SIGNED_IN, rateLimit: signInRateLimit } } as const;
  app.post(API_ROUTES.secondFactor, secondFactorRoute, async (request, reply) => {
    const { code } = parseBody(codeBody, request.body);
    const result = secondFactor.verify(request.authSession!, code, requestContext(request));
    if (result.kind === "session_ended") {
      throw sessionEnded();
    }
    if (result.kind !== "verified") {
      throw codeRefused(result, reply);
    }
    reply.setCookie(SESSION_COOKIE_NAME, result.token, sessionCookie);
    return reply.code(HTTP_STATUS.noContent).send();
  });
}
