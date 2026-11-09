import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import {
  ACCESS_ADMIN,
  IGNORE_EVERY_VERSION,
  IMAGE_TAG_PATTERN,
  HOST_RESTART_CHOICES,
  HOST_UPDATE_CHOICES,
  HTTP_STATUS,
  IMAGE_CLEANUPS,
  REPORT_LIMITS,
  RESTART_CHOICES,
  UPDATE_CHOICES,
} from "../../shared/constants.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { HostControlService } from "./host-control-service.js";

const hostParameters = z.object({ hostId: z.uuid() });
const containerParameters = hostParameters.extend({
  containerName: z.string().min(1).max(REPORT_LIMITS.nameCharacters),
});
const hostControlBody = z
  .object({
    restartDefault: z.enum(HOST_RESTART_CHOICES).optional(),
    updateDefault: z.enum(HOST_UPDATE_CHOICES).optional(),
    imageCleanup: z.enum(IMAGE_CLEANUPS).optional(),
    clearBuildCache: z.boolean().optional(),
    clearLeftNetworks: z.boolean().optional(),
  })
  .refine((change) => Object.values(change).some((value) => value !== undefined));
const containerControlBody = z
  .object({
    names: z.array(z.string().min(1).max(REPORT_LIMITS.nameCharacters)).min(1).max(REPORT_LIMITS.containers),
    restart: z.enum(RESTART_CHOICES).optional(),
    update: z.enum(UPDATE_CHOICES).optional(),
  })
  .refine((change) => change.restart !== undefined || change.update !== undefined);

const ignoredVersionsBody = z.object({
  changes: z
    .array(
      z.object({
        container: z.string().min(1).max(REPORT_LIMITS.nameCharacters),
        version: z.union([z.literal(IGNORE_EVERY_VERSION), z.string().regex(IMAGE_TAG_PATTERN)]).nullable(),
      }),
    )
    .min(1)
    .max(REPORT_LIMITS.containers),
});

export function registerHostControlRoutes(app: FastifyInstance, hostControl: HostControlService) {
  app.get(API_ROUTES.hostControl, async (request) =>
    hostControl.view(parseBody(hostParameters, request.params).hostId),
  );

  app.put(API_ROUTES.hostControl, { config: { access: ACCESS_ADMIN } }, async (request) => {
    const { hostId } = parseBody(hostParameters, request.params);
    return hostControl.save(actorOf(request), hostId, parseBody(hostControlBody, request.body));
  });

  app.put(API_ROUTES.containerControls, { config: { access: ACCESS_ADMIN } }, async (request, reply) => {
    const { hostId } = parseBody(hostParameters, request.params);
    hostControl.setContainers(actorOf(request), hostId, parseBody(containerControlBody, request.body));
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.put(API_ROUTES.hostIgnoredVersions, { config: { access: ACCESS_ADMIN } }, async (request, reply) => {
    const { hostId } = parseBody(hostParameters, request.params);
    hostControl.ignoreVersions(actorOf(request), hostId, parseBody(ignoredVersionsBody, request.body).changes);
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.post(API_ROUTES.restartsReset, { config: { access: ACCESS_ADMIN } }, async (request, reply) => {
    const { hostId, containerName } = parseBody(containerParameters, request.params);
    hostControl.resetRestarts(actorOf(request), hostId, containerName);
    return reply.code(HTTP_STATUS.noContent).send();
  });
}
