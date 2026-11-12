import { sseWriter } from "../http/sse-writer.js";
import type { FastifyInstance } from "fastify";
import { API_ERRORS, API_ROUTES } from "../../shared/api.js";
import {
  ACCEL_BUFFERING_OFF,
  EVENT_STREAM_CONTENT_TYPE,
  EVENT_STREAM_KEEPALIVE,
  HTTP_HEADERS,
  LIVE_KEEPALIVE_MILLISECONDS,
  LIVE_STREAMS_PER_ACCOUNT,
} from "../../shared/constants.js";
import type { SessionStore } from "../auth/sessions.js";
import { DomainError } from "../domain-error.js";
import type { LiveEvents } from "./live-events.js";

/**
 * Server-sent events for anyone signed in: what changed, as it changes, so pages need not ask again and again. The
 * stream ends with its sign-in: signed out, ended from the account page, or past its time. An account holds only so
 * many at once: one more is refused, and its page asks again a few seconds later.
 */
export function registerLiveRoutes(
  app: FastifyInstance,
  live: LiveEvents,
  sessions: Pick<SessionStore, "isLive">,
  perAccount = LIVE_STREAMS_PER_ACCOUNT,
) {
  const held = new Map<string, number>();
  const release = (userId: string) => {
    const left = (held.get(userId) ?? 0) - 1;
    if (left > 0) held.set(userId, left);
    else held.delete(userId);
  };
  app.get(API_ROUTES.live, async (request, reply) => {
    const { tokenHash, user } = request.authSession!;
    const open = held.get(user.id) ?? 0;
    if (open >= perAccount) throw new DomainError(API_ERRORS.liveStreamsFull);
    const writer = sseWriter(reply, LIVE_KEEPALIVE_MILLISECONDS, () => sessions.isLive(tokenHash));
    held.set(user.id, open + 1);
    // However the stream ends, its place goes back.
    writer.cleanup(() => release(user.id));
    writer.write(EVENT_STREAM_KEEPALIVE);
    writer.cleanup(live.subscribe((event) => writer.write(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`)));
    return reply
      .header(HTTP_HEADERS.contentType, EVENT_STREAM_CONTENT_TYPE)
      .header(HTTP_HEADERS.accelBuffering, ACCEL_BUFFERING_OFF)
      .send(writer.stream);
  });
}
