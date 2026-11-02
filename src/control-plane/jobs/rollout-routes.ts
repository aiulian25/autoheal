import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ACCESS_ADMIN } from "../../shared/constants.js";
import { ROLLOUT_ROUTES, rolloutCreateSchema } from "../../shared/rollouts.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { RolloutService } from "./rollout-service.js";
export function registerRolloutRoutes(app: FastifyInstance, service: RolloutService) {
  const admin = { config: { access: ACCESS_ADMIN } } as const;
  const id = (params: unknown) => parseBody(z.object({ rolloutId: z.uuid() }), params).rolloutId;
  app.get(ROLLOUT_ROUTES.rollouts, admin, async () => {
    service.tick();
    return service.list();
  });
  app.post(ROLLOUT_ROUTES.rollouts, admin, async (request) =>
    service.create(actorOf(request), request.authSession!.tokenHash, parseBody(rolloutCreateSchema, request.body)),
  );
  app.post(ROLLOUT_ROUTES.rolloutHold, admin, async (request) => service.hold(actorOf(request), id(request.params)));
  app.post(ROLLOUT_ROUTES.rolloutPromote, admin, async (request) =>
    service.promote(
      actorOf(request),
      id(request.params),
      parseBody(z.object({ serviceVerified: z.boolean() }).strict(), request.body).serviceVerified,
    ),
  );
}
