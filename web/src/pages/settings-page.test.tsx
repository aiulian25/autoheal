import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_ROUTES,
  apiPath,
  type DataView,
  type IntegrationView,
  type OllamaSettingsView,
  type SelfUpdateView,
  type SessionView,
  type SettingsView,
  type TrustedProxiesView,
} from "../../../src/shared/api.js";
import { MILLISECONDS_PER_DAY, SELF_UPDATE_STATUS, SELF_UPDATE_TEXT } from "../../../src/shared/constants.js";
import { MILLISECONDS_PER_HOUR, PATHS, SESSION_QUERY_KEY, TEXT } from "../constants.js";
import { bytes, timeAgo, wholeNumber } from "../format.js";
import { SettingsPage } from "./settings-page.js";

const sessionFor = (role: "admin" | "viewer"): SessionView => ({
  user: { id: "u1", username: role, role, mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
});

// As the test instance had it: npm reaches the dashboard through Docker's port relay, not yet trusted.
const RELAY = "172.19.0.1";
const BROWSER = "192.168.10.20";
const untrusted: TrustedProxiesView = {
  source: null,
  addresses: [],
  peer: RELAY,
  forwardedFor: BROWSER,
  seenAs: RELAY,
};

const settings: SettingsView = {
  version: "2.0.0",
  publicBaseUrl: "https://autoheal.example",
  trustedProxies: untrusted,
  offboxBackupsConfigured: false,
  certificate: "operator",
  backupPassphrase: "operator",
  runnerAddress: "https://autoheal.example:9443",
};

const fromEnvironment = { url: "http://192.168.10.178:30271", model: "qwen3:30b-a3b", contextTokens: 16384 };
const ollamaSettings = (overrides: Partial<OllamaSettingsView> = {}): OllamaSettingsView => ({
  source: "environment",
  ...fromEnvironment,
  plainHttp: true,
  fromEnvironment,
  ...overrides,
});

const integration = (overrides: Partial<IntegrationView>): IntegrationView => ({
  kind: "gotify",
  source: null,
  url: null,
  topic: null,
  format: null,
  tokenSet: false,
  plainHttp: false,
  ...overrides,
});

const INTEGRATIONS = [
  integration({ kind: "gotify", source: "dashboard", url: "https://gotify.example", tokenSet: true }),
  integration({ kind: "ntfy" }),
  integration({ kind: "homeAssistant" }),
];

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

// The database: two kinds of record, cleaned up three hours ago.
const DATA: DataView = {
  bytes: 13 * 1024 * 1024,
  kinds: [
    { kind: "jobs", rows: 1234, keptMilliseconds: 90 * MILLISECONDS_PER_DAY },
    { kind: "auditEvents", rows: 9876, keptMilliseconds: null },
  ],
  lastSweep: { at: Date.now() - 3 * MILLISECONDS_PER_HOUR, removed: 120 },
};

const words = TEXT.settingsPage.selfUpdate;
const RUNNING_IMAGE = `sha256:${"a".repeat(64)}`;
const selfUpdate: SelfUpdateView = {
  unavailable: null,
  recoveryBlocked: null,
  runningImage: RUNNING_IMAGE,
  reference: "ghcr.io/owner/autoheal:2",
  last: null,
};

// GET answers by path, other methods by "METHOD path".
function serve(role: "admin" | "viewer", extra: Record<string, unknown> = {}) {
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

function renderSettings(role: "admin" | "viewer") {
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

const sent = (fetch: ReturnType<typeof serve>, method: string, path: string) =>
  fetch.mock.calls
    .filter(([url, init]) => url === path && init?.method === method)
    .map(([, init]) => JSON.parse(String(init?.body ?? "null")));

describe("the settings page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows administrators a repair notice and removes it after saving repaired settings", async () => {
    const fetch = serve("admin", {
      [API_ROUTES.settings]: { ...settings, invalidSettings: ["network.trusted_proxies"] },
    });
    const answer = fetch.getMockImplementation()!;
    let repaired = false;
    fetch.mockImplementation(async (url, init) => {
      if (url === API_ROUTES.trustedProxies && init?.method === "PUT") {
        repaired = true;
        return json({ ...untrusted, source: "dashboard", addresses: [RELAY], seenAs: BROWSER });
      }
      if (url === API_ROUTES.settings && repaired)
        return json({
          ...settings,
          trustedProxies: { ...untrusted, source: "dashboard", addresses: [RELAY], seenAs: BROWSER },
        });
      return answer(url, init);
    });
    renderSettings("admin");
    const notice = await screen.findByText(/Saved settings for trusted proxies could not be read/);
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain("Environment values or defaults are in use");
    expect(notice.textContent).toContain("verified configuration backup");
    const card = (await screen.findByRole("heading", { name: "Trusted proxies" })).closest("section")!;
    fireEvent.click(within(card).getByRole("button", { name: `Trust ${RELAY}` }));
    await waitFor(() => expect(screen.queryByText(/Saved settings for trusted proxies/)).toBeNull());
    expect(repaired).toBe(true);
  });

  it("shows administrators what the database holds and how long each kind is kept, and viewers nothing", async () => {
    serve("admin");
    renderSettings("admin");
    const words = TEXT.settingsPage.data;
    const line = [
      words.size(bytes(DATA.bytes)),
      `${words.cleaned} ${timeAgo(DATA.lastSweep!.at)}`,
      words.removed(wholeNumber(120)),
    ].join(TEXT.separator);
    expect(await screen.findByText(line)).toBeTruthy();
    const jobs = screen.getByText(`${words.kinds.jobs}${TEXT.separator}${words.window(90)}`).parentElement!;
    expect(within(jobs).getByText(wholeNumber(1234))).toBeTruthy();
    const audit = screen.getByText(`${words.kinds.auditEvents}${TEXT.separator}${words.keptWhole}`).parentElement!;
    expect(within(audit).getByText(wholeNumber(9876))).toBeTruthy();

    cleanup();
    serve("viewer");
    renderSettings("viewer");
    expect(await screen.findByRole("heading", { name: /Settings/ })).toBeTruthy();
    expect(screen.queryByText(words.explanation)).toBeNull();
  });

  it("does not show viewers administrator repair notices", async () => {
    serve("viewer", { [API_ROUTES.settings]: { ...settings, invalidSettings: ["integration.gotify"] } });
    renderSettings("viewer");
    await screen.findByRole("heading", { name: "Ollama" });
    expect(screen.queryByText(/Saved settings for Gotify could not be read/)).toBeNull();
  });

  it("says what Autoheal thinks with, and warns that Ollama is on plain http", async () => {
    serve("admin");
    renderSettings("admin");

    const ollama = (await screen.findByRole("heading", { name: "Ollama" })).closest("section")!;
    expect((await within(ollama).findAllByText("qwen3:30b-a3b")).length).toBeGreaterThan(0);
    expect(within(ollama).getByText("16,384 tokens")).toBeTruthy();
    expect(await within(ollama).findByText("no model · 2 available")).toBeTruthy();
    expect(within(ollama).getByText("thinks before it answers · reads up to 262,144 tokens")).toBeTruthy();
    expect(within(ollama).getByText("From the .env. Changing it here overrides it, without a restart.")).toBeTruthy();
    expect(within(ollama).getByText(/^Plain http\./)).toBeTruthy();
    const system = screen.getByRole("heading", { name: "System" }).closest("section")!;
    expect(within(system).getByText("Your own, from the .env")).toBeTruthy();
    expect(
      within(system).getByText(
        `Your request came through ${RELAY}, which says it is for ${BROWSER}. Autoheal does not take its word, so everyone who comes that way counts as ${RELAY}.`,
      ),
    ).toBeTruthy();
  });

  it("lists the models on that Ollama, and changes to one with a click", async () => {
    const fetch = serve("admin", { [`PUT ${API_ROUTES.ollamaSettings}`]: null });
    renderSettings("admin");
    const ollama = (await screen.findByRole("heading", { name: "Ollama" })).closest("section")!;
    const choice = await within(ollama).findByRole("radio", { name: /qwen3:4b/ });
    fireEvent.click(choice);
    await waitFor(() => expect(sent(fetch, "PUT", API_ROUTES.ollamaSettings)[0]).toMatchObject({ model: "qwen3:4b" }));
  });

  it("names the default without saving its address again", async () => {
    const fetch = serve("admin", {
      [`PUT ${API_ROUTES.ollamaDefaultName}`]: null,
      [`PUT ${API_ROUTES.ollamaSettings}`]: null,
    });
    renderSettings("admin");
    const ollama = (await screen.findByRole("heading", { name: "Ollama" })).closest("section")!;
    fireEvent.click(await within(ollama).findByRole("button", { name: "Change" }));
    fireEvent.change(await within(ollama).findByLabelText(/^Name/), { target: { value: "Mini" } });
    await within(ollama).findByRole("radio", { name: /qwen3:4b/ });
    fireEvent.click(within(ollama).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(sent(fetch, "PUT", API_ROUTES.ollamaDefaultName)).toEqual([{ name: "Mini" }]));
    await waitFor(() => expect(within(ollama).queryByRole("button", { name: "Save" })).toBeNull());
    expect(sent(fetch, "PUT", API_ROUTES.ollamaSettings)).toEqual([]);
  });

  it("only shows a viewer the models, with none to click", async () => {
    serve("viewer");
    renderSettings("viewer");
    const ollama = (await screen.findByRole("heading", { name: "Ollama" })).closest("section")!;
    expect(((await within(ollama).findByRole("radio", { name: /qwen3:4b/ })) as HTMLInputElement).disabled).toBe(true);
  });

  it("changes the Ollama Autoheal asks, with that server's models offered, and goes back to the .env's", async () => {
    const fetch = serve("admin", { [`PUT ${API_ROUTES.ollamaSettings}`]: null });
    renderSettings("admin");
    const ollama = (await screen.findByRole("heading", { name: "Ollama" })).closest("section")!;
    fireEvent.click(await within(ollama).findByRole("button", { name: "Change" }));
    fireEvent.click(await within(ollama).findByRole("radio", { name: /qwen3:4b/ }));
    fireEvent.change(within(ollama).getByLabelText(/^Context window/), { target: { value: "32768" } });
    fireEvent.click(within(ollama).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(sent(fetch, "PUT", API_ROUTES.ollamaSettings)).toEqual([
        { url: "http://192.168.10.178:30271", model: "qwen3:4b", contextTokens: 32768 },
      ]),
    );
    cleanup();

    const chosen = serve("admin", {
      [API_ROUTES.ollamaSettings]: ollamaSettings({ source: "dashboard", model: "qwen3:4b" }),
    });
    vi.stubGlobal("confirm", () => true);
    renderSettings("admin");
    const card = (await screen.findByRole("heading", { name: "Ollama" })).closest("section")!;
    expect(await within(card).findByText("Chosen here; the .env's is the fallback.")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Use the .env's" }));
    await waitFor(() =>
      expect(chosen).toHaveBeenCalledWith(API_ROUTES.ollamaSettings, expect.objectContaining({ method: "DELETE" })),
    );
  });

  it("trusts the proxy a request came through in one click, and adds and removes others", async () => {
    const fetch = serve("admin");
    // The server keeps what it is sent, and from then on counts a request through the relay as the browser's.
    const answer = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url, init) => {
      if (init?.method !== "PUT" || url !== API_ROUTES.trustedProxies) {
        return answer(url, init);
      }
      const { addresses } = JSON.parse(String(init.body)) as { addresses: string[] };
      const seenAs = addresses.includes(RELAY) ? BROWSER : RELAY;
      return json({ ...untrusted, source: "dashboard", addresses, seenAs });
    });
    renderSettings("admin");
    const card = (await screen.findByRole("heading", { name: "Trusted proxies" })).closest("section")!;

    fireEvent.click(within(card).getByRole("button", { name: `Trust ${RELAY}` }));
    expect(
      await within(card).findByText(
        `Your request came through ${RELAY}, a trusted proxy, so Autoheal counts it as from ${BROWSER}.`,
      ),
    ).toBeTruthy();
    expect(within(card).queryByRole("button", { name: `Trust ${RELAY}` })).toBeNull();

    fireEvent.change(within(card).getByLabelText("Add an address or a range"), { target: { value: " 10.0.0.0/24 " } });
    fireEvent.click(within(card).getByRole("button", { name: "Add" }));
    expect(await within(card).findByText("10.0.0.0/24")).toBeTruthy();
    fireEvent.click(within(card).getAllByRole("button", { name: "Remove" })[0]!);

    await waitFor(() =>
      expect(sent(fetch, "PUT", API_ROUTES.trustedProxies)).toEqual([
        { addresses: [RELAY] },
        { addresses: [RELAY, "10.0.0.0/24"] },
        { addresses: ["10.0.0.0/24"] },
      ]),
    );
  });

  it("shows the proxies the .env names, and leaves them to the .env", async () => {
    serve("admin", {
      [API_ROUTES.settings]: {
        ...settings,
        trustedProxies: { ...untrusted, source: "environment", addresses: [RELAY], seenAs: BROWSER },
      },
    });
    renderSettings("admin");
    const card = (await screen.findByRole("heading", { name: "Trusted proxies" })).closest("section")!;

    expect(
      within(card).getByText("The .env names these in TRUSTED_PROXY_ADDRESSES, so they can only be changed there."),
    ).toBeTruthy();
    expect(within(card).getByText(RELAY)).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Remove" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Add" })).toBeNull();
  });

  it("connects Home Assistant with its address and a token, which is never shown again", async () => {
    const fetch = serve("admin");
    renderSettings("admin");

    const card = (await screen.findByRole("heading", { name: "Home Assistant" })).closest("section")!;
    fireEvent.change(within(card).getByLabelText(/^Address/), { target: { value: "http://ha.local:8123" } });
    fireEvent.change(within(card).getByLabelText(/^Long-lived token/), { target: { value: "secret-token" } });
    fireEvent.click(within(card).getByRole("button", { name: "Connect" }));

    const path = apiPath(API_ROUTES.integration, { kind: "homeAssistant" });
    await waitFor(() =>
      expect(sent(fetch, "PUT", path)).toEqual([{ url: "http://ha.local:8123", token: "secret-token" }]),
    );
  });

  it("shows observed test acceptance and clears it when the channel configuration is saved again", async () => {
    const fetch = serve("admin");
    const base = fetch.getMockImplementation()!;
    let delivery = {
      status: "unknown" as "unknown" | "healthy",
      lastAttemptAt: null as number | null,
      lastSuccessAt: null as number | null,
      failureCode: null,
    };
    fetch.mockImplementation(async (url, init) => {
      if (url === apiPath(API_ROUTES.integrationTest, { kind: "gotify" }) && init?.method === "POST") {
        delivery = { status: "healthy", lastAttemptAt: Date.now(), lastSuccessAt: Date.now(), failureCode: null };
        return json({ problem: null, delivery });
      }
      if (url === apiPath(API_ROUTES.integration, { kind: "gotify" }) && init?.method === "PUT") {
        delivery = { status: "unknown", lastAttemptAt: null, lastSuccessAt: null, failureCode: null };
        return json(null);
      }
      if (url === API_ROUTES.integrations)
        return json(INTEGRATIONS.map((row) => (row.kind === "gotify" ? { ...row, delivery } : row)));
      return base(url, init);
    });
    renderSettings("admin");
    const row = (await screen.findByText("Gotify")).closest("li")!;
    expect(within(row).getByText("Configured; untested")).toBeTruthy();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    fireEvent.click(within(row).getByRole("button", { name: "Send a test" }));
    expect(await within(row).findByText(/^Last accepted by server/)).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Change" }));
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    expect(await within(row).findByText("Configured; untested")).toBeTruthy();
    expect(within(row).queryByText(/^Last accepted by server/)).toBeNull();
  });

  it("does not apply a delayed old test result after the channel has been edited", async () => {
    const fetch = serve("admin");
    const base = fetch.getMockImplementation()!;
    const unknown = { status: "unknown", lastAttemptAt: null, lastSuccessAt: null, failureCode: null };
    let finishTest!: (response: Response) => void;
    let finishRead!: (response: Response) => void;
    let holdReads = false;
    const rows = () => INTEGRATIONS.map((row) => (row.kind === "gotify" ? { ...row, delivery: unknown } : row));
    fetch.mockImplementation(async (url, init) => {
      if (url === apiPath(API_ROUTES.integrationTest, { kind: "gotify" }) && init?.method === "POST")
        return new Promise<Response>((resolve) => {
          finishTest = resolve;
        });
      if (url === API_ROUTES.integrations)
        return holdReads
          ? new Promise<Response>((resolve) => {
              finishRead = resolve;
            })
          : json(rows());
      return base(url, init);
    });
    renderSettings("admin");
    const row = (await screen.findByText("Gotify")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Send a test" }));
    await waitFor(() => expect(finishTest).toBeDefined());
    fireEvent.click(within(row).getByRole("button", { name: "Change" }));
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(row).queryByRole("button", { name: "Save" })).toBeNull());
    holdReads = true;
    await act(async () =>
      finishTest(
        json({ problem: null, delivery: { status: "healthy", lastAttemptAt: 1, lastSuccessAt: 1, failureCode: null } }),
      ),
    );
    await waitFor(() => expect(finishRead).toBeDefined());
    expect(within(row).queryByText(/^Last accepted by server/)).toBeNull();
    expect(within(row).getByText("Configured; untested")).toBeTruthy();
    await act(async () => finishRead(json(rows())));
  });

  it("tests and removes a channel that is set up, and sets one up that is not", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    const fetch = serve("admin");
    renderSettings("admin");

    const gotify = (await screen.findByText("Gotify")).closest("li")!;
    expect(within(gotify).getByText("https://gotify.example · token set")).toBeTruthy();
    fireEvent.click(within(gotify).getByRole("button", { name: "Send a test" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        apiPath(API_ROUTES.integrationTest, { kind: "gotify" }),
        expect.objectContaining({ method: "POST" }),
      ),
    );
    fireEvent.click(within(gotify).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        apiPath(API_ROUTES.integration, { kind: "gotify" }),
        expect.objectContaining({ method: "DELETE" }),
      ),
    );

    const ntfy = screen.getByText("ntfy").closest("li")!;
    expect(within(ntfy).getByText("Not set up")).toBeTruthy();
    fireEvent.click(within(ntfy).getByRole("button", { name: "Set up ntfy" }));
    expect(within(ntfy).getByLabelText(/^Topic/)).toBeTruthy();
  });

  it("sets up a webhook with its format, and shows its address only up to its host", async () => {
    const webhook = integration({
      kind: "webhook",
      source: "dashboard",
      url: "https://discord.com/…",
      format: "discord",
    });
    const fetch = serve("admin", { [API_ROUTES.integrations]: [...INTEGRATIONS, webhook] });
    renderSettings("admin");

    const row = (await screen.findByText("Webhook")).closest("li")!;
    expect(within(row).getByText("https://discord.com/… · Discord")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Change" }));
    // The address never comes back: its host stands in for it, and it is pasted again.
    const address = within(row).getByLabelText(/^Address/) as HTMLInputElement;
    expect([address.value, address.placeholder]).toEqual(["", "https://discord.com/…"]);
    const format = within(row).getByLabelText("Format") as HTMLSelectElement;
    expect(format.value).toBe("discord");
    expect((within(row).getByLabelText(/^Access token/) as HTMLInputElement).required).toBe(false);
    fireEvent.change(address, { target: { value: "https://hooks.slack.com/services/T/B/key" } });
    fireEvent.change(format, { target: { value: "slack" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(sent(fetch, "PUT", apiPath(API_ROUTES.integration, { kind: "webhook" }))).toEqual([
        { url: "https://hooks.slack.com/services/T/B/key", format: "slack" },
      ]),
    );
  });

  it("saves the package window's choice as soon as it changes", async () => {
    const fetch = serve("admin");
    renderSettings("admin");

    const tick = await screen.findByRole("checkbox", { name: /Install security fixes on their own/ });
    expect((tick as HTMLInputElement).checked).toBe(true);
    fireEvent.click(tick);

    await waitFor(() =>
      expect(sent(fetch, "PUT", API_ROUTES.hostUpdateSettings)).toEqual([
        { securityInWindow: false, windowStart: "03:00", windowEnd: "05:00" },
      ]),
    );
  });

  it("keeps both times when one is changed right after the other", async () => {
    const fetch = serve("admin");
    // The server keeps what it is sent, as the real one does.
    const answer = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url, init) =>
      init?.method === "PUT" ? json(JSON.parse(String(init.body))) : answer(url, init),
    );
    renderSettings("admin");

    const from = await screen.findByLabelText("From");
    const to = screen.getByLabelText("To");
    fireEvent.change(from, { target: { value: "01:00" } });
    fireEvent.blur(from);
    fireEvent.change(to, { target: { value: "02:00" } });
    fireEvent.blur(to);

    await waitFor(() =>
      expect(sent(fetch, "PUT", API_ROUTES.hostUpdateSettings)).toEqual([
        { securityInWindow: true, windowStart: "01:00", windowEnd: "05:00" },
        { securityInWindow: true, windowStart: "01:00", windowEnd: "02:00" },
      ]),
    );
  });

  it("says there is no off-box copy yet, and how to add one", async () => {
    serve("admin");
    renderSettings("admin");

    expect(await screen.findByText(/^No off-box copy yet\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add an off-box copy" }));
    expect(screen.getByText("OFFBOX_BACKUP_DIRECTORY")).toBeTruthy();
    expect(screen.getByRole("link", { name: "See all backups" }).getAttribute("href")).toBe(PATHS.backups);
  });

  it("lists who can sign in and the widget keys, and creates a key", async () => {
    const fetch = serve("admin", {
      [`POST ${API_ROUTES.widgetKeys}`]: {
        key: { id: "k2", name: "phone", scope: "widget", hint: "efgh" },
        secret: "the-secret",
      },
    });
    renderSettings("admin");

    expect((await screen.findByText("1 person")).closest("p")!.textContent).toBe("1 person · admin");
    const keys = screen.getByRole("heading", { name: "Widget and metrics keys" }).closest("section")!;
    expect(within(keys).getByText("homepage")).toBeTruthy();
    expect(within(keys).getByText("Homepage · never used")).toBeTruthy();
    fireEvent.change(within(keys).getByLabelText(/^New key name/), { target: { value: "phone" } });
    fireEvent.click(within(keys).getByRole("button", { name: "Create key" }));

    await waitFor(() =>
      expect(sent(fetch, "POST", API_ROUTES.widgetKeys)).toEqual([{ name: "phone", scope: "widget" }]),
    );
    expect(await within(keys).findByText("the-secret")).toBeTruthy();
    expect(within(keys).getByText(/services\.yaml/)).toBeTruthy();
  });

  it("creates a metrics key, and shows how Prometheus scrapes with it", async () => {
    const fetch = serve("admin", {
      [`POST ${API_ROUTES.widgetKeys}`]: {
        key: { id: "k3", name: "prometheus", scope: "metrics", hint: "wxyz" },
        secret: "ahw_metrics-secret",
      },
    });
    renderSettings("admin");

    const keys = (await screen.findByRole("heading", { name: "Widget and metrics keys" })).closest("section")!;
    fireEvent.change(within(keys).getByLabelText(/^New key name/), { target: { value: "prometheus" } });
    fireEvent.change(within(keys).getByLabelText("Reads"), { target: { value: "metrics" } });
    fireEvent.click(within(keys).getByRole("button", { name: "Create key" }));

    await waitFor(() =>
      expect(sent(fetch, "POST", API_ROUTES.widgetKeys)).toEqual([{ name: "prometheus", scope: "metrics" }]),
    );
    expect(await within(keys).findByText(/^Prometheus reads https:\/\/autoheal\.example\/api\/metrics/)).toBeTruthy();
    const config = within(keys).getByText(/scrape_configs:/).textContent!;
    expect(config).toContain("metrics_path: /api/metrics");
    expect(config).toContain("credentials: ahw_metrics-secret");
    expect(config).toContain('targets: ["autoheal.example"]');
    expect(config).not.toContain("x-api-key");
  });

  it("shows a viewer what is set up, and nothing to change or only admins may see", async () => {
    serve("viewer");
    renderSettings("viewer");

    expect(await screen.findByText("Gotify")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send a test" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "People and keys" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Backups" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Trusted proxies" })).toBeNull();
    expect(screen.queryByRole("link", { name: "People and keys" })).toBeNull();
    expect(screen.getByRole("link", { name: "Your account" }).getAttribute("href")).toBe(PATHS.account);
  });

  it("lets an update that stopped partway be taken up, and keeps the button off while one really runs", async () => {
    const stopped = (status: "blocked" | "updating") => ({
      ...selfUpdate,
      last: {
        status,
        from: "a",
        to: "b",
        reference: selfUpdate.reference,
        startedAt: 1,
        finishedAt: null,
        message: "It stopped partway.",
      },
    });
    serve("admin", { [API_ROUTES.selfUpdate]: stopped("blocked") });
    renderSettings("admin");
    await screen.findByText(/It stopped partway/);
    expect((screen.getByRole("button", { name: words.update }) as HTMLButtonElement).disabled).toBe(false);
    cleanup();

    serve("admin", { [API_ROUTES.selfUpdate]: stopped("updating") });
    renderSettings("admin");
    await screen.findByText(/It stopped partway/);
    expect((screen.getByRole("button", { name: words.update }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("updates Autoheal from its System card, and says how it goes", async () => {
    const fetch = serve("admin", {
      [`POST ${API_ROUTES.selfUpdate}`]: {
        ...selfUpdate,
        last: {
          status: SELF_UPDATE_STATUS.updating,
          from: RUNNING_IMAGE,
          to: `sha256:${"b".repeat(64)}`,
          reference: selfUpdate.reference,
          startedAt: Date.now(),
          finishedAt: null,
          message: SELF_UPDATE_TEXT.started,
        },
      } satisfies SelfUpdateView,
    });
    renderSettings("admin");
    const card = (await screen.findByRole("heading", { name: words.title })).closest("section")!;
    expect(within(card).getByText(words.explanation(selfUpdate.reference))).toBeTruthy();
    expect(within(card).getByText(words.runs("aaaaaaaaaaaa"))).toBeTruthy();

    fireEvent.click(within(card).getByRole("button", { name: words.update }));
    await waitFor(() => expect(sent(fetch, "POST", API_ROUTES.selfUpdate)).toHaveLength(1));
    expect(await within(card).findByText(new RegExp(SELF_UPDATE_TEXT.started))).toBeTruthy();
    // Not twice while it goes on.
    expect(within(card).getByRole<HTMLButtonElement>("button", { name: words.update }).disabled).toBe(true);
  });

  it("says why Autoheal cannot update itself where it cannot, with nothing to press", async () => {
    serve("admin", {
      [API_ROUTES.selfUpdate]: { ...selfUpdate, unavailable: SELF_UPDATE_TEXT.noSocket, runningImage: null },
    });
    renderSettings("admin");
    const card = (await screen.findByRole("heading", { name: words.title })).closest("section")!;
    expect(await within(card).findByText(SELF_UPDATE_TEXT.noSocket)).toBeTruthy();
    expect(within(card).queryByRole("button", { name: words.update })).toBeNull();
  });
});
