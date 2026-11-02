import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { API_ROUTES } from "../../../src/shared/api.js";
import type { NotificationInbox } from "../../../src/shared/notification-deliveries.js";
import { NotificationDeliveryInbox, NotificationRoutingEditor } from "./notification-deliveries.js";
const eventId = "12345678-0000-4000-8000-000000000001";
const deliveryId = "12345678-0000-4000-8000-000000000002";
const fixture = (): NotificationInbox => ({
  events: [
    {
      id: eventId,
      kind: "incident_handled",
      hostId: null,
      resourceKind: "system",
      resourceId: null,
      priority: "high",
      createdAt: Date.now(),
      acknowledgedAt: null,
      acknowledgedBy: null,
      escalationAt: null,
      deliveries: [
        {
          id: deliveryId,
          channel: "gotify",
          stage: 0,
          status: "failed",
          attempts: 8,
          nextAttemptAt: null,
          lastAttemptAt: Date.now(),
          acceptedAt: null,
          failureCode: "unreachable",
        },
      ],
    },
  ],
  pendingCount: 0,
  overflowCount: 0,
  lastOverflowAt: null,
});
let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function show(content: React.ReactNode, request: typeof fetch) {
  vi.stubGlobal("fetch", request);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{content}</MemoryRouter>
    </QueryClientProvider>,
  );
}
function open(label: string) {
  const summary = screen.getByText(label);
  const details = summary.closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}
it("loads lazily and labels server acceptance truthfully, with administrator acknowledgement and explicit retry", async () => {
  let inbox = fixture();
  const fetch = vi.fn(async (path: string, options: RequestInit) => {
    if (options.method === "POST" && path.endsWith("/retry")) inbox.events[0]!.deliveries[0]!.status = "queued";
    if (options.method === "POST" && path.endsWith("/acknowledge"))
      inbox = { ...inbox, events: [{ ...inbox.events[0]!, acknowledgedAt: Date.now(), acknowledgedBy: "admin" }] };
    return new Response(options.method === "POST" ? null : JSON.stringify(inbox), {
      status: options.method === "POST" ? 204 : 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  show(<NotificationDeliveryInbox admin />, fetch);
  expect(fetch).not.toHaveBeenCalled();
  open("Notification deliveries");
  expect(await screen.findByRole("button", { name: "Retry with current channel settings" })).toBeTruthy();
  expect(screen.getByText(/does not confirm device receipt/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry with current channel settings" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Retry with current channel settings" })).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
  expect(await screen.findByText(/Acknowledged by admin/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
});
it("keeps mutation controls unavailable to viewers and exposes queue saturation", async () => {
  const inbox = { ...fixture(), overflowCount: 2, lastOverflowAt: Date.now() };
  show(
    <NotificationDeliveryInbox admin={false} />,
    vi.fn(
      async () => new Response(JSON.stringify(inbox), { headers: { "content-type": "application/json" } }),
    ) as typeof fetch,
  );
  open("Notification deliveries");
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    expect.stringContaining("2 alerts could not be enqueued"),
  );
  expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry with current channel settings" })).toBeNull();
});
it("offers explicit current-routing recovery for an unrouted alert", async () => {
  const inbox = fixture();
  inbox.events[0]!.deliveries = [];
  const request = vi.fn(
    async (_path: string, options: RequestInit) =>
      new Response(options.method === "POST" ? null : JSON.stringify(inbox), {
        status: options.method === "POST" ? 204 : 200,
        headers: { "content-type": "application/json" },
      }),
  );
  show(<NotificationDeliveryInbox admin />, request as unknown as typeof fetch);
  open("Notification deliveries");
  fireEvent.click(await screen.findByRole("button", { name: "Queue using current routing" }));
  await waitFor(() =>
    expect(request.mock.calls.some(([path, options]) => path.endsWith("/route") && options.method === "POST")).toBe(
      true,
    ),
  );
});
it("edits routing using bounded form controls without sending test notifications", async () => {
  let saved: unknown;
  const fetch = vi.fn(async (path: string, options: RequestInit) => {
    if (path === API_ROUTES.notificationRouting && options.method === "PUT") saved = JSON.parse(options.body as string);
    return new Response(
      JSON.stringify(
        path === API_ROUTES.hosts
          ? []
          : { rules: saved ? (saved as { rules: unknown[] }).rules : [], overflowCount: 0, lastOverflowAt: null },
      ),
      { headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof globalThis.fetch;
  show(<NotificationRoutingEditor admin />, fetch);
  open("Notification routing and quiet hours");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save routing" }).hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add routing rule" }));
  fireEvent.click(screen.getByLabelText("Quiet hours (UTC)"));
  fireEvent.click(screen.getByRole("button", { name: "Save routing" }));
  expect(await screen.findByRole("status")).toHaveProperty("textContent", "Notification routing saved.");
  expect(saved).toMatchObject({
    rules: [
      {
        quietStartMinute: 1320,
        quietEndMinute: 420,
        urgentOverride: true,
        channels: ["gotify", "ntfy", "webhook"],
      },
    ],
  });
  expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).includes("/test"))).toBe(false);
});
