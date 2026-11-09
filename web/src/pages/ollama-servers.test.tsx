import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath, type OllamaServersView } from "../../../src/shared/api.js";
import { TEXT } from "../constants.js";
import { HostOllamaFact, OllamaServers } from "./ollama-servers.js";

const text = TEXT.settingsPage.ollama;
const SERVER = "11111111-1111-4111-8111-111111111111";
const STATUS = {
  reachable: true,
  checkedAt: 1,
  error: null,
  version: "1",
  model: "big:30b",
  modelPresent: true,
  facts: null,
  models: [
    { name: "big:30b", sizeBytes: 1, parameterSize: "30B", quantization: null },
    { name: "small:4b", sizeBytes: 1, parameterSize: "4B", quantization: null },
  ],
  loaded: [],
};
const WITH_ONE: OllamaServersView = {
  extras: [
    {
      id: SERVER,
      name: "Delta3640",
      url: "http://192.168.10.178:11434",
      model: "big:30b",
      contextTokens: 32_768,
      plainHttp: true,
      status: STATUS,
      hostIds: ["h1"],
    },
  ],
  reviewServerId: null,
  routerServerId: null,
  defaultName: null,
};
const DEFAULTS = { url: "http://192.168.10.123:11434", model: "small", contextTokens: 16_384 };
const HOSTS = [
  { id: "h1", label: "Alder", state: "active" },
  { id: "h2", label: "Rowan", state: "active" },
];
let view: OllamaServersView;
let sent: { method: string; url: string; body: unknown }[];
let homeAssistantConfigured: boolean;

beforeEach(() => {
  view = { extras: [], reviewServerId: null, routerServerId: null, defaultName: null };
  sent = [];
  homeAssistantConfigured = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") sent.push({ method, url, body: JSON.parse(String(init?.body ?? "null")) });
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
      if (url === API_ROUTES.ollamaServers && method === "GET") return json(view);
      if (url === API_ROUTES.hosts) return json(HOSTS);
      if (url === API_ROUTES.homeAssistant) return json({ status: { configured: homeAssistantConfigured } });
      if (url === API_ROUTES.ollamaSettingsModels) {
        return json([{ name: "fresh:7b", sizeBytes: 1, parameterSize: "7B", quantization: null, loaded: false }]);
      }
      return json({ id: "new" });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const show = (admin = true) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <OllamaServers admin={admin} defaults={DEFAULTS} />
    </QueryClientProvider>,
  );

describe("the servers in the Ollama card", () => {
  it("with only the default, adds nothing but the way to add one", async () => {
    show();
    expect(await screen.findByRole("button", { name: text.addServer })).toBeTruthy();
    expect(screen.queryByText(text.homeAssistant)).toBeNull();
    expect(screen.queryByText(/default server watches/)).toBeNull();
  });

  it("adds one by its address, offering that server's models with the first already picked", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: text.addServer }));
    fireEvent.change(screen.getByLabelText(new RegExp(`^${text.serverName}`)), { target: { value: "Delta3640" } });
    const address = screen.getByLabelText(new RegExp(`^${text.address}`));
    fireEvent.change(address, { target: { value: "http://192.168.10.178:11434" } });
    fireEvent.blur(address);
    const radio = (await screen.findByRole("radio", { name: /fresh:7b/ })) as HTMLInputElement;
    await waitFor(() => expect(radio.checked).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: text.save }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toMatchObject({
      method: "POST",
      url: API_ROUTES.ollamaServers,
      body: { name: "Delta3640", url: "http://192.168.10.178:11434", model: "fresh:7b", contextTokens: 16_384 },
    });
  });

  it("ticks hosts at once, and says who is left on the default", async () => {
    view = WITH_ONE;
    show();
    const row = await screen.findByRole("region", { name: "Delta3640" });
    expect(await screen.findByText("The default server watches: Rowan.")).toBeTruthy();
    fireEvent.click(await within(row).findByRole("checkbox", { name: "Rowan" }));
    await waitFor(() =>
      expect(sent.at(-1)).toEqual({
        method: "PUT",
        url: apiPath(API_ROUTES.ollamaServerHosts, { serverId: SERVER }),
        body: { hostIds: ["h1", "h2"] },
      }),
    );
  });

  it("switches its model with a click, and warns of plain http", async () => {
    view = WITH_ONE;
    show();
    const row = await screen.findByRole("region", { name: "Delta3640" });
    expect(within(row).getByText(/^Plain http\./)).toBeTruthy();
    fireEvent.click(within(row).getByRole("radio", { name: /small:4b/ }));
    await waitFor(() =>
      expect(sent.at(-1)).toMatchObject({
        method: "PUT",
        url: apiPath(API_ROUTES.ollamaServer, { serverId: SERVER }),
        body: { name: "Delta3640", model: "small:4b", contextTokens: 32_768 },
      }),
    );
  });

  it("says when one is not answering", async () => {
    view = { ...WITH_ONE, extras: [{ ...WITH_ONE.extras[0]!, status: { ...STATUS, reachable: false } }] };
    show();
    expect(await screen.findByText(text.usingDefaultForNow(text.defaultServer))).toBeTruthy();
  });

  it("names the hosts before removing one", async () => {
    view = WITH_ONE;
    show();
    await screen.findByRole("checkbox", { name: "Alder" });
    fireEvent.click(await screen.findByRole("button", { name: text.removeServer }));
    expect(screen.getByRole("group", { name: "Remove Delta3640? Alder will go back to the default." })).toBeTruthy();
    expect(sent.some(({ method }) => method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: TEXT.yes }));
    await waitFor(() => expect(sent.at(-1)?.method).toBe("DELETE"));
  });

  it("ticks Home Assistant like any host, and unticking goes back to the default", async () => {
    view = WITH_ONE;
    homeAssistantConfigured = true;
    show();
    const row = await screen.findByRole("region", { name: "Delta3640" });
    expect(await screen.findByText("The default server watches: Rowan, Home Assistant.")).toBeTruthy();
    fireEvent.click(await within(row).findByRole("checkbox", { name: text.homeAssistant }));
    await waitFor(() =>
      expect(sent.at(-1)).toEqual({ method: "PUT", url: API_ROUTES.ollamaReviewServer, body: { serverId: SERVER } }),
    );
    cleanup();
    view = { ...WITH_ONE, reviewServerId: SERVER };
    show();
    const again = await screen.findByRole("region", { name: "Delta3640" });
    const tick = (await within(again).findByRole("checkbox", { name: text.homeAssistant })) as HTMLInputElement;
    await waitFor(() => expect(tick.checked).toBe(true));
    fireEvent.click(tick);
    await waitFor(() =>
      expect(sent.at(-1)).toEqual({ method: "PUT", url: API_ROUTES.ollamaReviewServer, body: { serverId: null } }),
    );
  });

  it("offers no Home Assistant tick when it is not set up", async () => {
    view = WITH_ONE;
    show();
    const row = await screen.findByRole("region", { name: "Delta3640" });
    await within(row).findByRole("checkbox", { name: "Alder" });
    expect(within(row).queryByRole("checkbox", { name: text.homeAssistant })).toBeNull();
  });

  it("shows a viewer everything, with nothing to click", async () => {
    view = WITH_ONE;
    show(false);
    const box = (await screen.findByRole("checkbox", { name: "Alder" })) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: text.addServer })).toBeNull();
    expect(screen.queryByRole("button", { name: text.removeServer })).toBeNull();
  });
});

describe("which server a host uses", () => {
  const fact = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <HostOllamaFact hostId="h2" />
      </QueryClientProvider>,
    );

  it("is said only with two or more servers", async () => {
    const { container } = fact();
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(container.textContent).toBe("");
    cleanup();
    view = WITH_ONE;
    fact();
    expect(await screen.findByText(text.hostUses(text.defaultServer))).toBeTruthy();
  });
});
