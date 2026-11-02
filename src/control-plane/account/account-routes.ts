import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { API_ERRORS, API_ROUTES } from "../../shared/api.js";
import {
  ACCESS_VERIFIED,
  HTTP_STATUS,
  LOGIN_FIELD_MAXIMUM_LENGTH,
  SESSION_ID_PATTERN,
  USERNAME_PATTERN,
} from "../../shared/constants.js";
import { signInRateLimit } from "../auth/auth-routes.js";
import type { SecondFactorService } from "../auth/second-factor-service.js";
import { codeBody, codeRefused, wrongCode } from "../auth/second-factor-routes.js";
import { HttpError, parseBody } from "../http/errors.js";
import { requestContext } from "../http/request-context.js";
import { boardArrangementSchema, savedViewBodySchema } from "../../shared/view-preferences.js";
import type { AccountService } from "./account-service.js";
import type { ViewPreferencesService } from "./view-preferences.js";

const renameBody = z.object({
  username: z.string().regex(USERNAME_PATTERN),
  currentPassword: z.string().min(1).max(LOGIN_FIELD_MAXIMUM_LENGTH),
});
const savedViewParameters = z.object({ viewId: z.string().min(1) });
const sessionParameters = z.object({ sessionId: z.string().regex(SESSION_ID_PATTERN) });
// Each checks a password or a code: sign-in's tighter limit, so a stolen session buys no fast guessing.
const checked = { config: { rateLimit: signInRateLimit } } as const;

export function registerAccountRoutes(
  app: FastifyInstance,
  account: AccountService,
  secondFactor: SecondFactorService,
  viewPreferences: ViewPreferencesService,
) {
  // Any verified person's own: a viewer's views are as much theirs as an admin's.
  const ownPreferences = { config: { access: ACCESS_VERIFIED } } as const;
  const ownId = (request: FastifyRequest) => request.authSession!.user.id;
  app.get(API_ROUTES.accountViewPreferences, ownPreferences, async (request) => viewPreferences.of(ownId(request)));
  app.post(API_ROUTES.accountSavedViews, ownPreferences, async (request) =>
    viewPreferences.saveView(ownId(request), parseBody(savedViewBodySchema, request.body)),
  );
  app.delete(API_ROUTES.accountSavedView, ownPreferences, async (request) =>
    viewPreferences.removeView(ownId(request), parseBody(savedViewParameters, request.params).viewId),
  );
  app.put(API_ROUTES.accountBoardArrangement, ownPreferences, async (request) =>
    viewPreferences.arrangeBoard(ownId(request), parseBody(boardArrangementSchema, request.body)),
  );
  app.delete(API_ROUTES.accountBoardArrangement, ownPreferences, async (request) =>
    viewPreferences.arrangeBoard(ownId(request), null),
  );

  app.get(API_ROUTES.account, async (request) => account.view(request.authSession!));

  app.patch(API_ROUTES.account, checked, async (request) =>
    account.rename(request.authSession!, parseBody(renameBody, request.body), requestContext(request)),
  );

  app.post(API_ROUTES.accountAuthenticator, checked, async (request, reply) => {
    const { code } = parseBody(codeBody, request.body);
    const result = secondFactor.beginMove(request.authSession!, code, requestContext(request));
    if (result.kind !== "started") {
      throw codeRefused(result, reply);
    }
    return result.setup;
  });

  app.post(API_ROUTES.accountAuthenticatorConfirm, checked, async (request, reply) => {
    const { code } = parseBody(codeBody, request.body);
    const result = secondFactor.confirmMove(request.authSession!, code, requestContext(request));
    if (result.kind === "not_started") {
      throw new HttpError(HTTP_STATUS.conflict, API_ERRORS.totpSetupNotStarted);
    }
    if (result.kind === "wrong_code") {
      throw wrongCode(result.failure);
    }
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.post(API_ROUTES.accountRecoveryCodes, checked, async (request, reply) => {
    const { code } = parseBody(codeBody, request.body);
    const result = secondFactor.renewRecoveryCodes(request.authSession!, code, requestContext(request));
    if (result.kind !== "renewed") {
      throw codeRefused(result, reply);
    }
    return result.codes;
  });

  app.delete(API_ROUTES.accountOtherSessions, async (request, reply) => {
    account.endOtherSessions(request.authSession!, requestContext(request));
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.delete(API_ROUTES.accountSession, async (request, reply) => {
    const { sessionId } = parseBody(sessionParameters, request.params);
    account.endSession(request.authSession!, sessionId, requestContext(request));
    return reply.code(HTTP_STATUS.noContent).send();
  });
}
