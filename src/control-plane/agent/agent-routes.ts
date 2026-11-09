import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import {
  ACCESS_ADMIN,
  AGENT_DISPATCH_LIMIT,
  HOST_PACKAGE_LIMIT,
  IMAGE_TAG_PATTERN,
  REPORT_LIMITS,
} from "../../shared/constants.js";
import { packageNameSchema } from "../../shared/protocol.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { DispatchService } from "./dispatch-service.js";

const dispatchBody = z
  .object({
    updates: z.array(z.uuid()).max(AGENT_DISPATCH_LIMIT).default([]),
    packages: z
      .array(
        z.object({
          hostId: z.uuid(),
          names: z.array(packageNameSchema).min(1).max(HOST_PACKAGE_LIMIT),
        }),
      )
      .max(AGENT_DISPATCH_LIMIT)
      .default([]),
    incidents: z.array(z.uuid()).max(AGENT_DISPATCH_LIMIT).default([]),
    tags: z
      .array(
        z.object({
          hostId: z.uuid(),
          container: z.string().min(1).max(REPORT_LIMITS.nameCharacters),
          tag: z.string().regex(IMAGE_TAG_PATTERN),
        }),
      )
      .max(AGENT_DISPATCH_LIMIT)
      .default([]),
  })
  .refine(
    ({ updates, packages, incidents, tags }) => updates.length + packages.length + incidents.length + tags.length > 0,
  );

export function registerAgentRoutes(app: FastifyInstance, dispatch: DispatchService) {
  app.post(API_ROUTES.agentDispatch, { config: { access: ACCESS_ADMIN } }, async (request) =>
    dispatch.dispatch(actorOf(request), parseBody(dispatchBody, request.body)),
  );
}
