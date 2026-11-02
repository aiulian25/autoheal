import { QueryClient, QueryClientProvider, useQuery, useQueries } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_ROUTES, type JobView } from "../../src/shared/api.js";
import type { UpdateProgress } from "../../src/shared/protocol.js";
import { containersQuery, hostContainersQuery, hostsQuery, localHostQuery } from "./queries.js";
import { LIVE_INVENTORY_BATCH_MILLISECONDS } from "./constants.js";
import { useLiveUpdates } from "./live.js";

// The browser's EventSource, as much as the hook uses: the test sends what the control plane would.
class FakeEventSource {
  static opened: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((message: MessageEvent<string>) => void)[]>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.opened.push(this);
  }

  addEventListener(kind: string, listener: (message: MessageEvent<string>) => void) {
    this.listeners.set(kind, [...(this.listeners.get(kind) ?? []), listener]);
  }

  close() {
    this.closed = true;
  }

  send(kind: string, data: object) {
    for (const listener of this.listeners.get(kind) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent<string>);
    }
  }
}

const progress: UpdateProgress = {
  phase: "pulling",
  layers: [],
  downloaded: 1,
  total: 2,
  bytesPerSecond: null,
  log: [],
};

describe("the dashboard's live stream", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    FakeEventSource.opened = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    queryClient = new QueryClient();
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const listen = () =>
    renderHook(() => useLiveUpdates(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });
  const stale = (queryKey: readonly unknown[]) => queryClient.getQueryState(queryKey)?.isInvalidated;

  it("does not invalidate host A's container queries for an inventory event from host B", async () => {
    queryClient.setQueryData(["containers", "hostId=a"], []);
    queryClient.setQueryData(["containers", "hostId=b"], []);
    const hook = listen();
    act(() => FakeEventSource.opened[0]!.send("inventory", { hostId: "b" }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stale(["containers", "hostId=a"])).toBe(false);
    expect(stale(["containers", "hostId=b"])).toBe(true);
    hook.unmount();
  });

  it("coalesces many-host event bursts into only the relevant requests and refreshes shared fleet data", async () => {
    const ids = ["a", ...Array.from({ length: 99 }, (_, index) => `h${index}`)];
    const versions = new Map(ids.map((id) => [id, 1]));
    const row = (id: string) => ({ hostId: id, name: "app", image: `app:${versions.get(id)}` });
    const fetch = vi.fn(async (path: string) => {
      const url = new URL(path, "https://autoheal.test");
      const hostId = url.searchParams.get("hostId");
      const data =
        url.pathname === API_ROUTES.containers
          ? hostId
            ? [row(hostId)]
            : ids.map(row)
          : url.pathname === API_ROUTES.hosts
            ? ids.map((id) => ({ id }))
            : { hostId: "local", revoked: false };
      return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    const hook = renderHook(
      () => {
        useLiveUpdates();
        return useQueries({ queries: [...ids.map(hostContainersQuery), containersQuery, hostsQuery, localHostQuery] });
      },
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      },
    );
    await waitFor(() => expect(hook.result.current.every((result) => result.isSuccess)).toBe(true));
    expect(fetch).toHaveBeenCalledTimes(103);
    fetch.mockClear();
    const source = FakeEventSource.opened[0]!;
    versions.set("h0", 2);
    act(() => {
      for (let index = 0; index < 100; index++) source.send("inventory", { hostId: "h0" });
    });
    await waitFor(() =>
      expect(queryClient.getQueryData<{ image: string }[]>(hostContainersQuery("h0").queryKey)?.[0]?.image).toBe(
        "app:2",
      ),
    );
    expect(fetch.mock.calls.map(([path]) => path).sort()).toEqual(
      [`${API_ROUTES.containers}?hostId=h0`, API_ROUTES.containers, API_ROUTES.hosts].sort(),
    );
    expect(
      queryClient
        .getQueryData<{ hostId: string; image: string }[]>(containersQuery.queryKey)
        ?.find((row) => row.hostId === "h0")?.image,
    ).toBe("app:2");
    expect(stale(localHostQuery.queryKey)).toBe(false);
    fetch.mockClear();
    act(() => {
      for (const hostId of ids.slice(1))
        for (let repeat = 0; repeat < 2; repeat++) source.send("inventory", { hostId });
    });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(101));
    const paths = fetch.mock.calls.map(([path]) => path);
    expect(paths.filter((path) => path === API_ROUTES.containers)).toHaveLength(1);
    expect(paths.filter((path) => path === API_ROUTES.hosts)).toHaveLength(1);
    expect(paths.filter((path) => path === `${API_ROUTES.containers}?hostId=a`)).toHaveLength(0);
    for (const id of ids.slice(1))
      expect(paths.filter((path) => path === `${API_ROUTES.containers}?hostId=${id}`)).toHaveLength(1);
    hook.unmount();
  });

  it("does not restart a slow inventory request when another event batch arrives", async () => {
    const query = hostContainersQuery("b");
    queryClient.setQueryData(query.queryKey, ["old"]);
    let release!: (value: string[]) => void;
    const request = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          release = resolve;
        }),
    );
    const hook = renderHook(
      () => {
        useLiveUpdates();
        return useQuery({ ...query, queryFn: request, staleTime: Infinity });
      },
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      },
    );
    const source = FakeEventSource.opened[0]!;
    act(() => source.send("inventory", { hostId: "b" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    act(() => {
      for (let index = 0; index < 100; index++) source.send("inventory", { hostId: "b" });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, LIVE_INVENTORY_BATCH_MILLISECONDS + 50));
    });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => release(["current"]));
    await waitFor(() => expect(hook.result.current.data).toEqual(["current"]));
    hook.unmount();
  });

  it("clears a pending batch on unmount and lets a reconnect refresh supersede it", async () => {
    vi.useFakeTimers();
    queryClient.setQueryData(["containers", "hostId=a"], []);
    const invalidated = vi.spyOn(queryClient, "invalidateQueries");
    const hook = listen();
    const source = FakeEventSource.opened[0]!;
    source.send("inventory", { hostId: "a" });
    hook.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_INVENTORY_BATCH_MILLISECONDS);
    });
    expect(invalidated).not.toHaveBeenCalled();
    const next = listen();
    const reopened = FakeEventSource.opened[1]!;
    reopened.send("inventory", { hostId: "a" });
    reopened.send("open", {});
    expect(invalidated).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_INVENTORY_BATCH_MILLISECONDS);
    });
    expect(invalidated).toHaveBeenCalledTimes(1);
    next.unmount();
  });

  it("invalidates all cached page data whenever the connection opens again", () => {
    const keys = [["containers"], ["jobs", "h1"], ["board"], ["host-packages", "h2"], ["settings"]];
    for (const key of keys) queryClient.setQueryData(key, []);
    const hook = listen();
    const source = FakeEventSource.opened[0]!;
    source.send("open", {});
    expect(keys.every((key) => stale(key))).toBe(true);
    for (const key of keys) queryClient.setQueryData(key, []);
    source.send("open", {});
    expect(keys.every((key) => stale(key))).toBe(true);
    hook.unmount();
  });

  it("fetches current page data after a reconnect even when no change event was received", async () => {
    let current = 1;
    const hook = renderHook(
      () => {
        useLiveUpdates();
        return useQuery({ queryKey: ["current-page"], queryFn: async () => current, staleTime: Infinity });
      },
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      },
    );
    await waitFor(() => expect(hook.result.current.data).toBe(1));
    const source = FakeEventSource.opened[0]!;
    act(() => source.send("open", {}));
    current = 2;
    act(() => source.send("open", {}));
    await waitFor(() => expect(hook.result.current.data).toBe(2));
    hook.unmount();
  });

  it("has the pages read again what changed, puts an update's progress straight in place, and closes with them", async () => {
    for (const queryKey of [["containers", "hostId=h1"], ["hosts"], ["jobs", "h1"], ["update-run", "h1"], ["board"]]) {
      queryClient.setQueryData(queryKey, []);
    }
    queryClient.setQueryData<JobView[]>(["jobs", "h2"], [{ id: "j1", progress: null } as JobView]);
    const hook = listen();
    const [source] = FakeEventSource.opened;
    expect(source!.url).toBe(API_ROUTES.live);

    source!.send("progress", { kind: "progress", hostId: "h2", jobId: "j1", progress });
    expect(queryClient.getQueryData<JobView[]>(["jobs", "h2"])![0]!.progress).toEqual(progress);
    expect(stale(["jobs", "h2"])).toBe(false);

    source!.send("inventory", { kind: "inventory", hostId: "h1" });
    await waitFor(() => expect(stale(["containers", "hostId=h1"])).toBe(true));
    expect([stale(["containers", "hostId=h1"]), stale(["hosts"]), stale(["jobs", "h1"])]).toEqual([true, true, false]);

    source!.send("job", { kind: "job", hostId: "h1", jobId: "j9" });
    expect([stale(["jobs", "h1"]), stale(["update-run", "h1"]), stale(["board"])]).toEqual([true, true, true]);

    hook.unmount();
    expect(source!.closed).toBe(true);
  });
});
