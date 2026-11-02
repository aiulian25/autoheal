import { sseWriter } from "../http/sse-writer.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { API_ROUTES } from "../../shared/api.js";
import {
  ACCEL_BUFFERING_OFF,
  ACCESS_FULL,
  EVENT_STREAM_CONTENT_TYPE,
  EVENT_STREAM_KEEPALIVE,
  HTTP_HEADERS,
  HTTP_STATUS,
  RATE_LIMIT_WINDOW_MILLISECONDS,
  REPORT_LIMITS,
  TERMINAL_EVENTS,
  TERMINAL_INPUT_CHARACTERS,
  TERMINAL_KEEPALIVE_MILLISECONDS,
  TERMINAL_RATE_LIMIT_PER_MINUTE,
  TERMINAL_SIZE_LIMITS,
} from "../../shared/constants.js";
import { parseBody } from "../http/errors.js";
import { actorOf } from "../http/request-context.js";
import type { TerminalEvent, TerminalService } from "./terminal-service.js";

// A shell asks often: every few keystrokes, every burst of output. The usual limit would cut it off mid-word.
export const terminalRateLimit = { max: TERMINAL_RATE_LIMIT_PER_MINUTE, timeWindow: RATE_LIMIT_WINDOW_MILLISECONDS };
const scopedAccess = { config: { access: ACCESS_FULL } } as const;
const typing = { config: { access: ACCESS_FULL, rateLimit: terminalRateLimit } } as const;

export const terminalParameters = z.object({ terminalId: z.uuid() });
const hostParameters = z.object({ hostId: z.uuid() });
const containerParameters = z.object({
  hostId: z.uuid(),
  containerName: z.string().min(1).max(REPORT_LIMITS.nameCharacters),
});
const sizeBody = z.object({
  columns: z.number().int().min(TERMINAL_SIZE_LIMITS.columns.min).max(TERMINAL_SIZE_LIMITS.columns.max),
  rows: z.number().int().min(TERMINAL_SIZE_LIMITS.rows.min).max(TERMINAL_SIZE_LIMITS.rows.max),
});
const inputBody = z.object({ data: z.string().min(1).max(TERMINAL_INPUT_CHARACTERS) });
// What the browser had before it connected again: anything else starts from the beginning.
const lastEventId = z.coerce.number().int().nonnegative().catch(0);

// Output is numbered, so a browser that connects again is sent only what it missed.
function eventText(event: TerminalEvent): string {
  if (event.kind === "gap") {
    return `id: ${event.sequence}\nevent: ${TERMINAL_EVENTS.gap}\ndata: {}\n\n`;
  }
  if (event.kind === "output") {
    return `id: ${event.sequence}\nevent: ${TERMINAL_EVENTS.output}\ndata: ${event.data}\n\n`;
  }
  return `event: ${TERMINAL_EVENTS.ended}\ndata: ${JSON.stringify(event.end)}\n\n`;
}

/** Shells inside containers or on a host: open one, follow what it prints, type into it, resize it, close it. */
export function registerTerminalRoutes(app: FastifyInstance, terminals: TerminalService) {
  // Admins only: the service refuses operators, whatever their grants.
  app.post(API_ROUTES.hostTerminals, scopedAccess, async (request) => {
    const { hostId } = parseBody(hostParameters, request.params);
    return terminals.openHost(actorOf(request), request.authSession!, hostId, parseBody(sizeBody, request.body));
  });

  app.post(API_ROUTES.terminals, scopedAccess, async (request) => {
    const { hostId, containerName } = parseBody(containerParameters, request.params);
    const size = parseBody(sizeBody, request.body);
    return terminals.open(actorOf(request), request.authSession!, hostId, containerName, size);
  });

  // Server-sent events: what the shell prints, base64, then how it ended.
  app.get(API_ROUTES.terminalStream, scopedAccess, async (request, reply) => {
    const { terminalId } = parseBody(terminalParameters, request.params);
    const writer = sseWriter(reply, TERMINAL_KEEPALIVE_MILLISECONDS);
    writer.write(EVENT_STREAM_KEEPALIVE);
    try {
      writer.cleanup(
        terminals.follow(
          request.authSession!,
          terminalId,
          lastEventId.parse(request.headers[HTTP_HEADERS.lastEventId]),
          (event) => {
            writer.write(eventText(event));
            if (event.kind === TERMINAL_EVENTS.ended) writer.end();
          },
          writer.isActive,
        ),
      );
    } catch (error) {
      writer.close();
      throw error;
    }
    return reply
      .header(HTTP_HEADERS.contentType, EVENT_STREAM_CONTENT_TYPE)
      .header(HTTP_HEADERS.accelBuffering, ACCEL_BUFFERING_OFF)
      .send(writer.stream);
  });

  app.post(API_ROUTES.terminalInput, typing, async (request, reply) => {
    const { terminalId } = parseBody(terminalParameters, request.params);
    terminals.type(request.authSession!, terminalId, parseBody(inputBody, request.body).data);
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.post(API_ROUTES.terminalResize, typing, async (request, reply) => {
    const { terminalId } = parseBody(terminalParameters, request.params);
    terminals.resize(request.authSession!, terminalId, parseBody(sizeBody, request.body));
    return reply.code(HTTP_STATUS.noContent).send();
  });

  app.delete(API_ROUTES.terminal, scopedAccess, async (request, reply) => {
    const { terminalId } = parseBody(terminalParameters, request.params);
    terminals.close(request.authSession!, terminalId);
    return reply.code(HTTP_STATUS.noContent).send();
  });
}
