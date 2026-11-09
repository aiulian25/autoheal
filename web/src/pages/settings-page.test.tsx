import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES } from "../../../src/shared/api.js";
import { TEXT } from "../constants.js";
import { bytes, timeAgo, wholeNumber } from "../format.js";
import {
  RELAY,
  BROWSER,
  untrusted,
  settings,
  ollamaSettings,
  json,
  DATA,
  serve,
  renderSettings,
  sent,
} from "../test-support/settings-page.js";

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
    renderSettings("admin");
    const card = (await screen.findByRole("heading", { name: "Ollama" })).closest("section")!;
    expect(await within(card).findByText("Chosen here; the .env's is the fallback.")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Use the .env's" }));
    fireEvent.click(within(card).getByRole("button", { name: TEXT.yes }));
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
});
