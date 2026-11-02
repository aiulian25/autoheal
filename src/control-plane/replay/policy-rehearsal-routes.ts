import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import { ACCESS_ADMIN } from "../../shared/constants.js";
import { policyRehearsalRequestSchema } from "../../shared/recovery-policy-simulator.js";
import { parseBody } from "../http/errors.js";
import type { PolicyRehearsalService } from "./policy-rehearsal-service.js";
export function registerPolicyRehearsalRoutes(app: FastifyInstance, rehearsal: PolicyRehearsalService) {
  app.get(API_ROUTES.policyRehearsalContext, async (request) =>
    rehearsal.context(parseBody(z.object({ hostId: z.uuid() }), request.params).hostId),
  );
  app.post(API_ROUTES.policyRehearsal, { config: { access: ACCESS_ADMIN } }, async (request) =>
    rehearsal.rehearse(parseBody(policyRehearsalRequestSchema, request.body)),
  );
}
