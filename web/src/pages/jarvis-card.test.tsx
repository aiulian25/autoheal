import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES } from "../../../src/shared/api.js";
import type { JarvisTestQuestionView, JarvisView } from "../../../src/shared/jarvis.js";
import { timeOfDay } from "../format.js";
import { JarvisCard } from "./jarvis-card.js";

const HELPERS = "http://ha.test:8123/_my_redirect/helpers";
const BLUEPRINT_IMPORT = "http://ha.test:8123/_my_redirect/blueprint_import?blueprint_url=synthetic";
const VIEW: JarvisView = {
  homeAssistantSet: true,
  connected: false,
  paused: false,
  setup: null,
  testing: false,
  lastTestMilliseconds: null,
  lastHeardAt: null,
  heardByAnswerBox: false,
  linesDropped: 0,
  waiting: 0,
  notConfirmed: 0,
  summary: "All 2 machines are up.",
  address: null,
  name: null,
  webhookId: null,
  links: { helpers: HELPERS, blueprintImport: BLUEPRINT_IMPORT },
  homeAssistantConnected: true,
  testQuestion: null,
  asking: { ready: false, updates: false, versions: false },
  open: [],
  hosts: [{ id: "h1", label: "Rowan", aliases: ["Tower"] }],
  recent: [],
};
const CONNECTED: JarvisView = { ...VIEW, connected: true, setup: "x", webhookId: "autoheal-synthetic" };
const SECRET = "ahw_synthetic-key";
const WEBHOOK_ID = "autoheal-synthetic-webhook";

function serve(view: JarvisView) {
  let current = view;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === API_ROUTES.jarvisConnect) {
        current = { ...current, connected: true, webhookId: WEBHOOK_ID, setup: "webhook_id: autoheal-synthetic" };
        return Response.json({ view: current, secret: SECRET });
      }
      if (path === API_ROUTES.jarvisTestQuestion) {
        current = { ...current, testQuestion: { outcome: "asking", answer: null } };
        return Response.json({ delivered: true });
      }
      if (path === API_ROUTES.jarvisTest) return Response.json({ delivered: true });
      if (path === API_ROUTES.jarvis && init?.method !== "DELETE") return Response.json(current);
      return new Response(null, { status: 204 });
    }),
  );
}

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <JarvisCard />
    </QueryClientProvider>,
  );
}

// Where the webhook ID was: the card shows only this, and its Copy takes the real one.
const MASKED = "••••••••••••";
const sentTo = (route: string) => vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === route);
const bodyOf = (route: string) => JSON.parse(String(sentTo(route).at(-1)![1]!.body)) as unknown;

describe("the assistant's card", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("asks for Home Assistant first", async () => {
    serve({ ...VIEW, homeAssistantSet: false, links: null });
    show();
    await screen.findByText(/Connect Home Assistant first/);
    expect(screen.queryByRole("link", { name: "Import the blueprint" })).toBeNull();
  });

  it("sets up in three steps, nothing typed: the helpers, the blueprint with its webhook ID, and a test question", async () => {
    serve(VIEW);
    show();
    expect((await screen.findByRole("heading", { name: "Assistant" })).textContent).toBe("Assistant");
    expect(screen.getByText(/The assistant tells you what matters/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the helpers" }).getAttribute("href")).toBe(HELPERS);
    const blueprint = screen.getByRole("link", { name: "Import the blueprint" });
    expect(blueprint.getAttribute("href")).toBe(BLUEPRINT_IMPORT);
    expect(blueprint.getAttribute("target")).toBe("_blank");
    expect((screen.getByRole("button", { name: "Send a test question" }) as HTMLButtonElement).disabled).toBe(true);
    // Opening the blueprint makes the webhook ID its form asks for.
    blueprint.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(blueprint);
    await screen.findByText(MASKED);
    expect(sentTo(API_ROUTES.jarvisConnect)).toHaveLength(1);
    expect(screen.queryByText(WEBHOOK_ID)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send a test question" }));
    await screen.findByText("Asked. Waiting for the answer…");
    expect(sentTo(API_ROUTES.jarvisTestQuestion)).toHaveLength(1);
  });

  it("makes the webhook ID without the blueprint, for one opened some other way", async () => {
    serve(VIEW);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Show the webhook ID" }));
    await screen.findByText(MASKED);
    expect(sentTo(API_ROUTES.jarvisConnect)).toHaveLength(1);
  });

  it("says what came of the test question, and where to look when it was not answered", async () => {
    const outcomes: [JarvisTestQuestionView, RegExp][] = [
      { outcome: "answered", answer: { said: "yes", how: "voice", seconds: 4 } },
      { outcome: "answered", answer: { said: "no", how: "phone", seconds: 150 } },
      { outcome: "not_taken", answer: null },
      { outcome: "nothing_back", answer: null },
      { outcome: "put_off", answer: null },
      { outcome: "not_answered", answer: null },
    ].map((testQuestion, index) => [
      testQuestion as JarvisTestQuestionView,
      [
        /^Answered yes, by voice, in 4 seconds\.$/,
        /^Answered no, on the phone, in 3 minutes\.$/,
        /did not take the message\. Check its address and token on Home Assistant's card/,
        /nothing came back\. Is the answer box picked in the automation/,
        /put it off: .+ See the automation's form/,
        /nobody answered\. Is a voice satellite or a phone picked in the automation/,
      ][index]!,
    ]);
    for (const [testQuestion, said] of outcomes) {
      serve({ ...CONNECTED, testQuestion });
      show();
      expect(await screen.findByText(said)).toBeTruthy();
      cleanup();
    }
  });

  it("will not send a test question while Autoheal cannot hear Home Assistant", async () => {
    serve({ ...CONNECTED, homeAssistantConnected: false });
    show();
    await screen.findByText(/no answer could come back/);
    expect((screen.getByRole("button", { name: "Send a test question" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps what it asks greyed until a test question was answered, then saves each tick", async () => {
    serve(CONNECTED);
    show();
    await screen.findByText(/Answer a test question first/);
    const updates = screen.getByRole("checkbox", { name: "Ask before updating a container" });
    expect(updates.closest("fieldset")!.disabled).toBe(true);
    expect(screen.getByText(/Whoever can change helpers in Home Assistant/)).toBeTruthy();
    cleanup();
    serve({ ...CONNECTED, asking: { ready: true, updates: false, versions: true } });
    show();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Ask before updating a container" }));
    await vi.waitFor(() => expect(sentTo(API_ROUTES.jarvisAsking)).toHaveLength(1));
    expect(bodyOf(API_ROUTES.jarvisAsking)).toEqual({ updates: true, versions: true });
    expect(screen.queryByText(/Answer a test question first/)).toBeNull();
  });

  it("speaks of it by its name, and saves another", async () => {
    serve({ ...CONNECTED, name: "Jarvis" });
    show();
    await screen.findByText(/Jarvis tells you what matters/);
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("Jarvis");
    fireEvent.change(name, { target: { value: "Friday" } });
    fireEvent.click(within(name.form!).getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    expect(bodyOf(API_ROUTES.jarvisName)).toEqual({ name: "Friday" });
  });

  it("shows how it addresses you, and saves another or none", async () => {
    serve({ ...CONNECTED, address: "sir" });
    show();
    const address = (await screen.findByLabelText("Form of address")) as HTMLInputElement;
    expect(address.value).toBe("sir");
    fireEvent.change(address, { target: { value: "" } });
    fireEvent.click(within(address.form!).getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    expect(bodyOf(API_ROUTES.jarvisAddress)).toEqual({ address: "" });
  });

  it("keeps the contract, and the block of today with its key and its test, for a house that writes its own", async () => {
    serve(VIEW);
    show();
    const own = await screen.findByText("I write my own automations");
    expect(screen.getByRole("link", { name: "the contract" }).getAttribute("href")).toMatch(
      /\/blob\/v[\d.]+\/docs\/home-assistant\/README\.md$/,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show the webhook ID" }));
    await screen.findByText(SECRET);
    fireEvent.click(own);
    fireEvent.click(screen.getByRole("button", { name: "Show the Home Assistant block" }));
    expect(screen.getByText(/webhook_id: autoheal-synthetic/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send a test" }));
    await screen.findByText(/the assistant did not answer/);
    cleanup();
    serve({ ...CONNECTED, name: "Jarvis", lastTestMilliseconds: 180 });
    show();
    await screen.findByText("Jarvis answered in 180 ms.");
  });

  it("says when it has not confirmed what was sent", async () => {
    serve({ ...CONNECTED, name: "Jarvis", notConfirmed: 2 });
    show();
    await screen.findByText(/Jarvis has not confirmed 2 messages/);
  });

  it("says when it last heard by the answer box, and when lines came too fast to be read", async () => {
    serve({ ...CONNECTED, lastHeardAt: Date.now(), heardByAnswerBox: true, linesDropped: 3 });
    show();
    expect(await screen.findByText(/, by the answer box/)).toBeTruthy();
    expect(screen.getByText(/3 lines were not read/)).toBeTruthy();
  });

  it("shows what it would say, and saves a machine's other names", async () => {
    serve(CONNECTED);
    show();
    await screen.findByText(/All 2 machines are up/);
    const names = screen.getByLabelText("Other names for Rowan") as HTMLInputElement;
    expect(names.value).toBe("Tower");
    fireEvent.change(names, { target: { value: "Tower, the laptop" } });
    fireEvent.click(within(names.form!).getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    expect(bodyOf(API_ROUTES.jarvisAliases)).toEqual({ hostId: "h1", aliases: ["Tower", "the laptop"] });
  });

  it("shows what is open, above what it told", async () => {
    const askedAt = Date.now();
    const recent = [{ id: "1", kind: "reboot", tier: "say", text: "Rowan would like a restart.", sentAt: 1 }] as const;
    const open = [
      { id: "2", host: "nas1", names: ["whoami", "gitea"], from: null, to: null, askedAt, asks: 1 },
      { id: "3", host: "nas1", names: ["gitea"], from: "3.4", to: "3.5", askedAt, asks: 3 },
    ];
    serve({ ...CONNECTED, recent: [...recent], open });
    show();
    const told = (await screen.findByRole("heading", { name: "Asked and told" })).parentElement!;
    const items = within(told).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      `Asked at ${timeOfDay(askedAt)}: whoami and gitea on nas1. First of three.`,
      `Asked at ${timeOfDay(askedAt)}: gitea on nas1, 3.4 to 3.5. Last of three.`,
      expect.stringMatching(/^Rowan would like a restart\. /),
    ]);
  });
});
