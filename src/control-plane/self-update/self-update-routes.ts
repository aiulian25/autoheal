import type { FastifyInstance } from "fastify";
import { API_ROUTES } from "../../shared/api.js";
import { ACCESS_ADMIN } from "../../shared/constants.js";
import { actorOf } from "../http/request-context.js";
import type { SelfUpdateService } from "./self-update-service.js";

const adminOnly = { config: { access: ACCESS_ADMIN } } as const;

export function registerSelfUpdateRoutes(app: FastifyInstance, selfUpdate: SelfUpdateService) {
  app.get(API_ROUTES.selfUpdate, adminOnly, async () => selfUpdate.view());
  app.post(API_ROUTES.selfUpdate, adminOnly, async (request) => selfUpdate.start(actorOf(request)));
}
