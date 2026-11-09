import { z } from "zod";
import { API_ERRORS } from "../../shared/api.js";
import { AUDIT_ACTIONS, SETTING_KEYS, TARGET_INTEGRATION } from "../../shared/constants.js";
import type {
  RouterCertificateView,
  RouterContract,
  RouterProbeView,
  RouterSettingsBody,
} from "../../shared/network.js";
import { routerContractBodySchema } from "../../shared/network.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { SecretBox } from "../database/secret-box.js";
import { DomainError } from "../domain-error.js";
import type { SettingsStore } from "../settings/settings-store.js";
import { RouterCertificateChanged, RouterLoginRefused, type RouterAdapter } from "./router-adapter.js";
import { UnifiAdapter, routerCertificate } from "./unifi-adapter.js";

const storedSchema = z.object({
  kind: z.string(),
  url: z.string(),
  username: z.string(),
  password: z.string(),
  pin: z.string().nullable(),
});
type Stored = z.infer<typeof storedSchema>;
const TARGET = { kind: TARGET_INTEGRATION, id: "router" } as const;

function asDomainError(error: unknown): DomainError {
  if (error instanceof RouterLoginRefused) return new DomainError(API_ERRORS.routerLoginRefused);
  if (error instanceof RouterCertificateChanged) return new DomainError(API_ERRORS.routerCertificateChanged);
  return new DomainError(API_ERRORS.routerUnreachable);
}

/** The router Autoheal reads. Its password is sealed, is never given back, and never follows a changed address. */
export class RouterSettingsService {
  private cached: { key: string; adapter: RouterAdapter } | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly store: SettingsStore,
    private readonly secretBox: SecretBox,
    private readonly auditLog: AuditLog,
    // For a test's router, or another kind.
    private readonly makeAdapter: (connection: {
      url: string;
      username: string;
      password: string;
      pin: string | null;
    }) => RouterAdapter = (connection) => new UnifiAdapter(connection),
    private readonly readCertificate: (url: string) => Promise<string> = routerCertificate,
  ) {}

  private stored(): Stored | null {
    return this.store.read(SETTING_KEYS.router, storedSchema);
  }

  contract(): RouterContract | null {
    return this.store.read(SETTING_KEYS.routerContract, routerContractBodySchema);
  }

  saveContract(actor: Actor, contract: RouterContract) {
    this.store.write(SETTING_KEYS.routerContract, contract);
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.routerSaved, TARGET, { ...contract });
    this.changed();
  }

  view() {
    const stored = this.stored();
    return {
      configured: stored !== null,
      kind: stored?.kind ?? null,
      url: stored?.url ?? null,
      username: stored?.username ?? null,
      certificate: stored?.pin?.slice(0, 11) ?? null,
      contract: this.contract(),
    };
  }

  /** The working connection, or null with none set up or a password that will not open. */
  adapter(): RouterAdapter | null {
    const stored = this.stored();
    if (stored === null || stored.pin === null) return null;
    const key = JSON.stringify(stored);
    if (this.cached?.key === key) return this.cached.adapter;
    const password = this.secretBox.open(stored.password);
    if (password === null) return null;
    const adapter = this.makeAdapter({ url: stored.url, username: stored.username, password, pin: stored.pin });
    this.cached = { key, adapter };
    return adapter;
  }

  routerHost(): string | null {
    const stored = this.stored();
    return stored === null ? null : new URL(stored.url).hostname;
  }

  private connectionFor(body: RouterSettingsBody) {
    const stored = this.stored();
    const sameAddress = stored?.url === body.url;
    const kept = sameAddress && stored !== null ? this.secretBox.open(stored.password) : null;
    const password = body.password ?? kept;
    if (password === null) throw new DomainError(API_ERRORS.routerLoginRefused);
    // An approval is held to its address by being checked against whatever answers there, before anything is sent.
    const pin = body.trustedCertificate ?? (sameAddress ? (stored?.pin ?? null) : null);
    if (pin === null) throw new DomainError(API_ERRORS.routerCertificateUnconfirmed);
    return { url: body.url, username: body.username, password, pin };
  }

  /** What an address shows, for a person to compare with the router's own settings. Sends it nothing. */
  async certificateAt(url: string): Promise<RouterCertificateView> {
    try {
      return { url, fingerprint: await this.readCertificate(url) };
    } catch {
      throw new DomainError(API_ERRORS.routerUnreachable);
    }
  }

  /** Signs in and tries every read, changing nothing, so a person sees what this router can do. */
  async probe(body: RouterSettingsBody): Promise<RouterProbeView> {
    const adapter = this.makeAdapter(this.connectionFor(body));
    try {
      return await adapter.capabilities();
    } catch (error) {
      throw asDomainError(error);
    }
  }

  /** Stored only once it signs in and reads, held from now on to the certificate that was approved. */
  async save(actor: Actor, body: RouterSettingsBody) {
    const connection = this.connectionFor(body);
    const adapter = this.makeAdapter(connection);
    try {
      await adapter.clients();
    } catch (error) {
      throw asDomainError(error);
    }
    this.store.write(SETTING_KEYS.router, {
      kind: body.kind,
      url: body.url,
      username: body.username,
      password: this.secretBox.seal(connection.password),
      pin: connection.pin,
    });
    this.cached = null;
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.routerSaved, TARGET, {
      url: body.url,
      username: body.username,
      certificate: connection.pin,
    });
    this.changed();
  }

  remove(actor: Actor) {
    this.store.remove(SETTING_KEYS.router);
    this.cached = null;
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.routerRemoved, TARGET);
    this.changed();
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
  }

  private changed() {
    this.listeners.forEach((listener) => listener());
  }
}
