import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import { availabilityGroupBodySchema } from "../../shared/availability-groups.js";
import { ACCESS_ADMIN, HTTP_STATUS } from "../../shared/constants.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { ControlPlaneServices } from "../services.js";

const adminOnly = { config: { access: ACCESS_ADMIN } } as const;
const groupParameters = z.object({ groupId: z.uuid() });

/**
 * Which replicas of an application must keep serving. Anyone signed in may read them, as they explain why an
 * operation was refused; only an admin may change what the fleet is allowed to do.
 */
export function registerAvailabilityGroupRoutes(app: FastifyInstance, services: ControlPlaneServices) {
  const { availabilityGroups } = services;

  app.get(API_ROUTES.availabilityGroups, async () => availabilityGroups.views());

  app.post(API_ROUTES.availabilityGroups, adminOnly, async (request) =>
    availabilityGroups.add(actorOf(request), parseBody(availabilityGroupBodySchema, request.body)),
  );

  app.put(API_ROUTES.availabilityGroup, adminOnly, async (request, reply) => {
    const { groupId } = parseBody(groupParameters, request.params);
    availabilityGroups.change(actorOf(request), groupId, parseBody(availabilityGroupBodySchema, request.body));
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.delete(API_ROUTES.availabilityGroup, adminOnly, async (request, reply) => {
    const { groupId } = parseBody(groupParameters, request.params);
    availabilityGroups.remove(actorOf(request), groupId);
    return reply.code(HTTP_STATUS.noContent).send();
  });
}
