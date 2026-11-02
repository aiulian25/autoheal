import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import { HTTP_HEADERS, NO_STORE, REPORT_LIMITS } from "../../shared/constants.js";
import { previewActionSchema } from "../../shared/topology.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { TopologyService } from "./topology-service.js";
const host = z.object({ hostId: z.uuid() });
const target = host.extend({ containerName: z.string().min(1).max(REPORT_LIMITS.nameCharacters) });
export function registerTopologyRoutes(app: FastifyInstance, service: TopologyService) {
  app.get(API_ROUTES.topology, async (request, reply) => {
    reply.header(HTTP_HEADERS.cacheControl, NO_STORE);
    return service.view(parseBody(host, request.params).hostId);
  });
  app.post(API_ROUTES.operationPreview, async (request, reply) => {
    reply.header(HTTP_HEADERS.cacheControl, NO_STORE);
    const { hostId, containerName } = parseBody(target, request.params);
    return service.preview(
      actorOf(request),
      request.authSession!.tokenHash,
      hostId,
      containerName,
      parseBody(z.object({ action: previewActionSchema }).strict(), request.body).action,
    );
  });
}
