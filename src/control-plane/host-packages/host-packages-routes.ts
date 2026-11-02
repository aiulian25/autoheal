import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import { ACCESS_ADMIN } from "../../shared/constants.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import { hostUpdateSettingsSchema, type HostPackagesService } from "./host-packages-service.js";

const hostParameters = z.object({ hostId: z.uuid() });

export function registerHostPackagesRoutes(app: FastifyInstance, hostPackages: HostPackagesService) {
  app.get(API_ROUTES.hostPackages, async (request) =>
    hostPackages.view(parseBody(hostParameters, request.params).hostId),
  );

  app.get(API_ROUTES.hostUpdateSettings, async () => hostPackages.settings());

  app.put(API_ROUTES.hostUpdateSettings, { config: { access: ACCESS_ADMIN } }, async (request) =>
    hostPackages.saveSettings(actorOf(request), parseBody(hostUpdateSettingsSchema, request.body)),
  );
}
