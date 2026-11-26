import { QueryClient, QueryClientProvider, focusManager, useQuery, useQueries } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_ROUTES,
  type ContainerUsageView,
  type ContainerView,
  type HostMetricsView,
  type HostView,
  type JobView,
} from "../../src/shared/api.js";
import {
  CONTAINER_STATE_RUNNING,
  LIVE_KEEPALIVE_MILLISECONDS,
  METRICS_INTERVAL_MILLISECONDS,
} from "../../src/shared/constants.js";
import type { UpdateProgress } from "../../src/shared/protocol.js";
import {
  containersQuery,
  hostContainersQuery,
  hostMetricsQuery,
  hostPackagesQuery,
  hostsQuery,
  localHostQuery,
  overviewQuery,
} from "./queries.js";
import {
  INVENTORY_REFRESH_MILLISECONDS,
  LIVE_INVENTORY_BATCH_MILLISECONDS,
  LIVE_LOST_NOTICE_AFTER_MILLISECONDS,
  LIVE_READINGS_BATCH_MILLISECONDS,
  LIVE_RECONNECT_MILLISECONDS,
  LIVE_SAFETY_REFRESH_MILLISECONDS,
  LIVE_STALL_CHECK_MILLISECONDS,
  LIVE_STALL_MILLISECONDS,
} from "./constants.js";
import { liveAware } from "./live-health.js";
import { useLiveUpdates } from "./live.js";

const MINUTE = 60_000;

// The browser's EventSource, as much as the hook uses: the test sends what the control plane would.
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static opened: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((message: MessageEvent<string>) => void)[]>();
  closed = false;
  readyState = FakeEventSource.OPEN;

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

  // A dropped connection, which the browser tries again by itself.
  drop() {
    this.readyState = FakeEventSource.CONNECTING;
    this.send("error", {});
  }

  // An answer that is not the stream, such as a proxy's error page: the browser gives up on it for good.
  fail() {
    this.readyState = FakeEventSource.CLOSED;
    this.send("error", {});
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

  it("reads a host's package list again after its report or one of its jobs, and no other host's", async () => {
    const alder = hostPackagesQuery("a").queryKey;
    const cedar = hostPackagesQuery("b").queryKey;
    queryClient.setQueryData(alder, {});
    queryClient.setQueryData(cedar, {});
    const hook = listen();
    const source = FakeEventSource.opened[0]!;
    act(() => source.send("inventory", { hostId: "b", changed: false }));
    await new Promise((resolve) => setTimeout(resolve, LIVE_INVENTORY_BATCH_MILLISECONDS + 50));
    expect(stale(alder)).toBe(false);
    expect(stale(cedar)).toBe(true);
    act(() => source.send("job", { hostId: "a", jobId: "check" }));
    expect(stale(alder)).toBe(true);
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

  // A slow read, released by hand: what the page holds once it ends, and how many reads were made.
  const slowRead = (queryKey: readonly unknown[]) => {
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
        return useQuery({ queryKey, queryFn: request, staleTime: Infinity });
      },
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      },
    );
    return { hook, request, release: (value: string[]) => release(value) };
  };

  it("lets a slow inventory read finish through a burst, then reads once more for what came after it began", async () => {
    const query = hostContainersQuery("b");
    queryClient.setQueryData(query.queryKey, ["old"]);
    const { hook, request, release } = slowRead(query.queryKey);
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
    // What it answers was read before the burst: shown, then read once more.
    await act(async () => release(["before the burst"]));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await act(async () => release(["current"]));
    await waitFor(() => expect(hook.result.current.data).toEqual(["current"]));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, LIVE_INVENTORY_BATCH_MILLISECONDS + 50));
    });
    expect(request).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("reads the board once more when it changes while a read of it is on its way, and no more", async () => {
    queryClient.setQueryData(["board"], ["old"]);
    const { hook, request, release } = slowRead(["board"]);
    const source = FakeEventSource.opened[0]!;
    act(() => source.send("board", {}));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    act(() => {
      for (let index = 0; index < 10; index++) source.send("board", {});
    });
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => release(["missed the change"]));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await act(async () => release(["current"]));
    await waitFor(() => expect(hook.result.current.data).toEqual(["current"]));
    expect(request).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("puts hosts' readings in place without reading anything, together once a second, only where they belong", () => {
    vi.useFakeTimers();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const alder = { id: "a", metrics: null } as HostView;
    const cedar = { id: "b", metrics: null } as HostView;
    queryClient.setQueryData(hostsQuery.queryKey, [alder, cedar]);
    const web = { hostId: "a", name: "web", state: CONTAINER_STATE_RUNNING, usage: null } as ContainerView;
    const db = { hostId: "a", name: "db", state: "exited", usage: null } as ContainerView;
    // Running, but missing from the readings, and named like what every object has.
    const named = { hostId: "a", name: "toString", state: CONTAINER_STATE_RUNNING, usage: null } as ContainerView;
    const elsewhere = { hostId: "b", name: "web", state: CONTAINER_STATE_RUNNING, usage: null } as ContainerView;
    queryClient.setQueryData(containersQuery.queryKey, [web, db, named, elsewhere]);
    queryClient.setQueryData(hostContainersQuery("b").queryKey, [elsewhere]);
    const cedarListAt = queryClient.getQueryState(hostContainersQuery("b").queryKey)!.dataUpdatedAt;
    const earlier = { at: 1_000 } as HostMetricsView;
    queryClient.setQueryData(hostMetricsQuery("a").queryKey, [earlier]);
    const hook = listen();
    const source = FakeEventSource.opened[0]!;
    const reading = { at: 2_000 } as HostMetricsView;
    const usage = { at: 2_000, cpuPercent: 3 } as ContainerUsageView;
    act(() => source.send("metrics", { hostId: "a", host: earlier, containers: {} }));
    act(() => source.send("metrics", { hostId: "a", host: reading, containers: { web: usage, db: usage } }));
    expect(queryClient.getQueryData<HostView[]>(hostsQuery.queryKey)![0]!.metrics).toBeNull();

    act(() => vi.advanceTimersByTime(LIVE_READINGS_BATCH_MILLISECONDS));
    const hosts = queryClient.getQueryData<HostView[]>(hostsQuery.queryKey)!;
    expect(hosts.map((host) => host.metrics)).toEqual([reading, null]);
    expect(hosts[1]).toBe(cedar);
    const listed = queryClient.getQueryData<ContainerView[]>(containersQuery.queryKey)!;
    expect(listed.map((container) => container.usage)).toEqual([usage, null, null, null]);
    expect(listed[3]).toBe(elsewhere);
    expect(queryClient.getQueryState(hostContainersQuery("b").queryKey)!.dataUpdatedAt).toBe(cedarListAt);
    expect(queryClient.getQueryData(hostMetricsQuery("a").queryKey)).toEqual([earlier, reading]);
    expect(fetch).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("reads a host's container lists again when its readings are too many to carry, and no other host's", () => {
    vi.useFakeTimers();
    for (const queryKey of [hostContainersQuery("a").queryKey, hostContainersQuery("b").queryKey]) {
      queryClient.setQueryData(queryKey, []);
    }
    queryClient.setQueryData(containersQuery.queryKey, []);
    const hook = listen();
    act(() => FakeEventSource.opened[0]!.send("metrics", { hostId: "a", host: null, containers: null }));
    act(() => vi.advanceTimersByTime(LIVE_READINGS_BATCH_MILLISECONDS));
    expect(stale(hostContainersQuery("a").queryKey)).toBe(true);
    expect(stale(containersQuery.queryKey)).toBe(true);
    expect(stale(hostContainersQuery("b").queryKey)).toBe(false);
    hook.unmount();
  });

  it("reads what the stream keeps current seldom while it says it is alive, and every few seconds once it goes quiet", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (path: string) => {
      const data = path === API_ROUTES.overview ? {} : [];
      return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    const hook = renderHook(
      () => {
        useLiveUpdates();
        return useQueries({ queries: [hostsQuery, containersQuery, overviewQuery] });
      },
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      },
    );
    const source = FakeEventSource.opened[0]!;
    // Reads of each path over a minute, the stream saying it is alive throughout or not at all.
    const readsInAMinute = async (alive: boolean) => {
      fetch.mockClear();
      for (let elapsed = 0; elapsed < MINUTE; elapsed += LIVE_KEEPALIVE_MILLISECONDS) {
        if (alive) act(() => source.send("alive", {}));
        await act(() => vi.advanceTimersByTimeAsync(LIVE_KEEPALIVE_MILLISECONDS));
      }
      const paths = fetch.mock.calls.map(([path]) => path);
      return [API_ROUTES.hosts, API_ROUTES.containers, API_ROUTES.overview].map(
        (route) => paths.filter((path) => path === route).length,
      );
    };
    await readsInAMinute(true);
    const healthy = await readsInAMinute(true);
    expect(healthy.every((reads) => reads >= 1 && reads <= MINUTE / LIVE_SAFETY_REFRESH_MILLISECONDS)).toBe(true);
    // Quiet long enough to be found out, then every few seconds again.
    await readsInAMinute(false);
    const quiet = await readsInAMinute(false);
    expect(quiet.every((reads) => reads >= MINUTE / INVENTORY_REFRESH_MILLISECONDS - 1)).toBe(true);
    hook.unmount();
  });

  it("reads the lists readings go into now and then all the same, though each reading starts their own refresh over", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify([{ id: "a", metrics: null }]), { headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetch);
    const hook = renderHook(
      () => {
        useLiveUpdates();
        return useQuery(hostsQuery);
      },
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      },
    );
    const source = FakeEventSource.opened[0]!;
    await act(() => vi.advanceTimersByTimeAsync(0));
    // Reads over a minute of readings every few seconds.
    const readsInAMinute = async () => {
      fetch.mockClear();
      for (let elapsed = 0; elapsed < MINUTE; elapsed += METRICS_INTERVAL_MILLISECONDS) {
        act(() => {
          source.send("alive", {});
          source.send("metrics", { hostId: "a", host: { at: Date.now() }, containers: {} });
        });
        await act(() => vi.advanceTimersByTimeAsync(METRICS_INTERVAL_MILLISECONDS));
      }
      return fetch.mock.calls.length;
    };
    expect(await readsInAMinute()).toBe(MINUTE / LIVE_SAFETY_REFRESH_MILLISECONDS);
    expect(hook.result.current.data?.[0]?.metrics).not.toBeNull();
    // A page nobody looks at reads nothing on a timer.
    focusManager.setFocused(false);
    try {
      expect(await readsInAMinute()).toBe(0);
    } finally {
      focusManager.setFocused(undefined);
    }
    hook.unmount();
  });

  it("opens the stream again once it stops saying it is alive, and leaves one that keeps saying it", () => {
    vi.useFakeTimers();
    const hook = listen();
    const first = FakeEventSource.opened[0]!;
    act(() => first.send("open", {}));
    for (let beat = 0; beat < 8; beat++) {
      act(() => first.send("alive", {}));
      act(() => vi.advanceTimersByTime(LIVE_KEEPALIVE_MILLISECONDS));
    }
    expect(FakeEventSource.opened).toHaveLength(1);
    act(() => vi.advanceTimersByTime(LIVE_STALL_MILLISECONDS - LIVE_KEEPALIVE_MILLISECONDS));
    expect(FakeEventSource.opened).toHaveLength(1);
    act(() => vi.advanceTimersByTime(LIVE_STALL_CHECK_MILLISECONDS));
    expect(first.closed).toBe(true);
    expect(FakeEventSource.opened).toHaveLength(2);
    hook.unmount();
  });

  it("does not take a stream that opens and passes nothing for a healthy one, and opens it again after the same wait", () => {
    vi.useFakeTimers();
    const hook = listen();
    // As behind a proxy that holds the stream back.
    act(() => FakeEventSource.opened[0]!.send("open", {}));
    expect(liveAware(INVENTORY_REFRESH_MILLISECONDS)()).toBe(INVENTORY_REFRESH_MILLISECONDS);
    act(() => vi.advanceTimersByTime(LIVE_STALL_MILLISECONDS));
    expect(FakeEventSource.opened).toHaveLength(1);
    act(() => vi.advanceTimersByTime(LIVE_STALL_CHECK_MILLISECONDS));
    expect(FakeEventSource.opened).toHaveLength(2);
    act(() => FakeEventSource.opened[1]!.send("alive", {}));
    expect(liveAware(INVENTORY_REFRESH_MILLISECONDS)()).toBe(LIVE_SAFETY_REFRESH_MILLISECONDS);
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

  it("reads the board and every list of tasks or incidents again once they change, and nothing else", () => {
    const keys = [["board"], ["tasks", "host", "h1"], ["incidents", "open"], ["containers", "hostId=a"]];
    for (const key of keys) queryClient.setQueryData(key, []);
    const hook = listen();
    act(() => FakeEventSource.opened[0]!.send("board", {}));
    expect(stale(["board"])).toBe(true);
    expect(stale(["tasks", "host", "h1"])).toBe(true);
    expect(stale(["incidents", "open"])).toBe(true);
    expect(stale(["containers", "hostId=a"])).toBe(false);
    hook.unmount();
  });

  it("opens a new stream once the browser gives up on one, as behind a proxy while the control plane restarts", () => {
    vi.useFakeTimers();
    queryClient.setQueryData(["settings"], { version: "1.3.6" });
    const hook = listen();
    // A drop the browser tries again by itself leaves it to the browser.
    act(() => FakeEventSource.opened[0]!.drop());
    act(() => vi.advanceTimersByTime(LIVE_RECONNECT_MILLISECONDS));
    expect(FakeEventSource.opened).toHaveLength(1);

    act(() => FakeEventSource.opened[0]!.fail());
    act(() => vi.advanceTimersByTime(LIVE_RECONNECT_MILLISECONDS - 1));
    expect(FakeEventSource.opened).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeEventSource.opened).toHaveLength(2);
    // Its opening reads everything again, the version the restarted control plane runs among it.
    act(() => FakeEventSource.opened[1]!.send("open", {}));
    expect(stale(["settings"])).toBe(true);

    // Closed with the page, it opens no other.
    act(() => FakeEventSource.opened[1]!.fail());
    hook.unmount();
    act(() => vi.advanceTimersByTime(LIVE_RECONNECT_MILLISECONDS));
    expect(FakeEventSource.opened).toHaveLength(2);
    expect(FakeEventSource.opened[1]!.closed).toBe(true);
  });

  it("says when it has been out of contact a while, from the moment it was lost, until a stream opens again", () => {
    vi.useFakeTimers();
    const hook = listen();
    const lostAt = Date.now();
    act(() => FakeEventSource.opened[0]!.drop());
    act(() => vi.advanceTimersByTime(LIVE_LOST_NOTICE_AFTER_MILLISECONDS - 1));
    expect(hook.result.current).toBeNull();
    // The browser trying again, and failing, does not move the moment it was lost.
    act(() => FakeEventSource.opened[0]!.drop());
    act(() => vi.advanceTimersByTime(1));
    expect(hook.result.current).toBe(lostAt);

    // Nor does a stream opened anew that fails too.
    act(() => FakeEventSource.opened[0]!.fail());
    act(() => vi.advanceTimersByTime(LIVE_RECONNECT_MILLISECONDS));
    act(() => FakeEventSource.opened[1]!.fail());
    act(() => vi.advanceTimersByTime(LIVE_LOST_NOTICE_AFTER_MILLISECONDS));
    expect(hook.result.current).toBe(lostAt);

    act(() => FakeEventSource.opened[2]!.send("open", {}));
    expect(hook.result.current).toBeNull();
    hook.unmount();
  });

  it("says nothing of a drop that is over before then", () => {
    vi.useFakeTimers();
    const hook = listen();
    act(() => FakeEventSource.opened[0]!.drop());
    act(() => vi.advanceTimersByTime(LIVE_LOST_NOTICE_AFTER_MILLISECONDS - 1));
    act(() => FakeEventSource.opened[0]!.send("open", {}));
    act(() => vi.advanceTimersByTime(LIVE_LOST_NOTICE_AFTER_MILLISECONDS));
    expect(hook.result.current).toBeNull();

    // A drop after that is counted from its own moment.
    const lostAgainAt = Date.now();
    act(() => FakeEventSource.opened[0]!.drop());
    act(() => vi.advanceTimersByTime(LIVE_LOST_NOTICE_AFTER_MILLISECONDS));
    expect(hook.result.current).toBe(lostAgainAt);
    hook.unmount();
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

    // What a running job wrote: the lists that show it, and nothing of the board.
    for (const queryKey of [["jobs", "h1"], ["update-run", "h1"], ["board"], hostPackagesQuery("h1").queryKey]) {
      queryClient.setQueryData(queryKey, []);
    }
    source!.send("job", { kind: "job", hostId: "h1", jobId: "j9", output: true });
    expect([stale(["jobs", "h1"]), stale(hostPackagesQuery("h1").queryKey)]).toEqual([true, true]);
    expect([stale(["update-run", "h1"]), stale(["board"])]).toEqual([false, false]);

    hook.unmount();
    expect(source!.closed).toBe(true);
  });
});
