import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import { ACCESS_ADMIN, HTTP_STATUS } from "../../shared/constants.js";
import { notificationRoutingSchema } from "../../shared/notification-deliveries.js";
import { actorOf } from "../http/request-context.js";
import { parseBody } from "../http/errors.js";
import type { DeliveryService } from "./delivery-service.js";
const adminOnly = { config: { access: ACCESS_ADMIN } } as const;
export function registerNotificationDeliveryRoutes(app: FastifyInstance, deliveries: DeliveryService) {
  app.get(API_ROUTES.notificationDeliveries, async (request) =>
    deliveries.list(
      parseBody(
        z.object({ incidentId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).optional() }),
        request.query,
      ),
    ),
  );
  app.get(API_ROUTES.notificationRouting, async () => deliveries.rules());
  app.put(API_ROUTES.notificationRouting, adminOnly, async (request) =>
    deliveries.saveRules(actorOf(request), parseBody(notificationRoutingSchema, request.body)),
  );
  app.post(API_ROUTES.notificationAcknowledge, adminOnly, async (request, reply) => {
    deliveries.acknowledge(actorOf(request), parseBody(z.object({ eventId: z.uuid() }), request.params).eventId);
    return reply.code(HTTP_STATUS.noContent).send();
  });
  app.post(API_ROUTES.notificationRouteUnsent, adminOnly, async (request, reply) => {
    deliveries.routeUnsent(actorOf(request), parseBody(z.object({ eventId: z.uuid() }), request.params).eventId);
    return reply.code(HTTP_STATUS.noContent).send();
  });
  app.post(API_ROUTES.notificationRetry, adminOnly, async (request, reply) => {
    deliveries.retry(actorOf(request), parseBody(z.object({ deliveryId: z.uuid() }), request.params).deliveryId);
    return reply.code(HTTP_STATUS.noContent).send();
  });
}
