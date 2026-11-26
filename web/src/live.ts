// What changes on the hosts as it changes: one stream for the whole signed-in dashboard.

import { focusManager, useQueryClient, type QueryClient, type QueryFilters } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  API_ROUTES,
  type ContainerUsageView,
  type ContainerView,
  type HostMetricsView,
  type HostView,
  type JobView,
} from "../../src/shared/api.js";
import { LIVE_EVENT } from "../../src/shared/constants.js";
import type { UpdateProgress } from "../../src/shared/protocol.js";
import {
  LIVE_INVENTORY_BATCH_MILLISECONDS,
  LIVE_LOST_NOTICE_AFTER_MILLISECONDS,
  LIVE_READINGS_BATCH_MILLISECONDS,
  LIVE_RECONNECT_MILLISECONDS,
  LIVE_SAFETY_REFRESH_MILLISECONDS,
  LIVE_STALL_CHECK_MILLISECONDS,
  LIVE_STALL_MILLISECONDS,
} from "./constants.js";
import { liveHeard, liveIsHealthy, liveLost } from "./live-health.js";
import { withContainerUsage, withHistoryPoint, withHostMetrics } from "./live-patches.js";
import { QUERY_KEYS, containerQueryMatchesHosts, hostMetricsQuery, hostPackagesQuery, hostsQuery } from "./queries.js";

interface HostEvent {
  hostId: string;
}

interface JobEvent extends HostEvent {
  // All that changed is what the running job wrote: only the lists that show it are read again.
  output?: true;
}

// The queries that show tasks or incidents, by the first part of their key.
const BOARD_FAMILIES: ReadonlySet<string> = new Set(["board", "tasks", "task", "incidents", "incident", "overview"]);

interface ProgressEvent extends HostEvent {
  jobId: string;
  progress: UpdateProgress;
}

interface MetricsEvent extends HostEvent {
  host: HostMetricsView | null;
  // Null when the host has too many containers to carry: their lists are read instead.
  containers: Record<string, ContainerUsageView> | null;
}

type QueryKey = readonly unknown[];
type ReadAgain = (filters: QueryFilters) => void;

const isHostsList = (queryKey: QueryKey) => queryKey.length === 1 && queryKey[0] === QUERY_KEYS.hosts;

// What a host's report changes: its containers' lists, the hosts list and the overview's counts, its package list.
const changedByReports = (queryKey: QueryKey, hostIds: ReadonlySet<string>) =>
  containerQueryMatchesHosts(queryKey, hostIds) ||
  isHostsList(queryKey) ||
  queryKey[0] === QUERY_KEYS.overview ||
  (queryKey[0] === QUERY_KEYS.hostPackages && hostIds.has(String(queryKey[1])));

// The lists readings go into. A query's own refresh starts over whenever its data changes, and readings come every few
// seconds, so these are read again now and then from here instead.
const takesReadings = (queryKey: QueryKey) => isHostsList(queryKey) || queryKey[0] === QUERY_KEYS.containers;

/** Hosts' new readings put in place, in the hosts list, the containers' lists and the charts: nothing is read again. */
function takeReadings(queryClient: QueryClient, readAgain: ReadAgain, readings: readonly MetricsEvent[]) {
  const hostReadings = new Map(readings.map(({ hostId, host }) => [hostId, host]));
  queryClient.setQueryData<HostView[]>(hostsQuery.queryKey, (hosts) => withHostMetrics(hosts, hostReadings));
  for (const { hostId, host } of readings) {
    if (host === null) continue;
    queryClient.setQueryData<HostMetricsView[]>(hostMetricsQuery(hostId).queryKey, (points) =>
      withHistoryPoint(points, host),
    );
  }
  const unlisted = new Set(readings.filter(({ containers }) => containers === null).map(({ hostId }) => hostId));
  if (unlisted.size > 0) readAgain({ predicate: ({ queryKey }) => containerQueryMatchesHosts(queryKey, unlisted) });
  const usage = new Map(
    readings.flatMap(({ hostId, containers }) => (containers === null ? [] : [[hostId, containers] as const])),
  );
  if (usage.size === 0) return;
  queryClient.setQueriesData<ContainerView[]>({ queryKey: [QUERY_KEYS.containers] }, (list) =>
    withContainerUsage(list, usage),
  );
}

/**
 * Listens to the control plane's live stream and keeps the pages' data current: a host's containers read again
 * shortly after its runner reports, its readings put straight in place as they come, its jobs the moment one moves, an
 * update's progress too. The browser connects again by itself after a drop, but gives up for good on an answer that is
 * not the stream, such as a reverse proxy's error page while the control plane restarts: then a new stream is opened a
 * little later. A stream that stays open but stops saying it is alive is opened again. Every open refreshes cached
 * queries to cover missed events.
 *
 * Returns when contact was lost, once it has been lost for a while, and null while there is contact.
 */
export function useLiveUpdates(): number | null {
  const queryClient = useQueryClient();
  const [lostSince, setLostSince] = useState<number | null>(null);
  useEffect(() => {
    let source: EventSource | null = null;
    // Silence is counted from when the stream opened or from the last thing it said, whichever came later.
    let openedAt = Date.now();
    let reconnectTimer: number | undefined;
    let lostTimer: number | undefined;
    const lose = () => {
      liveLost();
      const lostAt = Date.now();
      lostTimer ??= window.setTimeout(() => setLostSince(lostAt), LIVE_LOST_NOTICE_AFTER_MILLISECONDS);
    };
    // Read while what it shows changed again: once that read ends, one more, so what it missed shows.
    const changedWhileRead = new Set<string>();
    const stopFollowingReads = queryClient.getQueryCache().subscribe(({ query }) => {
      if (!changedWhileRead.has(query.queryHash) || query.state.fetchStatus !== "idle") return;
      changedWhileRead.delete(query.queryHash);
      void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false });
    });
    // A read already on its way is left to finish, not started over for every change.
    const readAgain: ReadAgain = (filters) => {
      for (const query of queryClient.getQueryCache().findAll(filters)) {
        if (query.state.fetchStatus === "fetching") changedWhileRead.add(query.queryHash);
      }
      void queryClient.invalidateQueries(filters, { cancelRefetch: false });
    };
    const inventoryHosts = new Set<string>();
    let inventoryTimer: number | undefined;
    const readings = new Map<string, MetricsEvent>();
    let readingsTimer: number | undefined;
    const clearBatches = () => {
      window.clearTimeout(inventoryTimer);
      window.clearTimeout(readingsTimer);
      inventoryTimer = undefined;
      readingsTimer = undefined;
      inventoryHosts.clear();
      readings.clear();
    };
    const refreshInventory = () => {
      inventoryTimer = undefined;
      const changed = new Set(inventoryHosts);
      inventoryHosts.clear();
      if (changed.size === 0) return;
      readAgain({ predicate: ({ queryKey }) => changedByReports(queryKey, changed) });
    };
    const putReadings = () => {
      readingsTimer = undefined;
      const latest = [...readings.values()];
      readings.clear();
      takeReadings(queryClient, readAgain, latest);
    };
    const read = <Event>(message: MessageEvent<string>) => JSON.parse(message.data) as Event;
    // Whatever the stream says, it says it is alive.
    const heard =
      (handle: (message: MessageEvent<string>) => void = () => undefined) =>
      (message: MessageEvent<string>) => {
        liveHeard();
        handle(message);
      };
    const listen = () => {
      const current = new EventSource(API_ROUTES.live);
      source = current;
      current.addEventListener("error", () => {
        lose();
        if (current.readyState !== EventSource.CLOSED) return;
        reconnectTimer ??= window.setTimeout(() => {
          reconnectTimer = undefined;
          listen();
        }, LIVE_RECONNECT_MILLISECONDS);
      });
      // Open is not yet heard: a proxy that holds the stream back opens it and passes nothing.
      current.addEventListener("open", () => {
        openedAt = Date.now();
        window.clearTimeout(lostTimer);
        lostTimer = undefined;
        setLostSince(null);
        clearBatches();
        changedWhileRead.clear();
        void queryClient.invalidateQueries();
      });
      current.addEventListener(LIVE_EVENT.alive, heard());
      current.addEventListener(
        LIVE_EVENT.inventory,
        heard((message) => {
          inventoryHosts.add(read<HostEvent>(message).hostId);
          inventoryTimer ??= window.setTimeout(refreshInventory, LIVE_INVENTORY_BATCH_MILLISECONDS);
        }),
      );
      current.addEventListener(
        LIVE_EVENT.metrics,
        heard((message) => {
          const reading = read<MetricsEvent>(message);
          readings.set(reading.hostId, reading);
          readingsTimer ??= window.setTimeout(putReadings, LIVE_READINGS_BATCH_MILLISECONDS);
        }),
      );
      current.addEventListener(
        LIVE_EVENT.job,
        heard((message) => {
          const { hostId, output } = read<JobEvent>(message);
          readAgain({ queryKey: ["jobs", hostId] });
          readAgain({ queryKey: hostPackagesQuery(hostId).queryKey });
          if (output === true) return;
          readAgain({ queryKey: ["update-run", hostId] });
          readAgain({ queryKey: ["board"] });
        }),
      );
      // A task or an incident changed: the board, and every list of either, read again.
      current.addEventListener(
        LIVE_EVENT.board,
        heard(() => readAgain({ predicate: ({ queryKey }) => BOARD_FAMILIES.has(String(queryKey[0])) })),
      );
      current.addEventListener(
        LIVE_EVENT.progress,
        heard((message) => {
          const { hostId, jobId, progress } = read<ProgressEvent>(message);
          queryClient.setQueryData<JobView[]>(["jobs", hostId], (jobs) =>
            jobs?.map((job) => (job.id === jobId ? { ...job, progress } : job)),
          );
        }),
      );
    };
    // Open, yet silent past its alive beats: it stopped telling without an error, so it is opened again.
    const stallTimer = window.setInterval(() => {
      const now = Date.now();
      if (source?.readyState !== EventSource.OPEN || liveIsHealthy(now) || now - openedAt <= LIVE_STALL_MILLISECONDS)
        return;
      source.close();
      lose();
      listen();
    }, LIVE_STALL_CHECK_MILLISECONDS);
    // A hidden page reads nothing on a timer: it reads what went stale once it is looked at again.
    const safetyTimer = window.setInterval(() => {
      if (liveIsHealthy() && focusManager.isFocused())
        readAgain({ predicate: ({ queryKey }) => takesReadings(queryKey) });
    }, LIVE_SAFETY_REFRESH_MILLISECONDS);
    listen();
    return () => {
      clearBatches();
      stopFollowingReads();
      window.clearInterval(stallTimer);
      window.clearInterval(safetyTimer);
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(lostTimer);
      liveLost();
      source?.close();
    };
  }, [queryClient]);
  return lostSince;
}
