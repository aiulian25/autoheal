// What changes on the hosts as it changes: one stream for the whole signed-in dashboard.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { API_ROUTES, type JobView } from "../../src/shared/api.js";
import { LIVE_EVENT } from "../../src/shared/constants.js";
import type { UpdateProgress } from "../../src/shared/protocol.js";
import { LIVE_INVENTORY_BATCH_MILLISECONDS, LIVE_RECONNECT_MILLISECONDS } from "./constants.js";
import { containerQueryMatchesHosts } from "./queries.js";

interface HostEvent {
  hostId: string;
}

// The queries that show tasks or incidents, by the first part of their key.
const BOARD_FAMILIES: ReadonlySet<string> = new Set(["board", "tasks", "task", "incidents", "incident", "overview"]);

interface ProgressEvent extends HostEvent {
  jobId: string;
  progress: UpdateProgress;
}

/**
 * Listens to the control plane's live stream and keeps the pages' data current: a host's containers read again
 * shortly after its runner reports, its jobs the moment one moves, an update's progress put straight in place. The
 * browser connects again by itself after a drop, but gives up for good on an answer that is not the stream, such as a
 * reverse proxy's error page while the control plane restarts: then a new stream is opened a little later. Every open
 * refreshes cached queries to cover missed events.
 */
export function useLiveUpdates() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let source: EventSource | null = null;
    let reconnectTimer: number | undefined;
    const inventoryHosts = new Set<string>();
    let inventoryTimer: number | undefined;
    const clearInventory = () => {
      window.clearTimeout(inventoryTimer);
      inventoryTimer = undefined;
      inventoryHosts.clear();
    };
    const refreshInventory = () => {
      inventoryTimer = undefined;
      const changed = new Set(inventoryHosts);
      inventoryHosts.clear();
      if (changed.size === 0) return;
      void queryClient.invalidateQueries(
        {
          predicate: ({ queryKey }) =>
            containerQueryMatchesHosts(queryKey, changed) || (queryKey.length === 1 && queryKey[0] === "hosts"),
        },
        { cancelRefetch: false },
      );
    };
    const read = <Event>(message: MessageEvent<string>) => JSON.parse(message.data) as Event;
    const listen = () => {
      const current = new EventSource(API_ROUTES.live);
      source = current;
      current.addEventListener("error", () => {
        if (current.readyState !== EventSource.CLOSED) return;
        reconnectTimer ??= window.setTimeout(() => {
          reconnectTimer = undefined;
          listen();
        }, LIVE_RECONNECT_MILLISECONDS);
      });
      current.addEventListener("open", () => {
        clearInventory();
        void queryClient.invalidateQueries();
      });
      current.addEventListener(LIVE_EVENT.inventory, (message) => {
        inventoryHosts.add(read<HostEvent>(message).hostId);
        inventoryTimer ??= window.setTimeout(refreshInventory, LIVE_INVENTORY_BATCH_MILLISECONDS);
      });
      current.addEventListener(LIVE_EVENT.job, (message) => {
        const { hostId } = read<HostEvent>(message);
        void queryClient.invalidateQueries({ queryKey: ["jobs", hostId] });
        void queryClient.invalidateQueries({ queryKey: ["update-run", hostId] });
        void queryClient.invalidateQueries({ queryKey: ["board"] });
      });
      // A task or an incident changed: the board, and every list of either, read again.
      current.addEventListener(LIVE_EVENT.board, () => {
        void queryClient.invalidateQueries(
          { predicate: ({ queryKey }) => BOARD_FAMILIES.has(String(queryKey[0])) },
          { cancelRefetch: false },
        );
      });
      current.addEventListener(LIVE_EVENT.progress, (message) => {
        const { hostId, jobId, progress } = read<ProgressEvent>(message);
        queryClient.setQueryData<JobView[]>(["jobs", hostId], (jobs) =>
          jobs?.map((job) => (job.id === jobId ? { ...job, progress } : job)),
        );
      });
    };
    listen();
    return () => {
      clearInventory();
      window.clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [queryClient]);
}
