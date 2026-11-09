// What a person hands to the Ollama agent on Attention, by ticking or dragging onto its card, and the hand-over.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type DragEvent } from "react";
import {
  API_ROUTES,
  hasNewerVersion,
  hasUpdate,
  type AgentDispatchRequest,
  type AgentDispatchView,
  type BoardCardView,
  type ContainerView,
  type HostPackagesView,
  type HostView,
} from "../../src/shared/api.js";
import { BOARD_CARD, CONTROL_LOCK, HOST_PACKAGES, HOST_STATE } from "../../src/shared/constants.js";
import { imageTag } from "../../src/shared/image-reference.js";
import { isNewMajor } from "../../src/shared/image-versions.js";
import { api } from "./api-client.js";
import { AGENT_DRAG_TYPE, HAND_OVER_SEPARATOR } from "./constants.js";

export const HAND_OVER = { update: "update", package: "package", incident: "incident", tag: "tag" } as const;

// What changes once Ollama has them: the board, the tasks, the incidents and the hosts' packages.
const CHANGED_QUERIES = ["board", "tasks", "incidents", "host-packages", "containers", "jobs"];

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

/** A database's new major version: it needs a dump and a restore, not a new tag, so it is never handed over. */
export const isDatabaseMajor = (container: ContainerView) =>
  container.byItself.updateLock === CONTROL_LOCK.database &&
  container.update.newerTag != null &&
  isNewMajor(imageTag(container.image), container.update.newerTag);

/** A newer version the agent can move to: by a Compose file, on a host that acts and whose runner can. */
export const tagHandable = (host: HostView | undefined, container: ContainerView) =>
  host?.state === HOST_STATE.online &&
  host.dryRun === false &&
  host.containerAccess === true &&
  host.hostDeploy === true &&
  host.tagChanges === true &&
  container.handsOff === null &&
  container.composeProject !== null &&
  hasNewerVersion(container) &&
  !isDatabaseMajor(container);

export const updateItem = (taskId: string) => [HAND_OVER.update, taskId].join(HAND_OVER_SEPARATOR);
export const packageItem = (hostId: string, name: string) =>
  [HAND_OVER.package, hostId, name].join(HAND_OVER_SEPARATOR);
export const incidentItem = (incidentId: string) => [HAND_OVER.incident, incidentId].join(HAND_OVER_SEPARATOR);
// Neither a container's name nor a tag holds the separator.
export const tagItem = (container: ContainerView) =>
  [HAND_OVER.tag, container.hostId, container.name, container.update.newerTag ?? ""].join(HAND_OVER_SEPARATOR);

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
    return kind === HAND_OVER.package || kind === HAND_OVER.tag ? id : (hostOf.get(item) ?? null);
  });
}

/** The keys as the control plane takes them: each host's packages together. */
export function requestOf(items: readonly string[]): AgentDispatchRequest {
  const packages = new Map<string, string[]>();
  const request: AgentDispatchRequest = { updates: [], packages: [], incidents: [], tags: [] };
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
    if (kind === HAND_OVER.tag) {
      request.tags.push({ hostId: id, container: name[0] ?? "", tag: name[1] ?? "" });
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

export const handedCount = ({ updates, packages, incidents, tags }: AgentDispatchView) =>
  updates + packages + incidents + tags;
