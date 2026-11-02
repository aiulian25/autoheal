import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { API_ROUTES } from "../../../src/shared/api.js";
import { ROLLOUT_REASONS, ROLLOUT_ROUTES, type RolloutView } from "../../../src/shared/rollouts.js";
import { RolloutPlan } from "./rollout-plan.js";
let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
});
function show(fetch: typeof globalThis.fetch) {
  vi.stubGlobal("fetch", fetch);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RolloutPlan hostId="host-a" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const details = screen.getByText("Staged cross-host rollout").closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}
const plan: RolloutView = {
  id: "plan-a",
  createdAt: 1,
  updatedAt: 1,
  createdBy: "admin",
  status: "ready",
  targets: [
    {
      hostId: "host-a",
      containerName: "canary",
      targetReference: `ghcr.io/example/app@sha256:${"a".repeat(64)}`,
      sourceContainerId: "source",
      platform: "linux/amd64",
      fingerprint: "a".repeat(64),
      members: ["canary"],
      jobId: null,
      replacementId: "replacement",
      baselineRestarts: 0,
    },
    {
      hostId: "host-b",
      containerName: "follower",
      targetReference: `ghcr.io/example/app@sha256:${"a".repeat(64)}`,
      sourceContainerId: "source-b",
      platform: "linux/amd64",
      fingerprint: "b".repeat(64),
      members: ["follower"],
      jobId: null,
      replacementId: null,
      baselineRestarts: null,
    },
  ],
  current: 0,
  observeMilliseconds: 60_000,
  observeStartedAt: 1,
  lastSampleAt: 60_001,
  samples: 3,
  serviceVerificationRequired: true,
  externalDataIsolated: true,
  reason: "Observation passed",
  rollbackReadiness: "startup_only_then_manual",
};
it("requires service verification before explicit promotion and explains pinning/manual recovery", async () => {
  const request = vi.fn(
    async (path: string, _options: RequestInit) =>
      new Response(
        JSON.stringify(path === ROLLOUT_ROUTES.rollouts ? [plan] : path === API_ROUTES.containers ? [] : plan),
        {
          headers: { "content-type": "application/json" },
        },
      ),
  );
  show(request as unknown as typeof fetch);
  const promote = await screen.findByRole("button", { name: "Promote next cohort" });
  expect(promote).toHaveProperty("disabled", true);
  expect(screen.getByText(/mutable-tag update checks stop/)).toBeTruthy();
  expect(screen.getByText(/later failures require manual recovery/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText("I verified the service for this cohort."));
  expect(promote).toHaveProperty("disabled", false);
  fireEvent.click(promote);
  await waitFor(() =>
    expect(
      request.mock.calls.some(
        ([path, options]) => path.endsWith("/promote") && options.body === '{"serviceVerified":true}',
      ),
    ).toBe(true),
  );
});
it("offers no promotion for failed or inconclusive observations", async () => {
  show(
    vi.fn(
      async (path: string) =>
        new Response(
          JSON.stringify(
            path === ROLLOUT_ROUTES.rollouts ? [{ ...plan, status: "inconclusive", reason: "No fresh reports" }] : [],
          ),
          { headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch,
  );
  expect(await screen.findByText(/No fresh reports/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Promote next cohort" })).toBeNull();
});
it("shows a rollout whose saved state could not be read by its reason alone", async () => {
  const unreadable = { ...plan, status: "inconclusive", targets: [], current: 0, reason: ROLLOUT_REASONS.unreadable };
  show(
    vi.fn(
      async (path: string) =>
        new Response(JSON.stringify(path === ROLLOUT_ROUTES.rollouts ? [unreadable] : []), {
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch,
  );
  expect(await screen.findByText(ROLLOUT_REASONS.unreadable)).toBeTruthy();
  expect(screen.queryByText(/Cohort/)).toBeNull();
});

it("requires fresh service verification for each cohort of the same plan", async () => {
  let current = 0;
  show(
    vi.fn(async (path: string) => {
      if (path.endsWith("/promote")) current = 1;
      return new Response(JSON.stringify(path === ROLLOUT_ROUTES.rollouts ? [{ ...plan, current }] : []), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  );
  const promote = await screen.findByRole("button", { name: "Promote next cohort" });
  fireEvent.click(screen.getByLabelText("I verified the service for this cohort."));
  fireEvent.click(promote);
  const accept = await screen.findByRole("button", { name: "Accept final cohort" });
  expect(accept).toHaveProperty("disabled", true);
  expect(screen.getByLabelText("I verified the service for this cohort.")).toHaveProperty("checked", false);
});
