import { EventEmitter } from "node:events";
import { get, type ClientRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import type { PassThrough } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ERRORS, API_ROUTES } from "../../shared/api.js";
import { LIVE_KEEPALIVE_MILLISECONDS, SSE_BUFFER_LIMIT_BYTES } from "../../shared/constants.js";
import { registerTerminalRoutes } from "../container-access/terminal-routes.js";
import type { TerminalEvent, TerminalService } from "../container-access/terminal-service.js";
import { sseWriter } from "./sse-writer.js";
import { registerLiveRoutes } from "../live/live-routes.js";
import { LiveEvents } from "../live/live-events.js";

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

const OWNER = { tokenHash: "owner", user: { id: "owner" } };
// The same account, signed in on another device.
const OWNER_ELSEWHERE = { tokenHash: "owner-elsewhere", user: { id: "owner" } };
const PEER = { tokenHash: "peer", user: { id: "peer" } };

/** Invoke the production route with a response that never consumes the payload. No network timing. */
function streamFixture() {
  const handlers = new Map<string, Handler>();
  const app = {
    get: (path: string, ...args: unknown[]) => handlers.set(path, args.at(-1) as Handler),
    post: () => {},
    delete: () => {},
  } as unknown as FastifyInstance;
  const raw = new EventEmitter();
  let stream!: PassThrough;
  const reply = {
    raw,
    header: () => reply,
    send: (payload: PassThrough) => {
      stream = payload;
      return reply;
    },
  } as unknown as FastifyReply;
  const open = async (path: string, params: object = {}, authSession: object = OWNER) => {
    await handlers.get(path)!({ authSession, headers: {}, params } as FastifyRequest, reply);
    return stream;
  };
  return { app, raw, open, reply };
}

afterEach(() => vi.useRealTimers());
describe("live streams of one account", () => {
  const STREAMS_EACH = 2;

  it("holds an account to its share, tabs and devices together, and gives a closed stream's place back", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fixture = streamFixture();
    const live = new LiveEvents();
    const isLive = vi.fn(() => true);
    registerLiveRoutes(fixture.app, live, { isLive }, STREAMS_EACH);
    const subscribe = vi.spyOn(live, "subscribe");
    const owners = [await fixture.open(API_ROUTES.live), await fixture.open(API_ROUTES.live, {}, OWNER_ELSEWHERE)];
    await expect(fixture.open(API_ROUTES.live)).rejects.toMatchObject({ code: API_ERRORS.liveStreamsFull });
    const peers = await fixture.open(API_ROUTES.live, {}, PEER);
    vi.advanceTimersByTime(LIVE_KEEPALIVE_MILLISECONDS);
    expect(isLive).toHaveBeenCalledTimes(STREAMS_EACH + 1);
    expect(subscribe).toHaveBeenCalledTimes(STREAMS_EACH + 1);

    owners[0]!.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    const reopened = await fixture.open(API_ROUTES.live);
    await expect(fixture.open(API_ROUTES.live, {}, OWNER_ELSEWHERE)).rejects.toMatchObject({
      code: API_ERRORS.liveStreamsFull,
    });
    for (const stream of [owners[1]!, peers, reopened]) stream.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(vi.getTimerCount()).toBe(0);
    expect(subscribe.mock.results.map(({ value }) => (value as () => boolean)())).toEqual([false, false, false, false]);
  });
});

describe("slow SSE readers", () => {
  it("disconnects an unread live stream rather than buffering sustained events indefinitely", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fixture = streamFixture();
    const live = new LiveEvents();
    registerLiveRoutes(fixture.app, live, { isLive: () => true });
    const subscribe = vi.spyOn(live, "subscribe");
    const stream = await fixture.open(API_ROUTES.live);
    try {
      for (let index = 0; index < 4096; index++)
        live.publish({ kind: "job", hostId: "h".repeat(128), jobId: String(index) });
      expect(stream.destroyed).toBe(true);
      expect(subscribe.mock.results[0]!.value()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(fixture.raw.listenerCount("close")).toBe(0);
      expect(stream.readableLength + stream.writableLength).toBeLessThanOrEqual(SSE_BUFFER_LIMIT_BYTES);
    } finally {
      stream.destroy();
      await Promise.resolve();
    }
  });
});

it("disconnects only the slow terminal follower, clears its resources and leaves the shell running", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const fixture = streamFixture();
  const listeners = new Set<(event: TerminalEvent) => void>();
  const close = vi.fn();
  const terminal = {
    follow: (_session: unknown, _id: unknown, _last: unknown, listener: (event: TerminalEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close,
  } as unknown as TerminalService;
  registerTerminalRoutes(fixture.app, terminal);
  const stream = await fixture.open(API_ROUTES.terminalStream, { terminalId: "18c6975b-a0c3-4cbd-a06a-be09c4021ca9" });
  let peak = 0;
  for (let sequence = 1; sequence <= 4096; sequence++) {
    listeners.forEach((listener) => listener({ kind: "output", sequence, data: "a".repeat(1024) }));
    peak = Math.max(peak, stream.readableLength + stream.writableLength);
  }
  expect(stream.destroyed).toBe(true);
  expect(peak).toBeLessThanOrEqual(SSE_BUFFER_LIMIT_BYTES);
  expect(listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(fixture.raw.listenerCount("close")).toBe(0);
  expect(fixture.raw.listenerCount("error")).toBe(0);
  expect(close).not.toHaveBeenCalled();
});

it.each(["close", "error"])("cleans up when the HTTP response emits %s", async (event) => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const fixture = streamFixture();
  const writer = sseWriter(fixture.reply, 15_000);
  const stop = vi.fn();
  writer.cleanup(stop);
  fixture.raw.emit(event, new Error("synthetic"));
  expect(writer.stream.destroyed).toBe(true);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(fixture.raw.listenerCount("close")).toBe(0);
  expect(fixture.raw.listenerCount("error")).toBe(0);
});

it("cleans up stream errors, synchronous end, and late unsubscribe registration", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const fixture = streamFixture();
  const writer = sseWriter(fixture.reply, 15_000);
  const stopped = vi.fn();
  writer.cleanup(stopped);
  writer.stream.destroy(new Error("synthetic stream error"));
  await new Promise((resolve) => setImmediate(resolve));
  expect(stopped).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  const second = sseWriter(fixture.reply, 15_000);
  second.end();
  const late = vi.fn();
  second.cleanup(late);
  expect(late).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("counts UTF-8 bytes and rejects oversized frames and pending HTTP output before enqueueing", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const fixture = streamFixture();
  const writer = sseWriter(fixture.reply, 15_000);
  expect(writer.write("😀".repeat(SSE_BUFFER_LIMIT_BYTES / 4))).toBe(false);
  expect(writer.stream.readableLength + writer.stream.writableLength).toBe(0);
  const second = sseWriter(fixture.reply, 15_000);
  Object.defineProperty(fixture.raw, "writableLength", { value: SSE_BUFFER_LIMIT_BYTES - 1 });
  expect(second.write("abc")).toBe(false);
  expect(second.stream.readableLength).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("closes on write backpressure and on a failing liveness check", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const fixture = streamFixture();
  const writer = sseWriter(fixture.reply, 15_000);
  vi.spyOn(writer.stream, "write").mockReturnValue(false);
  expect(writer.write("small frame")).toBe(false);
  expect(writer.stream.destroyed).toBe(true);
  const second = sseWriter(fixture.reply, 15_000, () => {
    throw new Error("unavailable session store");
  });
  expect(() => vi.advanceTimersByTime(15_000)).not.toThrow();
  expect(second.stream.destroyed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("cleans up a terminal follow that throws before a response is sent", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const fixture = streamFixture();
  registerTerminalRoutes(fixture.app, {
    follow: () => {
      throw new Error("refused");
    },
  } as unknown as TerminalService);
  await expect(
    fixture.open(API_ROUTES.terminalStream, { terminalId: "18c6975b-a0c3-4cbd-a06a-be09c4021ca9" }),
  ).rejects.toThrow("refused");
  expect(vi.getTimerCount()).toBe(0);
  expect(fixture.raw.listenerCount("close")).toBe(0);
});

it("keeps a reading terminal follower working when another follower is disconnected", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const slow = streamFixture(),
    fast = streamFixture();
  const listeners = new Set<(event: TerminalEvent) => void>();
  const terminal = {
    follow: (_session: unknown, _id: unknown, _last: unknown, listener: (event: TerminalEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as TerminalService;
  registerTerminalRoutes(slow.app, terminal);
  registerTerminalRoutes(fast.app, terminal);
  const params = { terminalId: "18c6975b-a0c3-4cbd-a06a-be09c4021ca9" };
  const slowStream = await slow.open(API_ROUTES.terminalStream, params);
  const fastStream = await fast.open(API_ROUTES.terminalStream, params);
  let received = 0;
  fastStream.on("data", () => received++);
  await new Promise((resolve) => setImmediate(resolve));
  for (let sequence = 1; sequence <= 4096; sequence++)
    listeners.forEach((listener) => listener({ kind: "output", sequence, data: "a".repeat(1024) }));
  expect(slowStream.destroyed).toBe(true);
  expect(fastStream.destroyed).toBe(false);
  expect(received).toBe(4097); // The initial keepalive, followed by every output.
  expect(listeners.size).toBe(1);
  expect(vi.getTimerCount()).toBe(1);
  fast.raw.emit("close");
  expect(listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("cuts off a non-reading local HTTP client through Fastify and releases its subscription", async () => {
  const app = Fastify({ logger: false });
  const live = new LiveEvents();
  const subscribe = vi.spyOn(live, "subscribe");
  let payload!: PassThrough;
  let response!: ServerResponse;
  app.decorateRequest("authSession", null);
  app.addHook("onRequest", async (request) => {
    request.authSession = {
      tokenHash: "owner",
      csrfToken: "csrf",
      secondFactorDone: true,
      user: { id: "user", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
    };
  });
  app.addHook("onSend", (_request, reply, body, done) => {
    payload = body as PassThrough;
    response = reply.raw;
    done(null, body);
  });
  registerLiveRoutes(app, live, { isLive: () => true });
  let request: ClientRequest | undefined;
  let incoming: IncomingMessage | undefined;
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    incoming = await new Promise<IncomingMessage>((resolve, reject) => {
      request = get(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}${API_ROUTES.live}`, (reply) => {
        reply.pause();
        resolve(reply);
      });
      request.on("error", reject);
    });
    incoming.on("error", () => {});
    let peak = 0;
    for (let index = 0; index < 20000 && !payload.destroyed; index++) {
      live.publish({ kind: "job", hostId: "h".repeat(128), jobId: String(index) });
      peak = Math.max(peak, payload.readableLength + payload.writableLength + response.writableLength);
    }
    expect(payload.destroyed).toBe(true);
    expect(peak).toBeLessThanOrEqual(SSE_BUFFER_LIMIT_BYTES);
    await vi.waitFor(() => expect(response.destroyed).toBe(true));
    expect(subscribe.mock.results[0]!.value()).toBe(false);
  } finally {
    incoming?.destroy();
    request?.destroy();
    await app.close();
  }
});
