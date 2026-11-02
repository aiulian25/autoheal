import { PassThrough } from "node:stream";
import type { FastifyReply } from "fastify";
import { EVENT_STREAM_KEEPALIVE, SSE_BUFFER_LIMIT_BYTES } from "../../shared/constants.js";

/** No secondary queue: a slow reader reconnects instead of holding producers or retaining output. */
export function sseWriter(reply: FastifyReply, keepaliveMilliseconds: number, isLive = () => true) {
  // Room for the complete terminal replay before Fastify attaches its consumer.
  const stream = new PassThrough({ highWaterMark: SSE_BUFFER_LIMIT_BYTES / 2 });
  const cleanups = new Set<() => void>();
  let active = true;
  const cleanup = (stop: () => void) => {
    if (active) cleanups.add(stop);
    else stop(); // follow() may replay and end synchronously, before returning its unsubscribe function.
  };
  const dispose = () => {
    if (!active) return;
    active = false;
    for (const stop of cleanups) stop();
    cleanups.clear();
  };
  const close = () => {
    dispose();
    stream.destroy();
  };
  const end = () => {
    if (!active) return;
    dispose();
    stream.end();
  };
  const write = (text: string): boolean => {
    if (!active || stream.destroyed || !stream.writable) return false;
    const bytes = Buffer.byteLength(text);
    const queued = stream.readableLength + stream.writableLength + (reply.raw.writableLength ?? 0);
    // A blocked Transform can account for the current chunk on both sides. Reserve both before writing.
    if (queued + 2 * bytes > SSE_BUFFER_LIMIT_BYTES) {
      close();
      return false;
    }
    if (!stream.write(text)) {
      close();
      return false;
    }
    return true;
  };
  stream.once("close", close);
  stream.once("error", close);
  reply.raw.once("close", close);
  reply.raw.once("error", close);
  cleanup(() => {
    reply.raw.off("close", close);
    reply.raw.off("error", close);
  });
  const timer = setInterval(() => {
    try {
      if (isLive()) write(EVENT_STREAM_KEEPALIVE);
      else end();
    } catch {
      close();
    }
  }, keepaliveMilliseconds);
  cleanup(() => clearInterval(timer));
  return { stream, write, end, close, cleanup, isActive: () => active };
}
