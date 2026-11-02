import { sseWriter } from "../http/sse-writer.js";
import type { FastifyInstance } from "fastify";
import { API_ROUTES } from "../../shared/api.js";
import {
  ACCEL_BUFFERING_OFF,
  EVENT_STREAM_CONTENT_TYPE,
  EVENT_STREAM_KEEPALIVE,
  HTTP_HEADERS,
  LIVE_KEEPALIVE_MILLISECONDS,
} from "../../shared/constants.js";
import type { SessionStore } from "../auth/sessions.js";
import type { LiveEvents } from "./live-events.js";

/**
 * Server-sent events for anyone signed in: what changed, as it changes, so pages need not ask again and again. The
 * stream ends with its sign-in: signed out, ended from the account page, or past its time.
 */
export function registerLiveRoutes(app: FastifyInstance, live: LiveEvents, sessions: Pick<SessionStore, "isLive">) {
  app.get(API_ROUTES.live, async (request, reply) => {
    const tokenHash = request.authSession!.tokenHash;
    const writer = sseWriter(reply, LIVE_KEEPALIVE_MILLISECONDS, () => sessions.isLive(tokenHash));
    writer.write(EVENT_STREAM_KEEPALIVE);
    writer.cleanup(live.subscribe((event) => writer.write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`)));
    return reply
      .header(HTTP_HEADERS.contentType, EVENT_STREAM_CONTENT_TYPE)
      .header(HTTP_HEADERS.accelBuffering, ACCEL_BUFFERING_OFF)
      .send(writer.stream);
  });
}
