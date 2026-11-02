import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES, AUDIT_QUERY } from "../../shared/api.js";
import { ACCESS_ADMIN, AUDIT_LIST_LIMIT } from "../../shared/constants.js";
import { parseBody } from "../http/errors.js";
import type { AuditLog } from "./audit-log.js";

const listQuery = z
  .object({
    [AUDIT_QUERY.limit]: z.coerce.number().int().min(1).max(AUDIT_LIST_LIMIT).optional(),
    [AUDIT_QUERY.before]: z.coerce.number().int().positive().optional(),
    [AUDIT_QUERY.beforeId]: z.uuid().optional(),
  })
  .refine((query) => (query.before === undefined) === (query.beforeId === undefined));

export function registerAuditRoutes(app: FastifyInstance, auditLog: AuditLog) {
  app.get(API_ROUTES.audit, { config: { access: ACCESS_ADMIN } }, async (request) => {
    const { limit, before, beforeId } = parseBody(listQuery, request.query);
    const cursor = before === undefined || beforeId === undefined ? undefined : { occurredAt: before, id: beforeId };
    return auditLog.recent(limit, cursor);
  });
}
