import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { vi } from "vitest";
import {
  API_ROUTES,
  type DataView,
  type IntegrationView,
  type OllamaSettingsView,
  type SelfUpdateView,
  type SessionView,
  type SettingsView,
  type TrustedProxiesView,
} from "../../../src/shared/api.js";
import { MILLISECONDS_PER_DAY } from "../../../src/shared/constants.js";
import { MILLISECONDS_PER_HOUR, PATHS, SESSION_QUERY_KEY, TEXT } from "../constants.js";
import { SettingsPage } from "../pages/settings-page.js";

// The settings page in tests: what the dashboard answers for an admin or a viewer, and showing the page.
export const sessionFor = (role: "admin" | "viewer"): SessionView => ({
  user: { id: "u1", username: role, role, mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
});

// As the test instance had it: npm reaches the dashboard through Docker's port relay, not yet trusted.
export const RELAY = "172.19.0.1";
export const BROWSER = "192.168.10.20";
export const untrusted: TrustedProxiesView = {
  source: null,
  addresses: [],
  peer: RELAY,
  forwardedFor: BROWSER,
  seenAs: RELAY,
};

export const settings: SettingsView = {
  version: "2.0.0",
  publicBaseUrl: "https://autoheal.example",
  trustedProxies: untrusted,
  offboxBackupsConfigured: false,
  certificate: "operator",
  backupPassphrase: "operator",
  runnerAddress: "https://autoheal.example:9443",
};

export const fromEnvironment = { url: "http://192.168.10.178:30271", model: "qwen3:30b-a3b", contextTokens: 16384 };
export const ollamaSettings = (overrides: Partial<OllamaSettingsView> = {}): OllamaSettingsView => ({
  source: "environment",
  ...fromEnvironment,
  plainHttp: true,
  fromEnvironment,
  ...overrides,
});

export const integration = (overrides: Partial<IntegrationView>): IntegrationView => ({
  kind: "gotify",
  source: null,
  url: null,
  topic: null,
  format: null,
  tokenSet: false,
  plainHttp: false,
  ...overrides,
});

export const INTEGRATIONS = [
  integration({ kind: "gotify", source: "dashboard", url: "https://gotify.example", tokenSet: true }),
  integration({ kind: "ntfy" }),
  integration({ kind: "homeAssistant" }),
];

export const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

// The database: two kinds of record, cleaned up three hours ago.
export const DATA: DataView = {
  bytes: 13 * 1024 * 1024,
  kinds: [
    { kind: "jobs", rows: 1234, keptMilliseconds: 90 * MILLISECONDS_PER_DAY },
    { kind: "auditEvents", rows: 9876, keptMilliseconds: null },
  ],
  lastSweep: { at: Date.now() - 3 * MILLISECONDS_PER_HOUR, removed: 120 },
};

export const words = TEXT.settingsPage.selfUpdate;
export const RUNNING_IMAGE = `sha256:${"a".repeat(64)}`;
export const selfUpdate: SelfUpdateView = {
  unavailable: null,
  recoveryBlocked: null,
  runningImage: RUNNING_IMAGE,
  runningSince: Date.now() - 20 * 60 * 1000,
  reference: "ghcr.io/owner/autoheal:2",
  last: null,
};

// GET answers by path, other methods by "METHOD path".
export function serve(role: "admin" | "viewer", extra: Record<string, unknown> = {}) {
  const answers: Record<string, unknown> = {
    [API_ROUTES.session]: sessionFor(role),
    [API_ROUTES.settings]: settings,
    [API_ROUTES.integrations]: INTEGRATIONS,
    [API_ROUTES.ollamaSettings]: ollamaSettings(),
    [API_ROUTES.ollamaServers]: { extras: [], reviewServerId: null, defaultName: null },
    [API_ROUTES.hosts]: [],
    [API_ROUTES.registryCredentials]: [],
    [API_ROUTES.imageTrust]: { publishers: [], rules: [], revision: 0 },
    [`POST ${API_ROUTES.ollamaSettingsModels}`]: [
      { name: "qwen3:30b-a3b", sizeBytes: 19_000_000_000, parameterSize: "30B", quantization: "Q4_K_M", loaded: false },
      { name: "qwen3:4b", sizeBytes: 2_500_000_000, parameterSize: "4B", quantization: "Q4_K_M", loaded: true },
    ],
    [API_ROUTES.ollama]: {
      reachable: true,
      checkedAt: Date.now(),
      error: null,
      version: "0.12.6",
      model: "qwen3:30b-a3b",
      modelPresent: true,
      facts: { answers: true, thinks: true, contextLength: 262_144 },
      models: [
        { name: "qwen3:30b-a3b", sizeBytes: 1, parameterSize: null, quantization: null },
        { name: "qwen3:4b", sizeBytes: 1, parameterSize: null, quantization: null },
      ],
      loaded: [],
    },
    [API_ROUTES.hostUpdateSettings]: { securityInWindow: true, windowStart: "03:00", windowEnd: "05:00" },
    [`PUT ${API_ROUTES.hostUpdateSettings}`]: { securityInWindow: false, windowStart: "03:00", windowEnd: "05:00" },
    [API_ROUTES.backups]: [],
    [API_ROUTES.dataHousekeeping]: DATA,
    [API_ROUTES.users]: [{ id: "u1", username: "admin", role: "admin" }],
    [API_ROUTES.widgetKeys]: [
      { id: "k1", name: "homepage", scope: "widget", hint: "abcd", createdBy: "admin", createdAt: 1, lastUsedAt: null },
    ],
    [API_ROUTES.sshKeys]: [],
    [API_ROUTES.selfUpdate]: selfUpdate,
    ...extra,
  };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split("?")[0]!;
    const method = init?.method ?? "GET";
    const answer = method === "GET" ? answers[path] : answers[`${method} ${path}`];
    return json(answer ?? {});
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

export function renderSettings(role: "admin" | "viewer") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(SESSION_QUERY_KEY, sessionFor(role));
  const router = createMemoryRouter([{ path: PATHS.settings, element: <SettingsPage /> }], {
    initialEntries: [PATHS.settings],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

export const sent = (fetch: ReturnType<typeof serve>, method: string, path: string) =>
  fetch.mock.calls
    .filter(([url, init]) => url === path && init?.method === method)
    .map(([, init]) => JSON.parse(String(init?.body ?? "null")));
