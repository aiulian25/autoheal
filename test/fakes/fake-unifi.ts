import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";

const fixture = (name: string) => readFileSync(`test/fixtures/tls/${name}`);
const API = "/proxy/network/api/s/default";
export const FAKE_UNIFI_CLIENTS_PATH = `${API}/stat/sta`;
export const FAKE_UNIFI_LOGIN = { username: "autoheal-read", password: "a-fake-router-password" };
// Far inside any wait between two bytes, so only a limit on the whole answer ends one.
const TRICKLE_MILLISECONDS = 20;

/** A UniFi OS router, as much of its API as Autoheal reads, over real TLS. */
export class FakeUnifi {
  readonly requests: { method: string; path: string; body: string }[] = [];
  clients: object[] = [];
  devices: object[] = [];
  health: object[] = [];
  rules: object[] | null = [];
  forwards: object[] | null = [];
  speedTestStatus = 200;
  // Paths answered a space at a time and never finished, for as long as the asker keeps listening.
  readonly trickled = new Set<string>();
  private trickling = 0;
  private sessions = new Set<string>();
  private server!: Server;

  // A prefix picks another of the test certificates; the same port with another is a router whose certificate changed.
  static async start(certificatePrefix = "", port = 0): Promise<FakeUnifi> {
    const fake = new FakeUnifi();
    fake.server = createServer(
      { cert: fixture(`${certificatePrefix}server.pem`), key: fixture(`${certificatePrefix}server-key.pem`) },
      (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const path = request.url ?? "";
          fake.requests.push({ method: request.method ?? "", path, body });
          const { status, data, headers } = fake.answer(request.method ?? "", path, body, request.headers.cookie);
          if (fake.trickled.has(path)) {
            fake.trickle(response, status);
            return;
          }
          response.writeHead(status, { "content-type": "application/json", ...headers });
          response.end(JSON.stringify(data));
        });
      },
    );
    await new Promise<void>((resolve) => fake.server.listen(port, "127.0.0.1", resolve));
    return fake;
  }

  private answer(method: string, path: string, body: string, cookie: string | undefined) {
    if (path === "/api/auth/login") return this.login(body);
    if (cookie === undefined || !this.sessions.has(cookie)) return { status: 401, data: {}, headers: {} };
    if (method === "POST") return { status: this.speedTestStatus, data: { data: [] }, headers: {} };
    const rows = this.rowsOf(path);
    return rows === null ? { status: 403, data: {}, headers: {} } : { status: 200, data: { data: rows }, headers: {} };
  }

  private login(body: string) {
    const { username, password } = JSON.parse(body) as typeof FAKE_UNIFI_LOGIN;
    if (username !== FAKE_UNIFI_LOGIN.username || password !== FAKE_UNIFI_LOGIN.password) {
      return { status: 401, data: {}, headers: {} };
    }
    const session = `TOKEN=${this.sessions.size + 1}`;
    this.sessions.add(session);
    return { status: 200, data: {}, headers: { "set-cookie": `${session}; Path=/; HttpOnly`, "x-csrf-token": "fake" } };
  }

  private rowsOf(path: string): object[] | null {
    const rows: Record<string, object[] | null> = {
      [FAKE_UNIFI_CLIENTS_PATH]: this.clients,
      [`${API}/stat/device`]: this.devices,
      [`${API}/stat/health`]: this.health,
      [`${API}/rest/firewallrule`]: this.rules,
      [`${API}/rest/portforward`]: this.forwards,
    };
    return rows[path] ?? null;
  }

  private trickle(response: ServerResponse, status: number) {
    response.writeHead(status, { "content-type": "application/json" });
    this.trickling += 1;
    const drip = setInterval(() => response.write(" "), TRICKLE_MILLISECONDS);
    response.once("close", () => {
      clearInterval(drip);
      this.trickling -= 1;
    });
  }

  // Trickled answers still open: one its asker let go of is closed, and counts no more.
  openAnswers() {
    return this.trickling;
  }

  endSessions() {
    this.sessions.clear();
  }

  loginCount() {
    return this.requests.filter(({ path }) => path === "/api/auth/login").length;
  }

  port() {
    return (this.server.address() as AddressInfo).port;
  }

  url() {
    return `https://127.0.0.1:${this.port()}`;
  }

  async close() {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
