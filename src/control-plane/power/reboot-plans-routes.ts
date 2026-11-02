import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ACCESS_ADMIN } from "../../shared/constants.js";
import { REBOOT_PLAN_ROUTES, rebootPlanBodySchema } from "../../shared/reboot-plans.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { ControlPlaneServices } from "../services.js";

const adminOnly = { config: { access: ACCESS_ADMIN } } as const;
const planParameters = z.object({ planId: z.string().min(1) });

export function registerRebootPlanRoutes(app: FastifyInstance, { rebootPlans }: ControlPlaneServices) {
  app.get(REBOOT_PLAN_ROUTES.plans, adminOnly, async () => rebootPlans.list());
  app.post(REBOOT_PLAN_ROUTES.preview, adminOnly, async (request) =>
    rebootPlans.preview(actorOf(request), parseBody(rebootPlanBodySchema, request.body)),
  );
  app.post(REBOOT_PLAN_ROUTES.plans, adminOnly, async (request) =>
    rebootPlans.create(actorOf(request), parseBody(rebootPlanBodySchema, request.body)),
  );
  app.post(REBOOT_PLAN_ROUTES.resume, adminOnly, async (request) =>
    rebootPlans.resume(actorOf(request), parseBody(planParameters, request.params).planId),
  );
  app.post(REBOOT_PLAN_ROUTES.cancel, adminOnly, async (request) =>
    rebootPlans.cancel(actorOf(request), parseBody(planParameters, request.params).planId),
  );
}
