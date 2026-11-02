import { readFileSync } from "node:fs";
import { createServer as createPlainServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";

export interface ChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  format: Record<string, unknown>;
  stream: boolean;
  think?: boolean;
  options: { temperature: number; num_ctx: number; num_predict: number };
}

// `stream` is sent as it is, for a stream that goes wrong partway.
type ChatReply = { status: number; body: unknown } | { status: number; stream: string };
export type ChatHandler = (request: ChatRequest) => Promise<ChatReply> | ChatReply;

export const answer = (decision: Record<string, unknown>) => ({
  status: 200,
  body: { message: { role: "assistant", content: JSON.stringify(decision) } },
});

export const MODEL_DIGEST = "sha256:5f7b4c2a";

// A streamed answer, as Ollama writes one: a line of thinking where the model thinks, the answer in two
// pieces, then the line that ends it. Anything else is sent as it is, in one line.
function streamed(body: unknown, thinking: boolean): string {
  const content = (body as { message?: { content?: unknown } }).message?.content;
  if (typeof content !== "string") {
    return JSON.stringify(body);
  }
  const middle = Math.floor(content.length / 2);
  const line = (fields: object) => JSON.stringify({ model: "qwen3:4b-instruct", ...fields });
  return [
    ...(thinking
      ? [line({ message: { role: "assistant", content: "", thinking: "The logs show…" }, done: false })]
      : []),
    line({ message: { role: "assistant", content: content.slice(0, middle) }, done: false }),
    line({ message: { role: "assistant", content: content.slice(middle) }, done: false }),
    line({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop" }),
  ].join("\n");
}

// Ollama's read-only answers: its version, and the models loaded right now. The models it has are the fake's own.
const READS: Record<string, unknown> = {
  "/api/version": { version: "0.12.0" },
  "/api/ps": { models: [{ name: "qwen3:4b-instruct", size: 4_000_000_000, size_vram: 4_000_000_000 }] },
};
const TAGS_PATH = "/api/tags";
const SHOW_PATH = "/api/show";

/**
 * Ollama's /api/chat and its read-only calls: over real HTTPS with test certificates, or over plain
 * http as most people run Ollama.
 */
export class FakeOllama {
  readonly requests: ChatRequest[] = [];
  // What /api/show says of each model it has; a model it lacks is answered 404, as Ollama does.
  models: Record<string, { capabilities?: string[]; model_info?: Record<string, unknown> }> = {
    "qwen3:4b-instruct": { capabilities: ["completion", "thinking"], model_info: { "qwen3.context_length": 40_960 } },
  };
  handler: ChatHandler = () => answer({ action: "escalate", target: "", diagnosis: "default answer" });
  private server: Server | ReturnType<typeof createPlainServer> | null = null;
  private port = 0;
  private scheme = "https";

  static async start(
    certificate: "trusted" | "untrusted" | "plain" = "trusted",
    listenAddress = "127.0.0.1",
  ): Promise<FakeOllama> {
    const fake = new FakeOllama();
    const respond = (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", async () => {
        const tags = { models: Object.keys(fake.models).map((name) => ({ name, digest: MODEL_DIGEST })) };
        const read = request.url === TAGS_PATH ? tags : READS[request.url!];
        if (read !== undefined) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(read));
          return;
        }
        if (request.url === SHOW_PATH) {
          const { model } = JSON.parse(Buffer.concat(chunks).toString()) as { model: string };
          const shown = fake.models[model];
          response.writeHead(shown === undefined ? 404 : 200, { "content-type": "application/json" });
          response.end(JSON.stringify(shown ?? { error: `model '${model}' not found` }));
          return;
        }
        const chat = JSON.parse(Buffer.concat(chunks).toString()) as ChatRequest;
        fake.requests.push(chat);
        const reply = await fake.handler(chat);
        const streaming = chat.stream && reply.status === 200;
        response.writeHead(reply.status, {
          "content-type": streaming ? "application/x-ndjson" : "application/json",
        });
        if ("stream" in reply) {
          response.end(reply.stream);
          return;
        }
        response.end(streaming ? streamed(reply.body, chat.think !== false) : JSON.stringify(reply.body));
      });
    };
    const prefix = certificate === "trusted" ? "server" : "untrusted-server";
    fake.scheme = certificate === "plain" ? "http" : "https";
    fake.server =
      certificate === "plain"
        ? createPlainServer(respond)
        : createServer(
            {
              cert: readFileSync(`test/fixtures/tls/${prefix}.pem`),
              key: readFileSync(`test/fixtures/tls/${prefix}-key.pem`),
            },
            respond,
          );
    await new Promise<void>((resolve) => fake.server!.listen(0, listenAddress, resolve));
    fake.port = (fake.server.address() as AddressInfo).port;
    return fake;
  }

  url(host = "localhost") {
    return `${this.scheme}://${host}:${this.port}`;
  }

  get listeningPort() {
    return this.port;
  }

  close() {
    return new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
