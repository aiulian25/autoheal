import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import { ACCESS_ADMIN } from "../../shared/constants.js";
import { anomalyFeedbackSchema } from "../../shared/metric-trends.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { MetricRollups } from "./metric-rollups.js";
const hostParams = z.object({ hostId: z.uuid() });
const containerParams = hostParams.extend({ containerName: z.string().min(1).max(255) });
export function registerMetricTrendRoutes(app: FastifyInstance, rollups: MetricRollups) {
  app.get(API_ROUTES.hostTrends, async (request) => rollups.trends(parseBody(hostParams, request.params).hostId));
  app.get(API_ROUTES.containerTrends, async (request) => {
    const { hostId, containerName } = parseBody(containerParams, request.params);
    return rollups.trends(hostId, containerName);
  });
  app.get(API_ROUTES.metricAnomalies, async (request) => {
    const { hostId, containerName } = parseBody(
      hostParams.extend({ containerName: z.string().min(1).max(255).optional() }).strict(),
      request.query,
    );
    return rollups.anomalies(hostId, containerName ?? null);
  });
  app.post(API_ROUTES.metricAnomalyFeedback, { config: { access: ACCESS_ADMIN } }, async (request) =>
    rollups.feedback(
      actorOf(request),
      parseBody(z.object({ anomalyId: z.uuid() }), request.params).anomalyId,
      parseBody(anomalyFeedbackSchema, request.body),
    ),
  );
}
