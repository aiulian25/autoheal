import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { API_ROUTES, apiPath, TIMELINE_ENTRY, type ContainerTimelineEntry } from "../../../src/shared/api.js";
import { DELIVERY_RESOURCE } from "../../../src/shared/notification-deliveries.js";
import { CONTAINER_TIMELINE_SHOWN } from "../constants.js";
import { ContainerTimeline } from "./container-timeline.js";

const HOST = "66cc4c4e-efb1-4a02-9e0b-f9ba7c2e7b92";
const NOW = Date.now();
const minutesAgo = (minutes: number) => NOW - minutes * 60_000;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(entries: ContainerTimelineEntry[]) {
  const timeline = apiPath(API_ROUTES.containerTimeline, { hostId: HOST, containerName: "paperless" });
  const fetch = vi.fn(async (path: string) => {
    const body = path === timeline ? entries : [];
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    { path: "/", element: <ContainerTimeline hostId={HOST} containerName="paperless" /> },
  ]);
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

// One of each, newest first, as the control plane sends them.
const story: ContainerTimelineEntry[] = [
  {
    kind: TIMELINE_ENTRY.notification,
    at: minutesAgo(1),
    notification: {
      id: "alert",
      kind: "incident_handled",
      hostId: HOST,
      resourceKind: DELIVERY_RESOURCE.incident,
      resourceId: "crash",
      priority: "high",
      createdAt: minutesAgo(1),
      acknowledgedAt: null,
      acknowledgedBy: null,
      escalationAt: null,
      deliveries: [
        {
          id: "delivery",
          channel: "gotify",
          stage: 0,
          status: "accepted",
          attempts: 1,
          nextAttemptAt: null,
          lastAttemptAt: minutesAgo(1),
          acceptedAt: minutesAgo(1),
          failureCode: null,
        },
      ],
    },
  },
  {
    kind: TIMELINE_ENTRY.job,
    at: minutesAgo(2),
    job: {
      id: "stop",
      hostId: HOST,
      hostLabel: "Alder",
      containerName: "paperless",
      action: "stop",
      status: "succeeded",
      requestedBy: "Autoheal",
      taskId: "look",
      createdAt: minutesAgo(3),
      completedAt: minutesAgo(2),
      outcome: "Stopped paperless.",
      output: null,
      recoveryBackupId: null,
      packages: [],
      progress: null,
      stack: null,
    },
  },
  {
    kind: TIMELINE_ENTRY.task,
    at: minutesAgo(4),
    task: { id: "look", number: 7, title: "Look at paperless" },
    activity: { id: 1, kind: "created", actor: "Autoheal", data: {}, createdAt: minutesAgo(4) },
  },
  {
    kind: TIMELINE_ENTRY.change,
    at: minutesAgo(5),
    change: { id: 2, at: minutesAgo(5), kind: "rebooted", containerName: null, details: {} },
  },
  {
    kind: TIMELINE_ENTRY.change,
    at: minutesAgo(6),
    change: { id: 1, at: minutesAgo(6), kind: "stopped", containerName: "paperless", details: { exitCode: 137 } },
  },
  {
    kind: TIMELINE_ENTRY.incident,
    at: minutesAgo(7),
    incident: {
      id: "crash",
      hostId: HOST,
      hostLabel: "Alder",
      containerName: "paperless",
      image: "paperless-ngx",
      trigger: "die",
      status: "resolved",
      decidedBy: "model",
      action: "restart",
      target: "paperless",
      verdict: "restarted",
      detectedAt: minutesAgo(7),
      updatedAt: minutesAgo(6),
    },
  },
];

it("tells a container's story newest first, each entry in its own list's words, with what leads to it", async () => {
  show(story);
  const timeline = await screen.findByRole("region", { name: "Timeline" });
  const items = await within(timeline).findAllByRole("listitem");
  const lines = items.map((item) => item.textContent ?? "");
  expect(lines[0]).toContain("Alert: incident handled");
  expect(lines[0]).toContain("Gotify accepted");
  expect(lines[1]).toContain("Stop");
  expect(lines[1]).toContain("for Autoheal");
  expect(lines[1]).toContain("Stopped paperless.");
  expect(lines[2]).toContain("#7 Look at paperless");
  expect(lines[2]).toContain("Autoheal opened it");
  expect(lines[3]).toContain("Host");
  expect(lines[3]).toContain("the host rebooted");
  expect(lines[4]).toContain("paperless");
  expect(lines[4]).toContain("stopped (exit 137)");
  expect(lines[5]).toContain("It stopped");
  expect(lines[5]).toContain("restart → paperless");

  // Each leads to its incident or its task.
  const linkOf = (index: number, name: string) =>
    within(items[index]!).getByRole("link", { name }).getAttribute("href");
  expect(linkOf(0, "Incident")).toBe("/incidents/crash");
  expect(linkOf(1, "Task")).toBe("/tasks/look");
  expect(linkOf(2, "#7 Look at paperless")).toBe("/tasks/look");
  expect(linkOf(5, "Incident")).toBe("/incidents/crash");
  expect(within(items[3]!).queryByRole("link")).toBeNull();
});

it("shows the newest few, all of them on request, and says when nothing is recorded yet", async () => {
  const many: ContainerTimelineEntry[] = Array.from({ length: CONTAINER_TIMELINE_SHOWN + 2 }, (_, index) => ({
    kind: TIMELINE_ENTRY.change,
    at: minutesAgo(index),
    change: { id: index, at: minutesAgo(index), kind: "started", containerName: "paperless", details: {} },
  }));
  show(many);
  const timeline = await screen.findByRole("region", { name: "Timeline" });
  expect(await within(timeline).findAllByRole("listitem")).toHaveLength(CONTAINER_TIMELINE_SHOWN);

  const showAll = within(timeline).getByRole("button", { name: `Show all ${many.length}` });
  expect(showAll.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(showAll);
  expect(within(timeline).getAllByRole("listitem")).toHaveLength(many.length);
  const showNewest = within(timeline).getByRole("button", { name: `Show the newest ${CONTAINER_TIMELINE_SHOWN}` });
  expect(showNewest.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(showNewest);
  expect(within(timeline).getAllByRole("listitem")).toHaveLength(CONTAINER_TIMELINE_SHOWN);

  cleanup();
  show([]);
  expect(await screen.findByText("Nothing recorded for this container yet.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Show/ })).toBeNull();
});
