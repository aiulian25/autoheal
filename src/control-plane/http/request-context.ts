import type { FastifyRequest } from "fastify";
import { FORWARDED_FOR_SEPARATOR, HTTP_HEADERS } from "../../shared/constants.js";
import type { Actor } from "../audit/audit-log.js";
import type { RequestContext } from "../auth/auth-service.js";
import type { Arrival } from "../settings/trusted-proxies-service.js";

export const requestContext = (request: FastifyRequest): RequestContext => ({
  ip: request.ip,
  userAgent: request.headers[HTTP_HEADERS.userAgent] ?? null,
  requestId: request.id,
});

/** The signed-in person behind a request; only for routes that require a session. */
export const actorOf = (request: FastifyRequest): Actor => ({
  userId: request.authSession!.user.id,
  username: request.authSession!.user.username,
  ip: request.ip,
  requestId: request.id,
});

/** How a request reached the dashboard: its connection's address, whom a proxy says it is for, and the client. */
export function arrivalOf(request: FastifyRequest): Arrival {
  const header = request.headers[HTTP_HEADERS.forwardedFor];
  const forwarded = (Array.isArray(header) ? header.join(FORWARDED_FOR_SEPARATOR) : header) ?? "";
  const last = forwarded.split(FORWARDED_FOR_SEPARATOR).at(-1)?.trim() ?? "";
  return {
    peer: request.socket.remoteAddress ?? request.ip,
    forwardedFor: last === "" ? null : last,
    seenAs: request.ip,
  };
}
