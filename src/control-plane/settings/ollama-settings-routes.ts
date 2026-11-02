import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import {
  ACCESS_ADMIN,
  HTTP_STATUS,
  INTEGRATION_URL_MAXIMUM_LENGTH,
  MINIMUM_OLLAMA_CONTEXT_TOKENS,
  OLLAMA_MAXIMUM_CONTEXT_TOKENS,
  OLLAMA_MODEL_NAME_LIMIT,
  OLLAMA_SERVER_HOSTS_LIMIT,
  OLLAMA_SERVER_NAME_LIMIT,
  SERVICE_PROTOCOL_PATTERN,
} from "../../shared/constants.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { ControlPlaneServices } from "../services.js";

const adminOnly = { config: { access: ACCESS_ADMIN } } as const;
// http is accepted, as in the .env: the dashboard says what it exposes.
const ollamaBody = z.object({
  url: z.url({ protocol: SERVICE_PROTOCOL_PATTERN }).max(INTEGRATION_URL_MAXIMUM_LENGTH),
  model: z.string().trim().min(1).max(OLLAMA_MODEL_NAME_LIMIT),
  contextTokens: z.number().int().min(MINIMUM_OLLAMA_CONTEXT_TOKENS).max(OLLAMA_MAXIMUM_CONTEXT_TOKENS),
});

const ollamaAddressBody = ollamaBody.pick({ url: true });

const serverBody = ollamaBody.extend({ name: z.string().trim().min(1).max(OLLAMA_SERVER_NAME_LIMIT) });
const serverParameters = z.object({ serverId: z.uuid() });
const hostsBody = z.object({ hostIds: z.array(z.uuid()).max(OLLAMA_SERVER_HOSTS_LIMIT) });
const defaultNameBody = z.object({ name: z.string().trim().max(OLLAMA_SERVER_NAME_LIMIT) });
const reviewBody = z.object({ serverId: z.uuid().nullable() });

export function registerOllamaSettingsRoutes(app: FastifyInstance, services: ControlPlaneServices) {
  const { ollamaSettings, ollamaServers, ollamaPool } = services;

  app.get(API_ROUTES.ollamaServers, async () => ollamaPool.view());

  app.post(API_ROUTES.ollamaServers, adminOnly, async (request) => ({
    id: await ollamaServers.add(actorOf(request), parseBody(serverBody, request.body)),
  }));

  app.put(API_ROUTES.ollamaServer, adminOnly, async (request, reply) => {
    const { serverId } = parseBody(serverParameters, request.params);
    await ollamaServers.change(actorOf(request), serverId, parseBody(serverBody, request.body));
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.delete(API_ROUTES.ollamaServer, adminOnly, async (request, reply) => {
    const { serverId } = parseBody(serverParameters, request.params);
    ollamaServers.remove(actorOf(request), serverId);
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.put(API_ROUTES.ollamaServerHosts, adminOnly, async (request, reply) => {
    const { serverId } = parseBody(serverParameters, request.params);
    ollamaServers.assign(actorOf(request), serverId, parseBody(hostsBody, request.body).hostIds);
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.put(API_ROUTES.ollamaDefaultName, adminOnly, async (request, reply) => {
    ollamaServers.nameDefault(actorOf(request), parseBody(defaultNameBody, request.body).name);
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.put(API_ROUTES.ollamaRouterServer, adminOnly, async (request, reply) => {
    ollamaServers.chooseRouterServer(actorOf(request), parseBody(reviewBody, request.body).serverId);
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.put(API_ROUTES.ollamaReviewServer, adminOnly, async (request, reply) => {
    ollamaServers.chooseReviewServer(actorOf(request), parseBody(reviewBody, request.body).serverId);
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.get(API_ROUTES.ollamaSettings, async () => ollamaSettings.view());

  app.post(API_ROUTES.ollamaSettingsModels, adminOnly, async (request) =>
    ollamaSettings.modelsAt(parseBody(ollamaAddressBody, request.body).url),
  );

  app.put(API_ROUTES.ollamaSettings, adminOnly, async (request, reply) => {
    await ollamaSettings.save(actorOf(request), parseBody(ollamaBody, request.body));
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.delete(API_ROUTES.ollamaSettings, adminOnly, async (request, reply) => {
    ollamaSettings.remove(actorOf(request));
    return reply.code(HTTP_STATUS.noContent).send();
  });
}
