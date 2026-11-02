// What a person sees of several Ollama servers on the landing page, worked out from what the dashboard already has.
import type { HostView, OllamaServersView, OllamaStatusView } from "../../src/shared/api.js";

export interface FleetLine {
  // Null is the default server.
  id: string | null;
  name: string | null;
  model: string;
  hosts: number;
  reachable: boolean;
}

export const FLEET_STATE = { all: "all", some: "some", none: "none" } as const;
export type FleetState = (typeof FLEET_STATE)[keyof typeof FLEET_STATE];

export interface Fleet {
  lines: FleetLine[];
  answering: number;
  state: FleetState;
}

function stateOf(answering: number, total: number): FleetState {
  if (answering === 0) return FLEET_STATE.none;
  return answering === total ? FLEET_STATE.all : FLEET_STATE.some;
}

/** Every server, the default first, with how many hosts it watches. */
export function fleetOf(
  primary: Pick<OllamaStatusView, "model" | "reachable">,
  servers: OllamaServersView | undefined,
  hosts: readonly Pick<HostView, "id">[],
): Fleet {
  const extras = servers?.extras ?? [];
  const known = new Set(hosts.map(({ id }) => id));
  const assigned = new Set(extras.flatMap(({ hostIds }) => hostIds).filter((id) => known.has(id)));
  const lines: FleetLine[] = [
    {
      id: null,
      name: servers?.defaultName ?? null,
      model: primary.model,
      hosts: known.size - assigned.size,
      reachable: primary.reachable,
    },
    ...extras.map(({ id, name, model, hostIds, status }) => ({
      id,
      name,
      model,
      hosts: hostIds.filter((hostId) => known.has(hostId)).length,
      reachable: status.reachable,
    })),
  ];
  const answering = lines.filter(({ reachable }) => reachable).length;
  return { lines, answering, state: stateOf(answering, lines.length) };
}

/** The server answering for a host now: its own, or the default while its own is down. Null is a default with no name. */
export function answeringFor(servers: OllamaServersView | undefined, hostId: string | null): string | null {
  const own = (servers?.extras ?? []).find(({ hostIds }) => hostId !== null && hostIds.includes(hostId));
  return own === undefined || !own.status.reachable ? (servers?.defaultName ?? null) : own.name;
}

/** The servers some hosts' work goes to. Each is a name, or null for the default. */
export function serversFor(
  servers: OllamaServersView | undefined,
  hostIds: readonly (string | null)[],
): (string | null)[] {
  return [...new Set(hostIds.map((hostId) => answeringFor(servers, hostId)))];
}
