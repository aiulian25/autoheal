import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";

export interface GotifyMessage {
  title: string;
  message: string;
  priority: number;
  key: string | undefined;
}

/** Gotify's POST /message over real HTTPS, recording what arrives. */
export class FakeGotify {
  readonly messages: GotifyMessage[] = [];
  status = 200;
  private server: Server | null = null;
  private port = 0;

  static async start(): Promise<FakeGotify> {
    const gotify = new FakeGotify();
    gotify.server = createServer(
      { cert: readFileSync("test/fixtures/tls/server.pem"), key: readFileSync("test/fixtures/tls/server-key.pem") },
      (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          gotify.messages.push({ ...body, key: request.headers["x-gotify-key"] as string | undefined });
          response.writeHead(gotify.status, { "content-type": "application/json" });
          response.end("{}");
        });
      },
    );
    await new Promise<void>((resolve) => gotify.server!.listen(0, "127.0.0.1", resolve));
    gotify.port = (gotify.server.address() as AddressInfo).port;
    return gotify;
  }

  get settings() {
    return { url: `https://localhost:${this.port}`, token: "app-token" };
  }

  close() {
    return new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
