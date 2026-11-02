import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";

export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
}

export interface ServerOptions {
  // Null in tests, which talk to the server through inject().
  tls: TlsMaterial | null;
  // Which senders may say, in X-Forwarded-*, whom a request is for; asked for every request. Null for none.
  isTrustedProxy: ((address: string) => boolean) | null;
  bodyLimit: number;
}

export function createServer({ tls, isTrustedProxy, bodyLimit }: ServerOptions): FastifyInstance {
  const options = {
    logger: false,
    trustProxy: isTrustedProxy ?? false,
    genReqId: () => randomUUID(),
    bodyLimit,
    // By default close() waits for a connection that never sent a request: a browser's spare one, or the one Node 24's
    // keep-alive agent pools when a request is aborted while connecting. Shutdown would then run out its deadline.
    forceCloseConnections: true,
  };
  // One cast: Fastify types an HTTPS instance differently, the routes do not care which it is.
  return (tls === null ? Fastify(options) : Fastify({ ...options, https: tls })) as unknown as FastifyInstance;
}
