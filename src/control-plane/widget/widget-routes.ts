import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ERRORS, API_ROUTES, hasUpdate, type WidgetView } from "../../shared/api.js";
import {
  ACCESS_ADMIN,
  ACCESS_PUBLIC,
  BEARER_PREFIX,
  CONTAINER_STATE_RUNNING,
  HOST_STATE,
  HTTP_HEADERS,
  HTTP_STATUS,
  INCIDENT_STATUS,
  OPENMETRICS_CONTENT_TYPE,
  RATE_LIMIT_WINDOW_MILLISECONDS,
  WIDGET_KEY_HEADER,
  WIDGET_KEY_NAME_CHARACTERS,
  WIDGET_KEY_PATTERN,
  WIDGET_KEY_SCOPE,
  WIDGET_KEY_SCOPES,
  WIDGET_RATE_LIMIT_PER_MINUTE,
  type WidgetKeyScope,
} from "../../shared/constants.js";
import { HttpError, parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { ControlPlaneServices } from "../services.js";
import { fleetMetrics } from "./fleet-metrics.js";
import { renderOpenMetrics } from "./open-metrics.js";
import type { WidgetKeysService } from "./widget-keys-service.js";

const keyParameters = z.object({ keyId: z.uuid() });
const createBody = z.object({
  name: z.string().trim().min(1).max(WIDGET_KEY_NAME_CHARACTERS),
  scope: z.enum(WIDGET_KEY_SCOPES).default(WIDGET_KEY_SCOPE.widget),
});
const widgetRateLimit = { max: WIDGET_RATE_LIMIT_PER_MINUTE, timeWindow: RATE_LIMIT_WINDOW_MILLISECONDS };

// A key in its form, live, and made for what it is asking for; anything else reads as not signed in.
function requireKey(keys: WidgetKeysService, sent: unknown, scope: WidgetKeyScope) {
  const valid = typeof sent === "string" && WIDGET_KEY_PATTERN.test(sent) && keys.authenticate(sent, scope);
  if (!valid) {
    throw new HttpError(HTTP_STATUS.unauthorized, API_ERRORS.notSignedIn);
  }
}

// Prometheus sends its key as a bearer token.
function bearerOf(header: string | undefined): string | null {
  return header?.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : null;
}

function widgetView(services: ControlPlaneServices): WidgetView {
  const hosts = services.inventoryService.hosts().filter((host) => host.state !== HOST_STATE.revoked);
  const containers = services.inventoryService.containers();
  const tasks = services.tasksService.summary("");
  return {
    hostsOnline: hosts.filter((host) => host.state === HOST_STATE.online).length,
    hostsTotal: hosts.length,
    containersRunning: containers.filter((container) => container.state === CONTAINER_STATE_RUNNING).length,
    containersTotal: containers.length,
    containerProblems: containers.filter((container) => container.problem !== null).length,
    updatesAvailable: containers.filter(hasUpdate).length,
    openTasks: tasks.open,
    urgentTasks: tasks.byPriority.urgent,
    needsYou: services.incidentsService.list({ status: INCIDENT_STATUS.awaitingApproval }).length,
  };
}

/**
 * Keys for Homepage's custom API widget and for Prometheus, and what each reads: the widget's counts, or the metrics.
 * Each sends its key in a header, never a session; the answer is numbers only.
 */
export function registerWidgetRoutes(app: FastifyInstance, services: ControlPlaneServices) {
  const keys = services.widgetKeysService;

  app.get(API_ROUTES.widgetKeys, { config: { access: ACCESS_ADMIN } }, async () => keys.list());

  app.post(API_ROUTES.widgetKeys, { config: { access: ACCESS_ADMIN } }, async (request) => {
    const { name, scope } = parseBody(createBody, request.body);
    return keys.create(actorOf(request), name, scope);
  });

  app.delete(API_ROUTES.widgetKey, { config: { access: ACCESS_ADMIN } }, async (request, reply) => {
    keys.revoke(actorOf(request), parseBody(keyParameters, request.params).keyId);
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.get(API_ROUTES.widget, { config: { access: ACCESS_PUBLIC, rateLimit: widgetRateLimit } }, async (request) => {
    requireKey(keys, request.headers[WIDGET_KEY_HEADER], WIDGET_KEY_SCOPE.widget);
    return widgetView(services);
  });

  app.get(
    API_ROUTES.metrics,
    { config: { access: ACCESS_PUBLIC, rateLimit: widgetRateLimit } },
    async (request, reply) => {
      requireKey(keys, bearerOf(request.headers.authorization), WIDGET_KEY_SCOPE.metrics);
      return reply
        .header(HTTP_HEADERS.contentType, OPENMETRICS_CONTENT_TYPE)
        .send(renderOpenMetrics(fleetMetrics(services)));
    },
  );
}
