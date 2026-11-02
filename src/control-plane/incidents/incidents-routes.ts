import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES, INCIDENT_QUERY } from "../../shared/api.js";
import { INCIDENT_LIST_LIMIT, INCIDENT_STATUSES, REPORT_LIMITS, type IncidentStatus } from "../../shared/constants.js";
import { parseBody } from "../http/errors.js";
import type { IncidentsService } from "./incidents-service.js";

const listQuery = z.object({
  [INCIDENT_QUERY.hostId]: z.uuid().optional(),
  [INCIDENT_QUERY.containerName]: z.string().min(1).max(REPORT_LIMITS.nameCharacters).optional(),
  [INCIDENT_QUERY.status]: z.enum(INCIDENT_STATUSES as [IncidentStatus, ...IncidentStatus[]]).optional(),
  [INCIDENT_QUERY.limit]: z.coerce.number().int().min(1).max(INCIDENT_LIST_LIMIT).optional(),
});
const incidentParameters = z.object({ incidentId: z.uuid() });

export function registerIncidentsRoutes(app: FastifyInstance, incidentsService: IncidentsService) {
  app.get(API_ROUTES.incidents, async (request) => incidentsService.list(parseBody(listQuery, request.query)));

  app.get(API_ROUTES.incident, async (request) =>
    incidentsService.detail(parseBody(incidentParameters, request.params).incidentId),
  );
}
