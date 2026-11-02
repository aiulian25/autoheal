import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES, CONTAINER_QUERY } from "../../shared/api.js";
import { ACCESS_ADMIN, HOST_CHANGE_LIST, REPORT_LIMITS, SEARCH_TEXT_LIMIT } from "../../shared/constants.js";
import { parseBody } from "../http/errors.js";
import type { ControlPlaneServices } from "../services.js";

const containersQuery = z.object({
  [CONTAINER_QUERY.hostId]: z.uuid().optional(),
  [CONTAINER_QUERY.problemsOnly]: z.stringbool().optional(),
  [CONTAINER_QUERY.search]: z
    .string()
    .trim()
    .max(SEARCH_TEXT_LIMIT)
    .transform((text) => text || undefined)
    .optional(),
});

const hostParameters = z.object({ hostId: z.uuid() });
const changesQuery = z.object({
  containerName: z.string().min(1).max(REPORT_LIMITS.nameCharacters).optional(),
  limit: z.coerce.number().int().min(1).max(HOST_CHANGE_LIST.most).default(HOST_CHANGE_LIST.default),
});
const containerParameters = hostParameters.extend({
  containerName: z.string().min(1).max(REPORT_LIMITS.nameCharacters),
});

const homeReviewFixBody = z.object({ id: z.string().regex(/^[0-9a-f]{1,64}$/) });
const homeReviewRoomBody = z.object({ areaId: z.string().min(1).max(256) });

export function registerInventoryRoutes(app: FastifyInstance, services: ControlPlaneServices) {
  const { inventoryService, metricsStore, tasksService, ollamaMonitor, containerTimeline, resourceAdvisor } = services;
  app.get(API_ROUTES.hosts, async () => inventoryService.hosts());

  app.get(API_ROUTES.containers, async (request) =>
    inventoryService.containers(parseBody(containersQuery, request.query)),
  );

  // ponytail: the whole half hour on every poll (about 100 kB); ask for what is new since a time
  // if hosts or dashboards multiply.
  app.get(API_ROUTES.hostMetrics, async (request) =>
    metricsStore.hostHistory(parseBody(hostParameters, request.params).hostId),
  );

  app.get(API_ROUTES.hostVolumes, async (request) =>
    inventoryService.hostVolumes(parseBody(hostParameters, request.params).hostId),
  );

  app.get(API_ROUTES.hostNetworks, async (request) =>
    inventoryService.hostNetworks(parseBody(hostParameters, request.params).hostId),
  );

  app.get(API_ROUTES.hostImages, async (request) =>
    inventoryService.hostImages(parseBody(hostParameters, request.params).hostId),
  );

  app.get(API_ROUTES.hostChanges, async (request) =>
    inventoryService.changes(parseBody(hostParameters, request.params).hostId, parseBody(changesQuery, request.query)),
  );

  app.get(API_ROUTES.containerMetrics, async (request) => {
    const { hostId, containerName } = parseBody(containerParameters, request.params);
    return metricsStore.containerHistory(hostId, containerName);
  });

  app.get(API_ROUTES.containerTimeline, async (request) => {
    const { hostId, containerName } = parseBody(containerParameters, request.params);
    return containerTimeline.of(hostId, containerName);
  });

  app.get(API_ROUTES.containerResourceAdvice, async (request) => {
    const { hostId, containerName } = parseBody(containerParameters, request.params);
    return resourceAdvisor.advice(hostId, containerName);
  });

  app.get(API_ROUTES.homeAssistant, async () => inventoryService.homeAssistant());

  // A home's configuration, and what the model says of it, are for admins.
  const adminOnly = { config: { access: ACCESS_ADMIN } } as const;
  app.get(API_ROUTES.homeReview, adminOnly, async () => services.homeReview.view());
  app.post(API_ROUTES.homeReviewRescan, adminOnly, async () => services.homeReview.rescan());
  app.post(API_ROUTES.homeReviewFix, adminOnly, async (request) => ({
    started: await services.homeReview.suggestFix(parseBody(homeReviewFixBody, request.body).id),
  }));
  app.post(API_ROUTES.homeReviewRoom, adminOnly, async (request) => ({
    started: services.homeReview.suggestForRoom(parseBody(homeReviewRoomBody, request.body).areaId),
  }));

  app.get(API_ROUTES.overview, async (request) => ({
    ...inventoryService.overview(),
    tasks: tasksService.summary(request.authSession!.user.id),
  }));

  app.get(API_ROUTES.ollama, async () => ollamaMonitor.status());
}
