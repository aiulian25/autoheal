import type { EnrolledHostView } from "../../src/shared/api.js";
import { decodeJoinCode } from "../../src/shared/join-code.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import type { HomeAssistantSettings } from "../../src/config/shared-settings.js";
import type { BackupSettings } from "../../src/control-plane/backups/backup-service.js";
import { CSRF_HEADER, API_ROUTES, type SessionView } from "../../src/shared/api.js";
import { IN_MEMORY_DATABASE, SESSION_COOKIE_NAME } from "../../src/shared/constants.js";
import { buildRunnerServer } from "../../src/control-plane/runner-api/runner-server.js";
import { AuditLog } from "../../src/control-plane/audit/audit-log.js";
import { ensureFirstAdmin } from "../../src/control-plane/auth/bootstrap.js";
import { DatabaseHandle } from "../../src/control-plane/database/connection.js";
import { buildUserInterfaceServer, type StaticSettingsView } from "../../src/control-plane/server.js";
import {
  createControlPlaneServices,
  type ControlPlaneServices,
  type ServiceSettings,
} from "../../src/control-plane/services.js";

export const PUBLIC_HOST = "autoheal.test";
export const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
export const TRUSTED_PROXY = "10.0.0.1";

export interface TestControlPlane {
  app: FastifyInstance;
  runnerApp: FastifyInstance;
  services: ControlPlaneServices;
  stdout: string[];
  clock: { now: number };
  client: () => TestClient;
  firstAdminPassword: () => Promise<string>;
}

const TEST_SETTINGS: StaticSettingsView = {
  version: "2.0.0",
  publicBaseUrl: PUBLIC_ORIGIN,
  offboxBackupsConfigured: false,
  certificate: "autoheal",
  backupPassphrase: "operator",
};

export const TEST_BACKUP_PASSPHRASE = "test-backup-passphrase-0123456789abcdef";

export interface TestControlPlaneOptions {
  extendApp?: (app: FastifyInstance) => void;
  ollamaUrl?: string;
  webAssetsDirectory?: string | null;
  backups?: Partial<BackupSettings>;
  databasePath?: string;
  homeAssistant?: HomeAssistantSettings;
  // A backup passphrase Autoheal made, which the first admin is shown once.
  generatedBackupPassphrase?: string;
  // The proxies the .env trusts; an empty list leaves them to Settings.
  trustedProxyAddresses?: string[];
  // The certificate's key and the runner API's address, for SSH hosts' runners.
  runners?: ServiceSettings["runners"];
}

/** The real dashboard server on an in-memory database with a controllable clock. */
export async function startTestControlPlane({
  extendApp = () => {},
  ollamaUrl = "https://localhost:1",
  webAssetsDirectory = null,
  backups = {},
  databasePath = IN_MEMORY_DATABASE,
  homeAssistant,
  generatedBackupPassphrase,
  trustedProxyAddresses = [TRUSTED_PROXY],
  runners,
}: TestControlPlaneOptions = {}): Promise<TestControlPlane> {
  const clock = { now: Date.UTC(2026, 9, 20, 12) };
  const stdout: string[] = [];
  const databaseHandle = new DatabaseHandle(databasePath);
  const auditLog = new AuditLog(databaseHandle, (line) => stdout.push(line));
  const services = createControlPlaneServices(databaseHandle, auditLog, {
    ollama: { url: ollamaUrl, model: "qwen3:4b-instruct", contextTokens: 16_384 },
    backups: {
      dataDirectory: mkdtempSync(join(tmpdir(), "autoheal-data-")),
      offboxBackupDirectory: null,
      backupPassphrase: TEST_BACKUP_PASSPHRASE,
      ...backups,
    },
    integrations: { homeAssistant: homeAssistant ?? null },
    trustedProxyAddresses,
    ...(runners === undefined ? {} : { runners }),
    generatedBackupPassphrase: generatedBackupPassphrase ?? null,
    homeAssistantTiming: {
      firstRetryMilliseconds: 10,
      longestRetryMilliseconds: 20,
      registryRefreshMilliseconds: 60_000,
      registrySettleMilliseconds: 10,
    },
    clock: () => clock.now,
  });
  const app = await buildUserInterfaceServer({
    publicHost: PUBLIC_HOST,
    publicOrigin: PUBLIC_ORIGIN,
    tls: null,
    services,
    settings: TEST_SETTINGS,
    webAssetsDirectory,
  });
  extendApp(app);
  await app.ready();
  const runnerApp = await buildRunnerServer(null, services);
  await runnerApp.ready();
  return {
    app,
    runnerApp,
    services,
    stdout,
    clock,
    client: () => new TestClient(app),
    firstAdminPassword: async () => {
      let password = "";
      await ensureFirstAdmin(
        databaseHandle,
        auditLog,
        "admin",
        (message) => {
          password = /one-time password (\S+)/.exec(message)![1]!;
        },
        () => clock.now,
      );
      return password;
    },
  };
}

/** A browser stand-in: keeps the session cookie and sends Origin and the CSRF token like the dashboard. */
const sessionCookieOf = (response: LightMyRequestResponse) =>
  response.cookies.find((candidate) => candidate.name === SESSION_COOKIE_NAME);

export class TestClient {
  sessionToken: string | null = null;
  csrfToken: string | null = null;

  constructor(private readonly app: FastifyInstance) {}

  async request(options: InjectOptions): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = { host: PUBLIC_HOST, origin: PUBLIC_ORIGIN };
    if (this.sessionToken !== null) {
      headers.cookie = `${SESSION_COOKIE_NAME}=${this.sessionToken}`;
    }
    if (this.csrfToken !== null) {
      headers[CSRF_HEADER] = this.csrfToken;
    }
    const response = await this.app.inject({
      ...options,
      headers: { ...headers, ...(options.headers as Record<string, string>) },
    });
    // A new session cookie replaces the old one, as in a browser: from signing in, or from the second step. A cleared
    // one is not followed, so a test can show that the server itself ended the session.
    const issued = sessionCookieOf(response);
    if (issued !== undefined && issued.value !== "") {
      this.sessionToken = issued.value;
    }
    return response;
  }

  get(url: string) {
    return this.request({ method: "GET", url });
  }

  post(url: string, payload?: object) {
    return this.request({ method: "POST", url, payload });
  }

  put(url: string, payload: object) {
    return this.request({ method: "PUT", url, payload });
  }

  patch(url: string, payload: object) {
    return this.request({ method: "PATCH", url, payload });
  }

  delete(url: string) {
    return this.request({ method: "DELETE", url });
  }

  async signIn(username: string, password: string): Promise<LightMyRequestResponse> {
    return this.keepSession(await this.post(API_ROUTES.login, { username, password }));
  }

  /** Keeps the CSRF token a sign-in answer gave, as the dashboard does: a password's, or a passkey's. */
  keepSession(response: LightMyRequestResponse): LightMyRequestResponse {
    if (response.statusCode === 200 && sessionCookieOf(response) !== undefined) {
      this.csrfToken = response.json<SessionView>().csrfToken;
    }
    return response;
  }
}

/** The runner token inside an enrolment's join code, as the runner itself reads it. */
export const runnerTokenOf = (enrolled: EnrolledHostView) => decodeJoinCode(enrolled.joinCode)!.token;
