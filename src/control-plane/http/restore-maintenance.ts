import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { API_ROUTES, API_ERRORS } from "../../shared/api.js";
import { HTTP_HEADERS, HTTP_STATUS, JSON_CONTENT_TYPE } from "../../shared/constants.js";
import type { RestoreCoordinator } from "../database/restore-coordinator.js";

/** Applies before authentication/dispatch on both APIs; already admitted handlers drain before a swap. */
export function registerRestoreMaintenance(app: FastifyInstance, coordinator: RestoreCoordinator) {
  const requests = new WeakMap<FastifyRequest, () => void>();
  const release = (request: FastifyRequest) => {
    requests.get(request)?.();
    requests.delete(request);
  };
  app.addHook("onRequest", (request, _reply, done) => {
    try {
      coordinator.request((finish) => {
        requests.set(request, finish);
        done();
      }, request.routeOptions.url !== API_ROUTES.restoreConfirm);
    } catch (error) {
      done(error as Error);
    }
  });
  app.addHook("onSend", (request, reply, payload, done) => {
    if (payload instanceof Readable) {
      if (coordinator.busy) {
        payload.destroy();
        release(request);
        reply.code(HTTP_STATUS.serviceUnavailable).header(HTTP_HEADERS.contentType, JSON_CONTENT_TYPE);
        done(null, JSON.stringify({ error: API_ERRORS.restoreMaintenance }));
        return;
      }

      const stop = coordinator.onPause(() => payload.destroy());
      payload.once("close", stop);
    }
    release(request);
    done(null, payload);
  });
  app.addHook("onResponse", (request, _reply, done) => {
    release(request);
    done();
  });
  app.addHook("onRequestAbort", (request, done) => {
    release(request);
    done();
  });
}
