import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES } from "../../../src/shared/api.js";
import type { JarvisView } from "../../../src/shared/jarvis.js";
import { JarvisCard } from "./jarvis-card.js";

const VIEW: JarvisView = {
  homeAssistantSet: true,
  connected: false,
  paused: false,
  setup: null,
  testing: false,
  lastTestMilliseconds: null,
  lastHeardAt: null,
  waiting: 0,
  notConfirmed: 0,
  summary: "All 2 machines are up.",
  hosts: [{ id: "h1", label: "Rowan", aliases: ["Tower"] }],
  recent: [],
};
const SECRET = "ahw_synthetic-key";

function serve(view: JarvisView) {
  let current = view;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === API_ROUTES.jarvisConnect) {
        current = { ...current, connected: true, setup: "webhook_id: autoheal-synthetic" };
        return Response.json({ view: current, secret: SECRET });
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

describe("Jarvis's card", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("asks for Home Assistant first", async () => {
    serve({ ...VIEW, homeAssistantSet: false });
    show();
    await screen.findByText(/Connect Home Assistant first/);
    expect(screen.queryByRole("button", { name: "Connect Jarvis" })).toBeNull();
  });

  it("connects with one button, and shows the key and the block", async () => {
    serve(VIEW);
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Connect Jarvis" }));
    await screen.findByText(SECRET);
    expect(screen.getByText(/webhook_id: autoheal-synthetic/)).toBeTruthy();
  });

  it("says when Jarvis did not answer, and when it did", async () => {
    serve({ ...VIEW, connected: true, setup: "x" });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Send a test" }));
    await screen.findByText(/Jarvis did not answer/);
    cleanup();
    serve({ ...VIEW, connected: true, setup: "x", lastTestMilliseconds: 180 });
    show();
    await screen.findByText("Jarvis answered in 180 ms.");
  });

  it("says when Jarvis has not confirmed what was sent", async () => {
    serve({ ...VIEW, connected: true, setup: "x", notConfirmed: 2 });
    show();
    await screen.findByText(/has not confirmed 2 messages/);
  });

  it("shows what it would say, and saves a machine's other names", async () => {
    serve({ ...VIEW, connected: true, setup: "x" });
    show();
    await screen.findByText(/All 2 machines are up/);
    const names = screen.getByLabelText("Other names for Rowan") as HTMLInputElement;
    expect(names.value).toBe("Tower");
    fireEvent.change(names, { target: { value: "Tower, the laptop" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    const sent = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === API_ROUTES.jarvisAliases)!;
    expect(JSON.parse(String(sent[1]!.body))).toEqual({ hostId: "h1", aliases: ["Tower", "the laptop"] });
  });

  it("shows what it was told", async () => {
    const recent = [{ id: "1", kind: "reboot", tier: "say", text: "Rowan would like a restart.", sentAt: 1 }] as const;
    serve({ ...VIEW, connected: true, setup: "x", recent: [...recent] });
    show();
    await screen.findByText(/Rowan would like a restart/);
  });
});
