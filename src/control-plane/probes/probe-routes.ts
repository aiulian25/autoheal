import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import { ACCESS_ADMIN, AUDIT_ACTIONS, HTTP_STATUS, TARGET_HOST } from "../../shared/constants.js";
import { probeBodySchema } from "../../shared/probes.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { ControlPlaneServices } from "../services.js";

// What a home runs and where is for admins, as with the network page.
const adminOnly = { config: { access: ACCESS_ADMIN } } as const;
const hostParameters = z.object({ hostId: z.string().min(1) });
const probeParameters = hostParameters.extend({ probeId: z.string().min(1) });

export function registerProbeRoutes(app: FastifyInstance, { probes, auditLog }: ControlPlaneServices) {
  app.get(API_ROUTES.hostProbes, adminOnly, async (request) =>
    probes.ofHost(parseBody(hostParameters, request.params).hostId),
  );
  app.post(API_ROUTES.hostProbes, adminOnly, async (request) => {
    const { hostId } = parseBody(hostParameters, request.params);
    const body = parseBody(probeBodySchema, request.body);
    const id = await probes.create(hostId, body);
    auditLog.recordUserAction(
      actorOf(request),
      AUDIT_ACTIONS.probeCreated,
      { kind: TARGET_HOST, id: hostId },
      {
        probeId: id,
        name: body.name,
        scope: body.scope,
        kind: body.target.kind,
      },
    );
    return { id };
  });
  app.delete(API_ROUTES.hostProbe, adminOnly, async (request, reply) => {
    const { hostId, probeId } = parseBody(probeParameters, request.params);
    probes.remove(hostId, probeId);
    auditLog.recordUserAction(
      actorOf(request),
      AUDIT_ACTIONS.probeRemoved,
      { kind: TARGET_HOST, id: hostId },
      { probeId },
    );
    return reply.status(HTTP_STATUS.noContent).send();
  });
}
