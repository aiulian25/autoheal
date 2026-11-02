import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import { ACCESS_ADMIN, APPROVAL_CHOICES, APPROVAL_NOTE_LIMIT, REPORT_LIMITS } from "../../shared/constants.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { ApprovalsService } from "./approvals-service.js";

const incidentParameters = z.object({ incidentId: z.uuid() });
const approvalBody = z.object({
  choice: z.enum(APPROVAL_CHOICES),
  target: z.string().min(1).max(REPORT_LIMITS.nameCharacters).optional(),
  note: z.string().max(APPROVAL_NOTE_LIMIT).optional(),
});

export function registerApprovalsRoutes(app: FastifyInstance, approvalsService: ApprovalsService) {
  app.post(API_ROUTES.incidentApproval, { config: { access: ACCESS_ADMIN } }, async (request) => {
    const { incidentId } = parseBody(incidentParameters, request.params);
    return approvalsService.decide(actorOf(request), incidentId, parseBody(approvalBody, request.body));
  });
}
