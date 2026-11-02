import type { FastifyInstance } from "fastify";
import { API_ERRORS, API_ROUTES } from "../../shared/api.js";
import {
  ACCESS_ADMIN,
  ACCESS_PUBLIC,
  HTTP_STATUS,
  JARVIS_KEY_SCOPE,
  RATE_LIMIT_WINDOW_MILLISECONDS,
  WIDGET_KEY_HEADER,
  WIDGET_KEY_PATTERN,
} from "../../shared/constants.js";
import {
  JARVIS_LIMITS,
  jarvisAliasesSchema,
  jarvisHeardSchema,
  jarvisPauseSchema,
  jarvisSummaryQuerySchema,
} from "../../shared/jarvis.js";
import { HttpError, parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { ControlPlaneServices } from "../services.js";

const JARVIS_RATE_LIMIT = { max: JARVIS_LIMITS.ratePerMinute, timeWindow: RATE_LIMIT_WINDOW_MILLISECONDS };
const machine = { config: { access: ACCESS_PUBLIC, rateLimit: JARVIS_RATE_LIMIT } } as const;
const admin = { config: { access: ACCESS_ADMIN } } as const;
const STATE_OK = "ok";

/** The dashboard's card, and the narrow door Home Assistant comes in by, on its own key and no session. */
export function registerJarvisRoutes(app: FastifyInstance, services: ControlPlaneServices) {
  const jarvis = services.jarvis;
  const requireKey = (sent: unknown) => {
    const valid =
      typeof sent === "string" &&
      WIDGET_KEY_PATTERN.test(sent) &&
      services.widgetKeysService.authenticate(sent, JARVIS_KEY_SCOPE);
    if (!valid) throw new HttpError(HTTP_STATUS.unauthorized, API_ERRORS.notSignedIn);
  };

  app.get(API_ROUTES.jarvis, admin, async () => jarvis.view());
  app.post(API_ROUTES.jarvisConnect, admin, async (request) => jarvis.connect(actorOf(request)));
  app.delete(API_ROUTES.jarvis, admin, async (request, reply) => {
    jarvis.disconnect(actorOf(request));
    return reply.code(HTTP_STATUS.noContent).send();
  });
  app.put(API_ROUTES.jarvisPause, admin, async (request, reply) => {
    jarvis.pause(actorOf(request), parseBody(jarvisPauseSchema, request.body).paused);
    return reply.code(HTTP_STATUS.noContent).send();
  });
  app.put(API_ROUTES.jarvisAliases, admin, async (request, reply) => {
    const { hostId, aliases } = parseBody(jarvisAliasesSchema, request.body);
    jarvis.setAliases(actorOf(request), hostId, aliases);
    return reply.code(HTTP_STATUS.noContent).send();
  });
  app.post(API_ROUTES.jarvisTest, admin, async () => jarvis.startTest());

  app.get(API_ROUTES.jarvisStatus, machine, async (request) => {
    requireKey(request.headers[WIDGET_KEY_HEADER]);
    return { state: STATE_OK };
  });
  app.get(API_ROUTES.jarvisSummary, machine, async (request) => {
    requireKey(request.headers[WIDGET_KEY_HEADER]);
    return jarvis.summary(parseBody(jarvisSummaryQuerySchema, request.query).about ?? "");
  });
  app.get(API_ROUTES.jarvisMessages, machine, async (request) => {
    requireKey(request.headers[WIDGET_KEY_HEADER]);
    return jarvis.recentMessages();
  });
  app.post(API_ROUTES.jarvisHeard, machine, async (request, reply) => {
    requireKey(request.headers[WIDGET_KEY_HEADER]);
    jarvis.heard(parseBody(jarvisHeardSchema, request.body).nonce);
    return reply.code(HTTP_STATUS.noContent).send();
  });
}
