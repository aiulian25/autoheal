import { z } from "zod";
import type {
  GotifySettings,
  HomeAssistantSettings,
  NtfySettings,
  WebhookSettings,
} from "../../config/shared-settings.js";
import { API_ERRORS, type IntegrationView } from "../../shared/api.js";
import {
  AUDIT_ACTIONS,
  HIDDEN_ADDRESS_REST,
  INTEGRATION_KIND,
  INTEGRATION_KINDS,
  INTEGRATION_SOURCES,
  INTEGRATION_TOKEN_REQUIRED,
  PLAIN_HTTP_PROTOCOL,
  SETTING_KEYS,
  TARGET_INTEGRATION,
  WEBHOOK_FORMATS,
  type IntegrationKind,
  type IntegrationSource,
  type WebhookFormat,
} from "../../shared/constants.js";
import type { Actor, AuditLog } from "../audit/audit-log.js";
import type { SecretBox } from "../database/secret-box.js";
import { DomainError } from "../domain-error.js";
import type { SettingsStore } from "./settings-store.js";

/** One integration, whichever it is: ntfy alone has a topic, a webhook alone a format. */
interface Stored {
  url: string;
  topic: string | null;
  token: string | null;
  format: WebhookFormat | null;
}

const storedSchema = z.object({
  url: z.string(),
  topic: z.string().nullable(),
  token: z.string().nullable(),
  format: z.enum(WEBHOOK_FORMATS).nullable().default(null),
});

// Discord and Slack put a webhook's key in its address, so the address is kept sealed and shown up to its host.
const isSecretAddress = (kind: IntegrationKind) => kind === INTEGRATION_KIND.webhook;
const shownAddress = (kind: IntegrationKind, url: string) =>
  isSecretAddress(kind) ? `${new URL(url).origin}${HIDDEN_ADDRESS_REST}` : url;

/** What the .env sets: it wins, and the dashboard may not change it. */
export interface IntegrationOverrides {
  gotify: GotifySettings | null;
  ntfy: NtfySettings | null;
  homeAssistant: HomeAssistantSettings | null;
}

export interface IntegrationRequest {
  url: string;
  // ntfy only.
  topic?: string;
  // Left out to keep the stored one, which only an unchanged address keeps.
  token?: string;
  // A webhook only.
  format?: WebhookFormat;
}

function sourceOf(fromEnvironment: Stored | null, fromDashboard: Stored | null): IntegrationSource | null {
  if (fromEnvironment !== null) {
    return INTEGRATION_SOURCES.environment;
  }
  return fromDashboard === null ? null : INTEGRATION_SOURCES.dashboard;
}

/**
 * Notification channels and Home Assistant, set in Settings unless the .env sets them. Tokens go in
 * and are used, never shown again, and are kept sealed. A token never follows a changed address: whoever
 * moves a channel to another server must give its token again, so a session left open cannot send it elsewhere.
 */
export class IntegrationsService {
  private readonly environment: Record<IntegrationKind, Stored | null>;
  private readonly listeners = new Set<(kind: IntegrationKind) => void>();

  constructor(
    private readonly store: SettingsStore,
    private readonly auditLog: AuditLog,
    overrides: IntegrationOverrides,
    private readonly secretBox: SecretBox,
  ) {
    this.environment = {
      gotify: overrides.gotify && {
        url: overrides.gotify.url,
        topic: null,
        token: overrides.gotify.token,
        format: null,
      },
      ntfy: overrides.ntfy && {
        url: overrides.ntfy.url,
        topic: overrides.ntfy.topic,
        token: overrides.ntfy.token,
        format: null,
      },
      // Set in Settings only.
      webhook: null,
      homeAssistant: overrides.homeAssistant && {
        url: overrides.homeAssistant.url,
        topic: null,
        token: overrides.homeAssistant.token,
        format: null,
      },
    };
  }

  gotify(): GotifySettings | null {
    const current = this.current("gotify");
    return current?.token ? { url: current.url, token: current.token } : null;
  }

  ntfy(): NtfySettings | null {
    const current = this.current("ntfy");
    return current?.topic ? { url: current.url, topic: current.topic, token: current.token } : null;
  }

  homeAssistant(): HomeAssistantSettings | null {
    const current = this.current("homeAssistant");
    return current?.token ? { url: current.url, token: current.token } : null;
  }

  webhook(): WebhookSettings | null {
    const current = this.current("webhook");
    return current?.format ? { url: current.url, token: current.token, format: current.format } : null;
  }

  views(): IntegrationView[] {
    return INTEGRATION_KINDS.map((kind) => {
      const fromDashboard = this.opened(kind);
      const current = this.environment[kind] ?? fromDashboard;
      return {
        kind,
        source: sourceOf(this.environment[kind], fromDashboard),
        url: current === null ? null : shownAddress(kind, current.url),
        topic: current?.topic ?? null,
        format: current?.format ?? null,
        tokenSet: Boolean(current?.token),
        plainHttp: current !== null && new URL(current.url).protocol === PLAIN_HTTP_PROTOCOL,
      };
    });
  }

  isSet(kind: IntegrationKind): boolean {
    return this.current(kind) !== null;
  }

  save(actor: Actor, kind: IntegrationKind, request: IntegrationRequest) {
    this.refuseIfFromEnvironment(kind);
    const stored = this.opened(kind);
    const kept = stored !== null && stored.url === request.url ? stored.token : null;
    const token = request.token ?? kept;
    if (token === null && INTEGRATION_TOKEN_REQUIRED[kind]) {
      throw new DomainError(API_ERRORS.integrationTokenRequired);
    }
    this.store.write(SETTING_KEYS[kind], {
      url: isSecretAddress(kind) ? this.secretBox.seal(request.url) : request.url,
      topic: request.topic ?? null,
      token: token === null ? null : this.secretBox.seal(token),
      format: request.format ?? null,
    });
    this.auditLog.recordUserAction(
      actor,
      AUDIT_ACTIONS.integrationSaved,
      { kind: TARGET_INTEGRATION, id: kind },
      { url: shownAddress(kind, request.url) },
    );
    this.changed(kind);
  }

  remove(actor: Actor, kind: IntegrationKind) {
    this.refuseIfFromEnvironment(kind);
    this.store.remove(SETTING_KEYS[kind]);
    this.auditLog.recordUserAction(actor, AUDIT_ACTIONS.integrationRemoved, { kind: TARGET_INTEGRATION, id: kind });
    this.changed(kind);
  }

  /** Called with the integration's kind whenever the dashboard changes it. */
  onChange(listener: (kind: IntegrationKind) => void) {
    this.listeners.add(listener);
  }

  private current(kind: IntegrationKind): Stored | null {
    return this.environment[kind] ?? this.opened(kind);
  }

  // A token another backup passphrase sealed reads as missing, so Settings asks for it again; a webhook whose address
  // it sealed reads as not set up.
  private opened(kind: IntegrationKind): Stored | null {
    const stored = this.stored(kind);
    if (stored === null) {
      return null;
    }
    const url = isSecretAddress(kind) ? this.secretBox.open(stored.url) : stored.url;
    if (url === null) {
      return null;
    }
    return { ...stored, url, token: stored.token === null ? null : this.secretBox.open(stored.token) };
  }

  private stored(kind: IntegrationKind): Stored | null {
    return this.store.read(SETTING_KEYS[kind], storedSchema);
  }

  private refuseIfFromEnvironment(kind: IntegrationKind) {
    if (this.environment[kind] !== null) {
      throw new DomainError(API_ERRORS.integrationFromEnvironment);
    }
  }

  private changed(kind: IntegrationKind) {
    this.listeners.forEach((listener) => listener(kind));
  }
}
