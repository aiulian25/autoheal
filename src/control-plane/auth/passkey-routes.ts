import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ERRORS, API_ROUTES } from "../../shared/api.js";
import {
  ACCESS_PUBLIC,
  AUTHENTICATOR_ATTACHMENTS,
  BASE64URL_PATTERN,
  HTTP_STATUS,
  PASSKEY_FIELD_CHARACTERS,
  PASSKEY_NAME_CHARACTERS,
  PASSKEY_TRANSPORT_CHARACTERS,
  PASSKEY_TRANSPORT_LIMIT,
  PUBLIC_KEY_CREDENTIAL_TYPE,
  SESSION_COOKIE_NAME,
} from "../../shared/constants.js";
import { HttpError, parseBody } from "../http/errors.js";
import { requestContext } from "../http/request-context.js";
import { sessionCookie, signInRateLimit } from "./auth-routes.js";
import type { PasskeyService } from "./passkey-service.js";
import { codeBody, codeRefused } from "./second-factor-routes.js";
import type { SecondFactorService } from "./second-factor-service.js";

// What the browser sends back, as WebAuthn's JSON has it; the library checks every byte of it again.
const base64url = z.string().max(PASSKEY_FIELD_CHARACTERS).regex(BASE64URL_PATTERN);
const credential = {
  id: base64url,
  rawId: base64url,
  type: z.literal(PUBLIC_KEY_CREDENTIAL_TYPE),
  authenticatorAttachment: z.enum(AUTHENTICATOR_ATTACHMENTS).optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()),
};
const signInBody = z.object({
  response: z.object({
    ...credential,
    response: z.object({
      clientDataJSON: base64url,
      authenticatorData: base64url,
      signature: base64url,
      userHandle: base64url.optional(),
    }),
  }),
});
const passkeyName = z.string().trim().min(1).max(PASSKEY_NAME_CHARACTERS);
const enrolBody = z.object({
  response: z.object({
    ...credential,
    response: z.object({
      clientDataJSON: base64url,
      attestationObject: base64url,
      authenticatorData: base64url.optional(),
      transports: z.array(z.string().max(PASSKEY_TRANSPORT_CHARACTERS)).max(PASSKEY_TRANSPORT_LIMIT).optional(),
      publicKeyAlgorithm: z.number().int().optional(),
      publicKey: base64url.optional(),
    }),
  }),
  // The browser's own guess ("Chrome on Linux"), for a passkey whose password manager doesn't say its name.
  name: passkeyName.optional(),
});
const renameBody = z.object({ name: passkeyName });
const passkeyParameters = z.object({ passkeyId: z.uuid() });
// Each signs in, or checks a code: sign-in's tighter limit.
const signInRoute = { config: { access: ACCESS_PUBLIC, rateLimit: signInRateLimit } } as const;
const checked = { config: { rateLimit: signInRateLimit } } as const;

export function registerPasskeyRoutes(
  app: FastifyInstance,
  passkeys: PasskeyService,
  secondFactor: SecondFactorService,
) {
  app.get(API_ROUTES.passkeyStatus, { config: { access: ACCESS_PUBLIC } }, async () => passkeys.status());

  app.post(API_ROUTES.passkeySignInOptions, signInRoute, async (request) =>
    passkeys.signInOptions(requestContext(request)),
  );

  app.post(API_ROUTES.passkeySignIn, signInRoute, async (request, reply) => {
    const { response } = parseBody(signInBody, request.body);
    const result = await passkeys.signIn(response as AuthenticationResponseJSON, requestContext(request));
    if (result.kind === "refused") {
      throw new HttpError(HTTP_STATUS.unauthorized, API_ERRORS.passkeyRefused);
    }
    reply.setCookie(SESSION_COOKIE_NAME, result.token, sessionCookie);
    return result.session;
  });

  app.get(API_ROUTES.accountPasskeys, async (request) => passkeys.list(request.authSession!));

  // A current code first, as moving the authenticator asks: a session left open can't plant a passkey.
  app.post(API_ROUTES.accountPasskeyOptions, checked, async (request, reply) => {
    const { code } = parseBody(codeBody, request.body);
    const check = secondFactor.checkCurrentCode(request.authSession!, code, requestContext(request));
    if (check.kind !== "verified") {
      throw codeRefused(check, reply);
    }
    return passkeys.enrolmentOptions(request.authSession!, requestContext(request));
  });

  app.post(API_ROUTES.accountPasskeys, async (request) => {
    const { response, name } = parseBody(enrolBody, request.body);
    return passkeys.enrol(request.authSession!, response as RegistrationResponseJSON, name, requestContext(request));
  });

  app.patch(API_ROUTES.accountPasskey, async (request) => {
    const { passkeyId } = parseBody(passkeyParameters, request.params);
    const { name } = parseBody(renameBody, request.body);
    return passkeys.rename(request.authSession!, passkeyId, name, requestContext(request));
  });

  app.delete(API_ROUTES.accountPasskey, async (request, reply) => {
    const { passkeyId } = parseBody(passkeyParameters, request.params);
    passkeys.remove(request.authSession!, passkeyId, requestContext(request));
    return reply.code(HTTP_STATUS.noContent).send();
  });
}
