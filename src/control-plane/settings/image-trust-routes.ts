import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import { ACCESS_ADMIN, HTTP_STATUS, IMAGE_PROVENANCE } from "../../shared/constants.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { ControlPlaneServices } from "../services.js";
import { publisherBodySchema, trustRuleBodySchema } from "./image-trust-service.js";

const adminOnly = { config: { access: ACCESS_ADMIN } } as const;
const publisherParameters = z.object({ name: z.string().min(1).max(IMAGE_PROVENANCE.publisherNameLength) });
const ruleParameters = z.object({ ruleId: z.uuid() });

/** Trusted publishers and where a signed image is required: admins only, as the update rules themselves are. */
export function registerImageTrustRoutes(app: FastifyInstance, services: ControlPlaneServices) {
  const { imageTrust } = services;

  app.get(API_ROUTES.imageTrust, adminOnly, async () => imageTrust.view());

  app.post(API_ROUTES.imageTrust, adminOnly, async (request, reply) => {
    imageTrust.addPublisher(actorOf(request), parseBody(publisherBodySchema, request.body));
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.delete(API_ROUTES.imageTrustPublisher, adminOnly, async (request, reply) => {
    imageTrust.removePublisher(actorOf(request), parseBody(publisherParameters, request.params).name);
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.post(API_ROUTES.imageTrustRules, adminOnly, async (request) =>
    imageTrust.addRule(actorOf(request), parseBody(trustRuleBodySchema, request.body)),
  );

  app.delete(API_ROUTES.imageTrustRule, adminOnly, async (request, reply) => {
    imageTrust.removeRule(actorOf(request), parseBody(ruleParameters, request.params).ruleId);
    return reply.code(HTTP_STATUS.noContent).send();
  });
}
