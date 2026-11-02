import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_ROUTES,
  apiPath,
  type HostImagesView,
  type HostView,
  type JobView,
  type SessionView,
} from "../../../src/shared/api.js";
import type { UnusedImage } from "../../../src/shared/protocol.js";
import { SESSION_QUERY_KEY } from "../constants.js";
import { HostImages } from "./host-images.js";

const session: SessionView = {
  user: { id: "u1", username: "admin", role: "admin", mustChangePassword: false, totpEnabled: true },
  csrfToken: "csrf",
  secondFactorDone: true,
};
const IMAGES = apiPath(API_ROUTES.hostImages, { hostId: "h1" });
const HOST_ACTIONS = apiPath(API_ROUTES.hostActions, { hostId: "h1" });
const digest = (character: string) => `sha256:${character.repeat(64)}`;

const alder = (dryRun: boolean | null): HostView => ({
  id: "h1",
  label: "Alder",
  state: "online",
  tokenHint: "abcd",
  enrolledAt: Date.now(),
  lastHeartbeatAt: Date.now(),
  runnerVersion: "2.0.0",
  dryRun,
  eventStreamConnected: true,
  protectedContainers: [],
  restartBudget: {},
  containerAccess: null,
  health: null,
  metrics: null,
  containerCount: 13,
  runningCount: 13,
  problemCount: 0,
});

const image = (overrides: Partial<UnusedImage>): UnusedImage => ({
  id: digest("b"),
  tags: [],
  repository: null,
  sizeBytes: 100_000_000,
  createdAt: Date.now() - 86_400_000,
  keptByUpdate: false,
  ...overrides,
});

// What an update left behind, one a newer pull took the name from, and one built on the host.
const KEPT = image({
  id: digest("a"),
  tags: ["ghcr.io/lmmendes/attic:2.7.0-autoheal-previous"],
  repository: "ghcr.io/lmmendes/attic",
  sizeBytes: 480_000_000,
  keptByUpdate: true,
});
const NAMELESS = image({ id: digest("b"), repository: "ghcr.io/immich-app/immich-server", sizeBytes: 1_200_000_000 });
const BUILT_HERE = image({ id: digest("c"), sizeBytes: 20_000_000 });

function serve(view: HostImagesView) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const answer = (init?.method ?? "GET") === "GET" && url === IMAGES ? view : { id: "j1", status: "pending" };
    return new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function show(element: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(SESSION_QUERY_KEY, session);
  render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
}

const removal = (fetch: ReturnType<typeof serve>, images: string[]) =>
  waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      HOST_ACTIONS,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "remove_images", images }) }),
    ),
  );

describe("a host's old images", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("says what each one is, and removes one from its row once asked", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    const fetch = serve({ images: [KEPT, NAMELESS, BUILT_HERE], lastRemoval: null });
    show(<HostImages host={alder(false)} admin />);

    expect(await screen.findByText("3 images, 1.7 GB")).toBeTruthy();
    expect(screen.getByText("ghcr.io/immich-app/immich-server, without a tag")).toBeTruthy();
    expect(screen.getAllByText("cccccccccccc")).toHaveLength(2);
    expect(screen.getByText(/kept for going back to it by hand/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove ghcr.io/lmmendes/attic:2.7.0-autoheal-previous" }));

    expect(confirm).toHaveBeenCalledWith(
      "Remove ghcr.io/lmmendes/attic:2.7.0-autoheal-previous from Alder? Going back to it by hand needs it: a container ran it before its last update.",
    );
    await removal(fetch, [KEPT.id]);
  });

  it("removes the selected ones, or all of them, only once asked", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    const fetch = serve({ images: [KEPT, NAMELESS, BUILT_HERE], lastRemoval: null });
    show(<HostImages host={alder(false)} admin />);

    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Select ghcr.io/immich-app/immich-server, without a tag" }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select cccccccccccc" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove selected (2)" }));
    expect(confirm).toHaveBeenLastCalledWith("Remove 2 images (1.2 GB) from Alder?");
    await removal(fetch, [NAMELESS.id, BUILT_HERE.id]);

    confirm.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Remove all" }));
    expect(confirm).toHaveBeenLastCalledWith(
      "Remove 3 images (1.7 GB) from Alder? 1 of them is kept from an update, for going back by hand.",
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select every image" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove selected (3)" }));
    await removal(fetch, [KEPT.id, NAMELESS.id, BUILT_HERE.id]);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });

  it("lets a viewer, or anyone on a host that only watches, read the list and pick nothing", async () => {
    serve({ images: [KEPT], lastRemoval: null });
    show(<HostImages host={alder(false)} admin={false} />);
    expect(await screen.findByText("1 image, 480 MB")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    cleanup();

    show(<HostImages host={alder(true)} admin />);
    expect(await screen.findByText("Nothing is removed while this host only watches.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove all" })).toBeNull();
  });

  it("says when there are none, when the runner does not list them, and how the last removal went", async () => {
    const pending = { action: "remove_images", status: "pending", requestedBy: "admin", createdAt: Date.now() };
    serve({ images: [], lastRemoval: { ...pending, completedAt: null, outcome: null, output: null } as JobView });
    show(<HostImages host={alder(false)} admin />);
    expect(await screen.findByText("None: every image on this host is used by a container.")).toBeTruthy();
    expect(screen.getByText("On its way to the host's runner…")).toBeTruthy();
    cleanup();

    serve({ images: null, lastRemoval: null });
    show(<HostImages host={alder(false)} admin />);
    expect(await screen.findByText(/Its runner has not listed them yet/)).toBeTruthy();
  });
});
