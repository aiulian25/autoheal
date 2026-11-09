import { registerRestoreMaintenance } from "../http/restore-maintenance.js";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { API_ERRORS } from "../../shared/api.js";
import {
  RUNNER_BODY_LIMIT_BYTES,
  RUNNER_RATE_LIMIT_PER_MINUTE,
  RUNNER_RATE_LIMIT_HOST_KEY,
  BEARER_PREFIX,
  HTTP_HEADERS,
  HTTP_STATUS,
  RATE_LIMIT_WINDOW_MILLISECONDS,
} from "../../shared/constants.js";
import type { HostRow } from "../hosts/hosts-service.js";
import { registerErrorHandling } from "../http/errors.js";
import { createServer, type TlsMaterial } from "../http/fastify.js";
import type { ControlPlaneServices } from "../services.js";
import { RUNNER_ROUTES } from "../../shared/protocol.js";
import { registerRunnerRoutes } from "./runner-routes.js";

declare module "fastify" {
  interface FastifyRequest {
    runnerHost: HostRow | null;
  }
}

/**
 * The runners' API: its own LAN-only HTTPS port with bearer tokens, not reachable through the
 * internet-facing proxy. No cookies, no browser, so none of the dashboard's CSRF machinery.
 */
export async function buildRunnerServer(tls: TlsMaterial | null, services: ControlPlaneServices) {
  const app: FastifyInstance = createServer({ tls, isTrustedProxy: null, bodyLimit: RUNNER_BODY_LIMIT_BYTES });
  registerErrorHandling(app);
  registerRestoreMaintenance(app, services.databaseHandle.restore);
  const hostOf = (request: FastifyRequest) => {
    const header = request.headers[HTTP_HEADERS.authorization];
    const token = header?.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : null;
    return token === null ? null : services.hostsService.authenticate(token);
  };
  await app.register(rateLimit, {
    global: true,
    max: RUNNER_RATE_LIMIT_PER_MINUTE,
    timeWindow: RATE_LIMIT_WINDOW_MILLISECONDS,
    // Each runner its own allowance: the ones inside the control plane all come from loopback. (A request whose token
    // opens nothing is refused by the hook below before it is counted.)
    keyGenerator: (request) => {
      const host = hostOf(request);
      return host === null ? request.ip : `${RUNNER_RATE_LIMIT_HOST_KEY}${host.id}`;
    },
  });
  app.decorateRequest("runnerHost", null);
  app.addHook("onRequest", async (request, reply) => {
    request.runnerHost = hostOf(request);
    // A runner trading its join code has no token yet: the code it sends is what opens the door.
    const joining = request.routeOptions.url === RUNNER_ROUTES.join;
    if (request.runnerHost === null && !joining) {
      return reply.code(HTTP_STATUS.unauthorized).send({ error: API_ERRORS.unknownRunner });
    }
  });
  registerRunnerRoutes(app, services);
  return app;
}
