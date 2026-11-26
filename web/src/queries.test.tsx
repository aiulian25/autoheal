import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobView } from "../../src/shared/api.js";
import { containerQueryMatchesHosts, hostContainersQuery, hostJobsQuery } from "./queries.js";
import { INVENTORY_REFRESH_MILLISECONDS, LIVE_SAFETY_REFRESH_MILLISECONDS } from "./constants.js";
import { liveHeard, liveLost } from "./live-health.js";

describe("inventory query scoping", () => {
  const changed = new Set(["b"]);
  it.each([
    [["containers", "hostId=a"], false],
    [["containers", "hostId=b"], true],
    [["containers", "search=app&hostId=a&problemsOnly=true"], false],
    [["containers", "hostId=b&search=app"], true],
    [["containers", "hostId=%62"], true],
    [["containers", "hostId=bb"], false],
    [["containers", "search=hostId%3Da"], true],
    [["containers", ""], true],
    [["containers", "host", "a"], false],
    [["containers", "host", "b"], true],
    [["containers"], true],
    [["hosts"], false],
  ] as const)("matches %j only when it can include the changed host", (key, matches) => {
    expect(containerQueryMatchesHosts(key, changed)).toBe(matches);
    expect(containerQueryMatchesHosts(key, new Set())).toBe(false);
  });
});

afterEach(() => vi.useRealTimers());
it("polls host containers after five seconds when no live stream is available", async () => {
  vi.useFakeTimers();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  let calls = 0;
  const query = hostContainersQuery("a");
  const hook = renderHook(() => useQuery({ ...query, queryFn: async () => ++calls }), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INVENTORY_REFRESH_MILLISECONDS - 1);
    });
    expect(calls).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(calls).toBe(2);
  } finally {
    hook.unmount();
    client.clear();
  }
});

describe("a host's jobs", () => {
  const job = (status: JobView["status"]) => ({ status }) as JobView;
  const interval = (jobs: JobView[]) => hostJobsQuery("a").refetchInterval({ state: { data: jobs } });
  afterEach(() => liveLost());

  it("are read every few seconds while one is on its way, whatever the stream says", () => {
    liveHeard();
    expect(interval([job("succeeded"), job("delivered")])).toBe(INVENTORY_REFRESH_MILLISECONDS);
    expect(interval([job("pending")])).toBe(INVENTORY_REFRESH_MILLISECONDS);
  });
  it("are otherwise left to the stream while it is healthy, and read every few seconds while it is not", () => {
    liveHeard();
    expect(interval([job("succeeded"), job("failed"), job("expired")])).toBe(LIVE_SAFETY_REFRESH_MILLISECONDS);
    liveLost();
    expect(interval([])).toBe(INVENTORY_REFRESH_MILLISECONDS);
  });
});
