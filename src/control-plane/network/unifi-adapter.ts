import { isIP } from "node:net";
import { connect, type ConnectionOptions } from "node:tls";
import { Agent, request as httpsRequest, type RequestOptions } from "node:https";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { describeError } from "../../shared/errors.js";
import {
  ROUTER_CAPABILITY,
  ROUTER_DEVICE_KIND,
  type RouterCapability,
  type RouterDeviceKind,
  type RouterProbeView,
} from "../../shared/network.js";
import {
  RouterCertificateChanged,
  RouterLoginRefused,
  type ExposureSnapshot,
  type InternetHealth,
  type RouterAdapter,
  type RouterClient,
  type RouterDevice,
} from "./router-adapter.js";

const LOGIN_PATH = "/api/auth/login";
const API = "/proxy/network/api/s/default";
const SPEED_TEST_PATH = `${API}/cmd/devmgr`;
const SPEED_TEST_COMMAND = "speedtest";
const REQUEST_TIMEOUT_MILLISECONDS = 20_000;
const BITS_PER_MEGABIT = 1_000_000;
const STATUS_OK_FROM = 200;
const STATUS_OK_TO = 299;
const STATUS_REFUSED = new Set([401, 403]);
const STATUS_UNAUTHORIZED = 401;
const MILLISECONDS_IN_SECOND = 1_000;
const CSRF_HEADER = "x-csrf-token";
const HTTPS_PORT = 443;

/**
 * The certificate an address shows, and nothing else: the connection is closed the moment it is read, with no request
 * and no login sent. Nothing is trusted by looking: that takes a person comparing it.
 */
export function routerCertificate(url: string): Promise<string> {
  const { hostname, port } = new URL(url);
  const host = hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve, reject) => {
    const socket = connect({
      host,
      port: Number(port || HTTPS_PORT),
      ...(isIP(host) === 0 ? { servername: host } : {}),
      rejectUnauthorized: false,
      timeout: REQUEST_TIMEOUT_MILLISECONDS,
    });
    socket.once("timeout", () => socket.destroy(new Error("The router took too long to answer.")));
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      const fingerprint = socket.getPeerX509Certificate()?.fingerprint256;
      socket.destroy();
      if (fingerprint === undefined) reject(new Error("The router showed no certificate."));
      else resolve(fingerprint);
    });
  });
}

// Holds the router to the one certificate a person approved, before a single byte of any request goes out. With none
// approved it goes no further, so a login can never go to whoever happens to answer.
class PinningAgent extends Agent {
  constructor(private readonly pin: string | null) {
    super({ keepAlive: true, maxCachedSessions: 0 });
  }

  override createConnection(options: RequestOptions, callback?: (error: Error | null, stream: Duplex) => void) {
    const socket = connect({ ...(options as ConnectionOptions), rejectUnauthorized: false });
    const failed = (error: Error) => {
      socket.destroy();
      callback?.(error, socket);
    };
    socket.once("error", failed);
    socket.once("secureConnect", () => {
      socket.off("error", failed);
      const fingerprint = socket.getPeerX509Certificate()?.fingerprint256 ?? null;
      if (this.pin === null || fingerprint !== this.pin) {
        failed(new RouterCertificateChanged());
        return;
      }
      callback?.(null, socket);
    });
    return undefined;
  }
}

// Fields a router may leave out are left optional, and what does not fit is passed over, not fatal.
const clientSchema = z.object({
  mac: z.string(),
  name: z.string().optional(),
  hostname: z.string().optional(),
  oui: z.string().optional(),
  network: z.string().optional(),
  essid: z.string().optional(),
  ip: z.string().optional(),
  is_wired: z.boolean().optional(),
  ap_mac: z.string().optional(),
  sw_mac: z.string().optional(),
  sw_port: z.number().optional(),
  signal: z.number().optional(),
  radio: z.string().optional(),
  rx_bytes: z.number().optional(),
  tx_bytes: z.number().optional(),
  "wired-rx_bytes": z.number().optional(),
  "wired-tx_bytes": z.number().optional(),
});
const deviceSchema = z.object({
  mac: z.string(),
  type: z.string().optional(),
  name: z.string().optional(),
  model: z.string().optional(),
  version: z.string().optional(),
  upgradable: z.boolean().optional(),
  upgrade_to_firmware: z.string().optional(),
  uplink: z.object({ uplink_mac: z.string().optional() }).loose().optional(),
  port_table: z
    .array(z.object({ port_idx: z.number(), speed: z.number().optional(), up: z.boolean().optional() }).loose())
    .optional(),
});
const healthSchema = z
  .object({
    subsystem: z.string(),
    status: z.string().optional(),
    wan_ip: z.string().optional(),
    latency: z.number().optional(),
    "rx_bytes-r": z.number().optional(),
    "tx_bytes-r": z.number().optional(),
    xput_down: z.number().optional(),
    xput_up: z.number().optional(),
    speedtest_ping: z.number().optional(),
    speedtest_lastrun: z.number().optional(),
  })
  .loose();
const ruleSchema = z
  .object({ name: z.string().optional(), enabled: z.boolean().optional(), action: z.string().optional() })
  .loose();
const forwardSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    dst_port: z.string().optional(),
    fwd: z.string().optional(),
    fwd_port: z.string().optional(),
  })
  .loose();

const BAND_OF_RADIO: Record<string, string> = { ng: "2.4", na: "5", "6e": "6" };

function kindOfDevice(type: string | undefined): RouterDeviceKind {
  if (type === "usw") return ROUTER_DEVICE_KIND.switch;
  return type === "uap" ? ROUTER_DEVICE_KIND.accessPoint : ROUTER_DEVICE_KIND.router;
}

const each = <Item>(schema: z.ZodType<Item>, rows: unknown): Item[] => {
  if (!Array.isArray(rows)) throw new Error("The router's answer changed: expected a list.");
  return rows.flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
};

/**
 * UniFi OS, through the API its own dashboard uses, as a local read-only user. **The one guard:** `send` refuses any
 * write but signing in and, where the router lets this user, starting a speed test.
 * ponytail: site "default" only; a controller with several sites shows the first. Add a choice if one turns up.
 */
export class UnifiAdapter implements RouterAdapter {
  private readonly agent: PinningAgent;
  private cookie: string | null = null;
  private csrf: string | null = null;

  constructor(private readonly connection: { url: string; username: string; password: string; pin: string | null }) {
    this.agent = new PinningAgent(connection.pin);
  }

  private send(
    method: "GET" | "POST",
    path: string,
    body?: object,
  ): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
    const isSpeedTest = path === SPEED_TEST_PATH && (body as { cmd?: string } | undefined)?.cmd === SPEED_TEST_COMMAND;
    if (method !== "GET" && path !== LOGIN_PATH && !isSpeedTest) {
      return Promise.reject(new Error(`Autoheal only reads from the router: refused ${method} ${path}`));
    }
    const target = new URL(path, this.connection.url);
    const payload = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = httpsRequest(
        target,
        {
          method,
          agent: this.agent,
          timeout: REQUEST_TIMEOUT_MILLISECONDS,
          headers: {
            accept: "application/json",
            ...(payload === null ? {} : { "content-type": "application/json" }),
            ...(this.cookie === null ? {} : { cookie: this.cookie }),
            ...(this.csrf === null || method === "GET" ? {} : { [CSRF_HEADER]: this.csrf }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              text: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          response.on("error", reject);
        },
      );
      request.on("timeout", () => request.destroy(new Error("The router took too long to answer.")));
      request.on("error", reject);
      request.end(payload ?? undefined);
    });
  }

  private async login() {
    const { username, password } = this.connection;
    const answer = await this.send("POST", LOGIN_PATH, { username, password, rememberMe: true });
    if (answer.status < STATUS_OK_FROM || answer.status > STATUS_OK_TO) throw new RouterLoginRefused();
    const setCookie = answer.headers["set-cookie"] ?? [];
    this.cookie = [setCookie]
      .flat()
      .map((line) => line.split(";")[0])
      .join("; ");
    const csrf = answer.headers[CSRF_HEADER];
    this.csrf = typeof csrf === "string" ? csrf : null;
  }

  // Once more after a session ends. A refused login stops there: failures may lock the account.
  private async read(path: string): Promise<unknown> {
    if (this.cookie === null) await this.login();
    let answer = await this.send("GET", path);
    if (answer.status === STATUS_UNAUTHORIZED) {
      await this.login();
      answer = await this.send("GET", path);
    }
    if (answer.status < STATUS_OK_FROM || answer.status > STATUS_OK_TO) {
      throw new Error(`The router answered ${answer.status} for ${path}`);
    }
    const parsed = JSON.parse(answer.text) as { data?: unknown };
    return parsed.data ?? parsed;
  }

  async clients(): Promise<RouterClient[]> {
    return each(clientSchema, await this.read(`${API}/stat/sta`)).map((client) => {
      const wired = client.is_wired === true;
      return {
        mac: client.mac.toLowerCase(),
        // An empty name is common here, so || rather than ??.
        name: client.name || client.hostname || client.oui || client.mac,
        network: client.essid ?? client.network ?? null,
        ip: client.ip ?? null,
        wired,
        uplinkMac: (wired ? client.sw_mac : client.ap_mac)?.toLowerCase() ?? null,
        uplinkPort: client.sw_port ?? null,
        signal: client.signal ?? null,
        band: BAND_OF_RADIO[client.radio ?? ""] ?? null,
        received: (wired ? client["wired-rx_bytes"] : undefined) ?? client.rx_bytes ?? 0,
        sent: (wired ? client["wired-tx_bytes"] : undefined) ?? client.tx_bytes ?? 0,
      };
    });
  }

  async devices(): Promise<RouterDevice[]> {
    return each(deviceSchema, await this.read(`${API}/stat/device`)).map((device) => ({
      mac: device.mac.toLowerCase(),
      name: device.name ?? device.model ?? device.mac,
      kind: kindOfDevice(device.type),
      model: device.model ?? null,
      version: device.version ?? null,
      upgradeTo: device.upgradable === true ? (device.upgrade_to_firmware ?? "") : null,
      uplinkMac: device.uplink?.uplink_mac?.toLowerCase() ?? null,
      ports: (device.port_table ?? []).map(({ port_idx, speed, up }) => ({
        index: port_idx,
        speedMbps: speed ?? 0,
        up: up === true,
      })),
    }));
  }

  async internet(): Promise<InternetHealth> {
    const subsystems = each(healthSchema, await this.read(`${API}/stat/health`));
    const lines = subsystems.filter(({ subsystem }) => /^wan\d*$/.test(subsystem));
    const wan = lines[0];
    const www = subsystems.find(({ subsystem }) => subsystem === "www");
    const rate = (wan?.["rx_bytes-r"] ?? 0) + (wan?.["tx_bytes-r"] ?? 0);
    const lastRun = www?.speedtest_lastrun ?? 0;
    return {
      lines: lines.map((line, index) => ({
        wan: line.subsystem.toUpperCase(),
        up: line.status === "ok",
        latency: index === 0 ? (www?.latency ?? null) : null,
      })),
      publicAddress: wan?.wan_ip ?? null,
      busyMbps: wan === undefined ? null : (rate * 8) / BITS_PER_MEGABIT,
      lastTest:
        lastRun > 0 && www !== undefined
          ? {
              at: lastRun * MILLISECONDS_IN_SECOND,
              downMbps: www.xput_down ?? 0,
              upMbps: www.xput_up ?? 0,
              ping: www.speedtest_ping ?? null,
            }
          : null,
    };
  }

  async exposure(): Promise<ExposureSnapshot | null> {
    const [rules, forwards] = await Promise.all([
      this.read(`${API}/rest/firewallrule`).catch(() => null),
      this.read(`${API}/rest/portforward`).catch(() => null),
    ]);
    if (rules === null && forwards === null) return null;
    return {
      rules: each(ruleSchema, rules ?? []).map((rule) => ({
        name: rule.name ?? "",
        detail: `${rule.enabled === false ? "off" : "on"} ${rule.action ?? ""}`.trim(),
      })),
      forwards: each(forwardSchema, forwards ?? []).map((forward) => ({
        name: forward.name ?? "",
        detail: `${forward.dst_port ?? ""} to ${forward.fwd ?? ""}:${forward.fwd_port ?? ""}${forward.enabled === false ? " (off)" : ""}`,
      })),
    };
  }

  async startSpeedTest(): Promise<boolean> {
    const answer = await this.send("POST", SPEED_TEST_PATH, { cmd: SPEED_TEST_COMMAND });
    return !STATUS_REFUSED.has(answer.status) && answer.status >= STATUS_OK_FROM && answer.status <= STATUS_OK_TO;
  }

  /** Tries every read, once, and says what each found and what the router is: what a person is shown before saving. */
  async capabilities(): Promise<RouterProbeView> {
    const trying = async (capability: RouterCapability, work: () => Promise<string>) => {
      try {
        return { capability, works: true, detail: await work() };
      } catch (error) {
        if (error instanceof RouterLoginRefused || error instanceof RouterCertificateChanged) throw error;
        return { capability, works: false, detail: describeError(error) };
      }
    };
    const found: { router?: RouterDevice } = {};
    const capabilities = [
      await trying(ROUTER_CAPABILITY.clients, async () => String((await this.clients()).length)),
      await trying(ROUTER_CAPABILITY.devices, async () => {
        const devices = await this.devices();
        found.router = devices.find(({ kind }) => kind === ROUTER_DEVICE_KIND.router);
        return devices.map(({ name, version }) => `${name} ${version ?? ""}`.trim()).join(", ");
      }),
      await trying(ROUTER_CAPABILITY.internet, async () => {
        const { lines } = await this.internet();
        return String(lines.length);
      }),
      await trying(ROUTER_CAPABILITY.exposure, async () => {
        const seen = await this.exposure();
        if (seen === null) throw new Error("This user cannot read the rules.");
        return `${seen.rules.length},${seen.forwards.length}`;
      }),
    ];
    return { name: found.router?.name ?? null, version: found.router?.version ?? null, capabilities };
  }
}
