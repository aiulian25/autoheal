// What a person hands to the Ollama agent on Attention, by ticking or dragging onto its card, and the hand-over.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type DragEvent } from "react";
import {
  API_ROUTES,
  hasUpdate,
  type AgentDispatchRequest,
  type AgentDispatchView,
  type BoardCardView,
  type ContainerView,
  type HostPackagesView,
  type HostView,
} from "../../src/shared/api.js";
import { BOARD_CARD, HOST_PACKAGES, HOST_STATE } from "../../src/shared/constants.js";
import { api } from "./api-client.js";
import { AGENT_DRAG_TYPE, HAND_OVER_SEPARATOR } from "./constants.js";

export const HAND_OVER = { update: "update", package: "package", incident: "incident" } as const;

// What changes once Ollama has them: the board, the tasks, the incidents and the hosts' packages.
const CHANGED_QUERIES = ["board", "tasks", "incidents", "host-packages"];

// What its runner would refuse is not offered: the checks the control plane makes before it takes anything.
export const updateHandable = (container: ContainerView | undefined) =>
  container !== undefined && container.handsOff === null && hasUpdate(container);
export const packagesHandable = (host: HostView, view: HostPackagesView) =>
  host.dryRun === false &&
  view.facts?.setting === HOST_PACKAGES.apply &&
  view.facts.unsupported === null &&
  view.running === null;
export const incidentHandable = (host: HostView | undefined, container: ContainerView | undefined) =>
  host?.state === HOST_STATE.online && host.dryRun === false && container?.handsOff === null;

export const updateItem = (taskId: string) => [HAND_OVER.update, taskId].join(HAND_OVER_SEPARATOR);
export const packageItem = (hostId: string, name: string) =>
  [HAND_OVER.package, hostId, name].join(HAND_OVER_SEPARATOR);
export const incidentItem = (incidentId: string) => [HAND_OVER.incident, incidentId].join(HAND_OVER_SEPARATOR);

/** Which host each key's work is on, as the cards on the page say; null where none does. */
export function hostsOfItems(items: readonly string[], cards: readonly BoardCardView[]): (string | null)[] {
  const hostOf = new Map(
    cards.map((card) =>
      card.kind === BOARD_CARD.incident
        ? ([incidentItem(card.incident.id), card.incident.hostId] as const)
        : ([updateItem(card.task.id), card.task.hostId] as const),
    ),
  );
  return items.map((item) => {
    const [kind, id = ""] = item.split(HAND_OVER_SEPARATOR);
    return kind === HAND_OVER.package ? id : (hostOf.get(item) ?? null);
  });
}

/** The keys as the control plane takes them: each host's packages together. */
export function requestOf(items: readonly string[]): AgentDispatchRequest {
  const packages = new Map<string, string[]>();
  const request: AgentDispatchRequest = { updates: [], packages: [], incidents: [] };
  for (const item of items) {
    // A package's name may hold the separator itself (libc6:i386): it is all that follows the host's id.
    const [kind, id = "", ...name] = item.split(HAND_OVER_SEPARATOR);
    if (kind === HAND_OVER.update) {
      request.updates.push(id);
    }
    if (kind === HAND_OVER.incident) {
      request.incidents.push(id);
    }
    if (kind === HAND_OVER.package) {
      packages.set(id, [...(packages.get(id) ?? []), name.join(HAND_OVER_SEPARATOR)]);
    }
  }
  request.packages = [...packages].map(([hostId, names]) => ({ hostId, names }));
  return request;
}

/** A row's drag carries the ticked items when it is one of them, else itself alone. */
export function startDrag(event: DragEvent, item: string, selected: ReadonlySet<string>) {
  event.dataTransfer.setData(AGENT_DRAG_TYPE, JSON.stringify(selected.has(item) ? [...selected] : [item]));
  event.dataTransfer.effectAllowed = "move";
}

export const carriesHandOver = (event: DragEvent) => event.dataTransfer.types.includes(AGENT_DRAG_TYPE);

/** What was dropped, as keys; anything else dropped there is nothing. */
export function droppedItems(event: DragEvent): string[] {
  try {
    const dropped: unknown = JSON.parse(event.dataTransfer.getData(AGENT_DRAG_TYPE));
    return Array.isArray(dropped) ? dropped.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** The ticked items, across every host's updates. */
export function useSelection() {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const toggle = (item: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(item)) {
        next.add(item);
      }
      return next;
    });
  return { selected, toggle, select: (items: readonly string[]) => setSelected(new Set(items)) };
}

export type Selection = ReturnType<typeof useSelection>;

/** Hands the items to the agent; once it has them, what they changed is read again. */
export function useHandOver() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (items: readonly string[]) =>
      api<AgentDispatchView>("POST", API_ROUTES.agentDispatch, requestOf(items)),
    onSettled: () => Promise.all(CHANGED_QUERIES.map((key) => queryClient.invalidateQueries({ queryKey: [key] }))),
  });
}

export const handedCount = ({ updates, packages, incidents }: AgentDispatchView) => updates + packages + incidents;
