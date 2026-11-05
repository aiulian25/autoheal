import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import { ACCESS_ADMIN, HTTP_STATUS } from "../../shared/constants.js";
import { registryCredentialBodySchema, registryCredentialTestBodySchema } from "../../shared/registry-credentials.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { ControlPlaneServices } from "../services.js";

const adminOnly = { config: { access: ACCESS_ADMIN } } as const;
const credentialParameters = z.object({ credentialId: z.uuid() });

/** Private registry credentials: admins only, since whoever can change one can give a host an image to run. */
export function registerRegistryCredentialRoutes(app: FastifyInstance, services: ControlPlaneServices) {
  const { registryCredentials } = services;

  app.get(API_ROUTES.registryCredentials, adminOnly, async () => registryCredentials.views());

  app.post(API_ROUTES.registryCredentials, adminOnly, async (request) =>
    registryCredentials.add(actorOf(request), parseBody(registryCredentialBodySchema, request.body)),
  );

  app.put(API_ROUTES.registryCredential, adminOnly, async (request, reply) => {
    const { credentialId } = parseBody(credentialParameters, request.params);
    registryCredentials.change(actorOf(request), credentialId, parseBody(registryCredentialBodySchema, request.body));
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.delete(API_ROUTES.registryCredential, adminOnly, async (request, reply) => {
    const { credentialId } = parseBody(credentialParameters, request.params);
    registryCredentials.remove(actorOf(request), credentialId);
    return reply.code(HTTP_STATUS.noContent).send();
  });

  // One registry call, because a person asked for it.
  app.post(API_ROUTES.registryCredentialTest, adminOnly, async (request) => {
    const { credentialId } = parseBody(credentialParameters, request.params);
    const { repository } = parseBody(registryCredentialTestBodySchema, request.body ?? {});
    return registryCredentials.test(actorOf(request), credentialId, repository);
  });
}
