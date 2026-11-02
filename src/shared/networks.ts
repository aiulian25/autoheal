import { z } from "zod";
import { DOCKER_OWN_NETWORKS, NETWORK_NAME, REPORT_LIMITS } from "./constants.js";

const reportedName = z.string().max(REPORT_LIMITS.nameCharacters);

const networkMemberSchema = z.object({
  name: reportedName,
  running: z.boolean(),
  // Its address on this network; empty while it is stopped.
  address: reportedName,
});

export const networkReportSchema = z.object({
  name: reportedName,
  driver: reportedName,
  subnet: reportedName.nullable(),
  gateway: reportedName.nullable(),
  internal: z.boolean(),
  // The Compose project that made it; null for one made by hand or by Docker.
  project: reportedName.nullable(),
  // Whether that project still has a container on the host, running or not.
  projectHere: z.boolean(),
  // The runner's own: it never removes the network it stands on.
  own: z.boolean(),
  members: z.array(networkMemberSchema).max(REPORT_LIMITS.containers),
});
export type NetworkReport = z.infer<typeof networkReportSchema>;

const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
const IPV4_BITS = 32;
const OCTET_BITS = 8;
const OCTET_LIMIT = 255;

/** An IPv4 range as the numbers it starts and ends at; null when it is not one. */
export function rangeOf(cidr: string): { first: number; last: number } | null {
  const parts = CIDR.exec(cidr)?.slice(1).map(Number);
  if (parts === undefined) return null;
  const prefix = parts[4]!;
  const octets = parts.slice(0, 4);
  if (prefix > IPV4_BITS || octets.some((octet) => octet > OCTET_LIMIT)) return null;
  const address = octets.reduce((total, octet) => total * 2 ** OCTET_BITS + octet, 0);
  const size = 2 ** (IPV4_BITS - prefix);
  const first = address - (address % size);
  return { first, last: first + size - 1 };
}

export function rangesOverlap(one: string, other: string): boolean {
  const [first, second] = [rangeOf(one), rangeOf(other)];
  if (first === null || second === null) return false;
  return first.first <= second.last && second.first <= first.last;
}

export const newNetworkSchema = z.object({
  name: z.string().regex(NETWORK_NAME),
  driver: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  internal: z.boolean(),
  subnet: z
    .string()
    .refine((value) => rangeOf(value) !== null)
    .nullable(),
  // The host's network card a macvlan or ipvlan network hangs off.
  parent: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}$/)
    .nullable(),
  containers: z.array(z.string().min(1).max(REPORT_LIMITS.nameCharacters)).max(REPORT_LIMITS.containers),
});
export type NewNetwork = z.infer<typeof newNetworkSchema>;

export const networkRemovalSchema = z.object({
  names: z.array(z.string().regex(NETWORK_NAME)).min(1).max(REPORT_LIMITS.networks),
  // A person's "remove anyway": a stopped container on it will not start again.
  evenIfStoppedNeedIt: z.boolean(),
});
export type NetworkRemoval = z.infer<typeof networkRemovalSchema>;

export const NETWORK_STATE = {
  dockerOwn: "docker_own",
  autohealOwn: "autoheal_own",
  inUse: "in_use",
  keptForStopped: "kept_for_stopped",
  leftBehind: "left_behind",
  empty: "empty",
  projectStillHere: "project_still_here",
} as const;
export type NetworkState = (typeof NETWORK_STATE)[keyof typeof NETWORK_STATE];

/** Empty is not always junk: what is on a network, and what made it, say what it is. */
export function networkState(network: NetworkReport): NetworkState {
  if (DOCKER_OWN_NETWORKS.has(network.name)) return NETWORK_STATE.dockerOwn;
  if (network.own) return NETWORK_STATE.autohealOwn;
  if (network.members.some((member) => member.running)) return NETWORK_STATE.inUse;
  if (network.members.length > 0) return NETWORK_STATE.keptForStopped;
  if (network.project === null) return NETWORK_STATE.empty;
  return network.projectHere ? NETWORK_STATE.projectStillHere : NETWORK_STATE.leftBehind;
}

const stateIs = (network: NetworkReport, ...states: readonly NetworkState[]) => states.includes(networkState(network));

/** What a person's clean-up takes: nothing on them, and no app of theirs still here. */
export const isCleanable = (network: NetworkReport) => stateIs(network, NETWORK_STATE.leftBehind, NETWORK_STATE.empty);

/** What the nightly clean-up takes: only what Compose made and left, never one a person made and may want. */
export const isLeftBehind = (network: NetworkReport) => stateIs(network, NETWORK_STATE.leftBehind);

/** Docker's or Autoheal's own: never removed from here. */
export const isLocked = (network: NetworkReport) =>
  stateIs(network, NETWORK_STATE.dockerOwn, NETWORK_STATE.autohealOwn);
