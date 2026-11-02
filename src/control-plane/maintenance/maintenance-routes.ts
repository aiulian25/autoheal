import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import { ACCESS_ADMIN } from "../../shared/constants.js";
import { MAINTENANCE_LIMITS } from "../../shared/maintenance.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { MaintenanceService } from "./maintenance-service.js";
const host = z.object({ hostId: z.uuid() });
const item = host.extend({ maintenanceId: z.uuid() });
const expiry = z.number().int().nonnegative().safe();
export function registerMaintenanceRoutes(app: FastifyInstance, service: MaintenanceService) {
  app.get(API_ROUTES.maintenance, async () => service.view());
  app.get(API_ROUTES.hostMaintenance, async (request) => service.view(parseBody(host, request.params).hostId));
  app.post(API_ROUTES.hostMaintenance, { config: { access: ACCESS_ADMIN } }, async (request) =>
    service.create(
      actorOf(request),
      parseBody(host, request.params).hostId,
      parseBody(
        z
          .object({
            containerName: z.string().trim().min(1).max(MAINTENANCE_LIMITS.containerNameCharacters).nullable(),
            reason: z.string().trim().min(1).max(MAINTENANCE_LIMITS.reasonCharacters),
            expiresAt: expiry,
          })
          .strict(),
        request.body,
      ),
    ),
  );
  app.patch(API_ROUTES.maintenanceWindow, { config: { access: ACCESS_ADMIN } }, async (request) => {
    const { hostId, maintenanceId } = parseBody(item, request.params);
    return service.change(
      actorOf(request),
      hostId,
      maintenanceId,
      parseBody(z.object({ expiresAt: expiry }).strict(), request.body).expiresAt,
    );
  });
  app.delete(API_ROUTES.maintenanceWindow, { config: { access: ACCESS_ADMIN } }, async (request) => {
    const { hostId, maintenanceId } = parseBody(item, request.params);
    return service.change(actorOf(request), hostId, maintenanceId, null);
  });
}
