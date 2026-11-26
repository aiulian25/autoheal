import { useMutation, useQueryClient } from "@tanstack/react-query";
import { API_ROUTES, apiPath, type TaskChangeRequest } from "../../../../src/shared/api.js";
import { api } from "../../api-client.js";
import { Icon } from "../../components/icons.js";
import { ATTENTION_PLACE, PATHS, SETTINGS_SECTIONS, TEXT, type AttentionPlaceKind } from "../../constants.js";
import { hostLink } from "../../host-links.js";
import { boardQuery } from "../../queries.js";

// Updates and escalated incidents dropped on the Ollama agent's card, as their keys.
export type HandOver = (items: readonly string[]) => void;

// The default has no name of its own.
export const serverLabel = (name: string | null) => name ?? TEXT.attention.ollama.defaultName;

// The handle a row is dragged by onto the Ollama agent: its words are the tick's, or the row's button.
export const Grip = () => <Icon name="grip" className="grip" />;

export function SectionLabel({
  tone,
  text,
  count,
}: {
  tone: "warning" | "danger" | "accent";
  text: { label: string; hint: string };
  // How many it holds, where that is worth a glance.
  count?: number;
}) {
  return (
    <h2 className={`section-label tone-${tone}`}>
      {text.label}
      {count !== undefined && <span className="section-count">{count}</span>}
      <span className="section-hint">{text.hint}</span>
    </h2>
  );
}

/** A task done, put off or woken from its row: the board is read again after. */
export function useTaskChange(taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: TaskChangeRequest) => api("PATCH", apiPath(API_ROUTES.task, { taskId }), body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: boardQuery.queryKey }),
  });
}

/** A place's name: its host's, or what it is for what has no host of its own. */
export function placeName(kind: AttentionPlaceKind, hostLabel: string | null): string {
  if (kind === ATTENTION_PLACE.host) return hostLabel ?? "";
  return TEXT.attention.places[kind];
}

// Where a place's own page is: a host's page, Home Assistant's, the network's, Ollama's settings, the tasks.
const PLACE_PAGES: Record<Exclude<AttentionPlaceKind, typeof ATTENTION_PLACE.host>, string> = {
  [ATTENTION_PLACE.homeAssistant]: PATHS.homeAssistant,
  [ATTENTION_PLACE.network]: PATHS.network,
  [ATTENTION_PLACE.ollama]: `${PATHS.settings}#${SETTINGS_SECTIONS.connections}`,
  [ATTENTION_PLACE.other]: PATHS.tasks,
};

/** The way to a place's own page; null for a host no longer in the fleet. */
export function placeLink(kind: AttentionPlaceKind, hostId: string | null): string | null {
  if (kind !== ATTENTION_PLACE.host) return PLACE_PAGES[kind];
  return hostId === null ? null : hostLink(hostId);
}
