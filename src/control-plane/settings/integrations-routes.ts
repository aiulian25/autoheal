import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ERRORS, API_ROUTES, type IntegrationTestView } from "../../shared/api.js";
import {
  ACCESS_ADMIN,
  HTTP_STATUS,
  INTEGRATION_KIND,
  INTEGRATION_KINDS,
  INTEGRATION_TOKEN_MAXIMUM_LENGTH,
  INTEGRATION_URL_MAXIMUM_LENGTH,
  NOTIFICATION_KINDS,
  NTFY_TOPIC_PATTERN,
  SERVICE_PROTOCOL_PATTERN,
  WEBHOOK_FORMATS,
  type IntegrationKind,
} from "../../shared/constants.js";
import { DomainError } from "../domain-error.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { ControlPlaneServices } from "../services.js";
import type { IntegrationRequest } from "./integrations-service.js";

const adminOnly = { config: { access: ACCESS_ADMIN } } as const;
const kindParameters = z.object({ kind: z.enum(INTEGRATION_KINDS) });
const notificationParameters = z.object({ kind: z.enum(NOTIFICATION_KINDS) });
// http is accepted, as in the .env: the dashboard says what it exposes.
const integrationBody = z.object({
  url: z.url({ protocol: SERVICE_PROTOCOL_PATTERN }).max(INTEGRATION_URL_MAXIMUM_LENGTH),
  topic: z.string().regex(NTFY_TOPIC_PATTERN).optional(),
  token: z.string().trim().min(1).max(INTEGRATION_TOKEN_MAXIMUM_LENGTH).optional(),
});
// ntfy needs its topic and a webhook its format; the others have neither.
const plainBody = integrationBody.omit({ topic: true });
const BODIES: Record<IntegrationKind, z.ZodType<IntegrationRequest>> = {
  [INTEGRATION_KIND.gotify]: plainBody,
  [INTEGRATION_KIND.ntfy]: integrationBody.extend({ topic: z.string().regex(NTFY_TOPIC_PATTERN) }),
  [INTEGRATION_KIND.webhook]: plainBody.extend({ format: z.enum(WEBHOOK_FORMATS) }),
  [INTEGRATION_KIND.homeAssistant]: plainBody,
};

export function registerIntegrationsRoutes(app: FastifyInstance, services: ControlPlaneServices) {
  const { integrationsService, notifier } = services;

  // Where each one points and whether a token is set; tokens themselves never come back.
  app.get(API_ROUTES.integrations, async () =>
    integrationsService
      .views()
      .map((view) =>
        view.kind === INTEGRATION_KIND.homeAssistant || view.source === null
          ? view
          : { ...view, delivery: notifier.delivery(view.kind) },
      ),
  );

  app.put(API_ROUTES.integration, adminOnly, async (request, reply) => {
    const { kind } = parseBody(kindParameters, request.params);
    integrationsService.save(actorOf(request), kind, parseBody(BODIES[kind], request.body));
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.delete(API_ROUTES.integration, adminOnly, async (request, reply) => {
    integrationsService.remove(actorOf(request), parseBody(kindParameters, request.params).kind);
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.post(API_ROUTES.integrationTest, adminOnly, async (request): Promise<IntegrationTestView> => {
    const { kind } = parseBody(notificationParameters, request.params);
    if (!integrationsService.isSet(kind)) {
      throw new DomainError(API_ERRORS.integrationNotSet);
    }
    const problem = await notifier.test(kind);
    return { problem, delivery: notifier.delivery(kind) };
  });
}
