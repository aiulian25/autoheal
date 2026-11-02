import { ROUTER_DEVICE_KIND, type NetworkMapView, type RouterDeviceKind } from "../../src/shared/network.js";

export const OUTSIDE_NODE = "outside";
export const NETWORK_MAP = {
  slotWidth: 100,
  rowHeight: 124,
  iconSize: 30,
  // From a node's middle down past its two lines of words, where its links start.
  linkStart: 50,
  busDrop: 18,
  margin: 56,
} as const;

export type MapNodeKind = RouterDeviceKind | "internet" | "wired_device" | "wifi_device";
export type MapLinkKind = "wired" | "wifi";

export interface PlacedNode {
  id: string;
  name: string;
  kind: MapNodeKind;
  parent: string | null;
  link: MapLinkKind;
  online: boolean;
  x: number;
  y: number;
}

export interface MapTree {
  nodes: PlacedNode[];
  bounds: { x: number; y: number; width: number; height: number };
}

type Unplaced = Omit<PlacedNode, "x" | "y">;

function nodesOf(view: NetworkMapView, internetName: string): Unplaced[] {
  const idByName = new Map(view.infrastructure.map(({ id, name }) => [name, id]));
  const rootId = view.infrastructure.find(({ uplink }) => uplink === null)?.id ?? OUTSIDE_NODE;
  const infrastructure = view.infrastructure.map(({ id, name, kind, uplink }): Unplaced => {
    const parent = (uplink === null ? undefined : idByName.get(uplink)) ?? (id === rootId ? OUTSIDE_NODE : rootId);
    return { id, name, kind, parent, link: "wired", online: true };
  });
  const devices = view.devices.map(({ id, name, wired, uplink, online }): Unplaced => ({
    id,
    name,
    kind: wired ? "wired_device" : "wifi_device",
    parent: (uplink === null ? undefined : idByName.get(uplink)) ?? rootId,
    link: wired ? "wired" : "wifi",
    online,
  }));
  const internet: Unplaced = {
    id: OUTSIDE_NODE,
    name: internetName,
    kind: "internet",
    parent: null,
    link: "wired",
    online: true,
  };
  return [internet, ...infrastructure, ...devices];
}

/**
 * A tree like UniFi's: each thing's children in one row under it, those with children of their own in the middle.
 * One branch may run wider than the row above, as nothing beside it reaches that far down; several keep apart.
 */
export function layoutMapTree(view: NetworkMapView, internetName: string): MapTree {
  const unplaced = nodesOf(view, internetName);
  const childrenOf = new Map<string, Unplaced[]>();
  for (const node of unplaced) {
    if (node.parent === null) continue;
    childrenOf.set(node.parent, [...(childrenOf.get(node.parent) ?? []), node]);
  }
  const kids = (id: string) => (childrenOf.get(id) ?? []).toSorted((one, other) => one.name.localeCompare(other.name));
  const hasKids = (node: Unplaced) => childrenOf.has(node.id);
  const { slotWidth, rowHeight, margin } = NETWORK_MAP;

  const branchSlots = (branches: readonly Unplaced[]) =>
    branches.length === 1 ? [slotWidth] : branches.map((branch) => widthOf(branch.id));
  function widthOf(id: string): number {
    const children = kids(id);
    const branches = children.filter(hasKids);
    const row =
      (children.length - branches.length) * slotWidth + branchSlots(branches).reduce((sum, slot) => sum + slot, 0);
    const lone = branches.length === 1 ? widthOf(branches[0]!.id) : 0;
    return Math.max(slotWidth, row, lone);
  }

  const placed: PlacedNode[] = [];
  function place(node: Unplaced, x: number, depth: number) {
    placed.push({ ...node, x, y: depth * rowHeight });
    const children = kids(node.id);
    const leaves = children.filter((child) => !hasKids(child));
    const branches = children.filter(hasKids);
    const half = Math.ceil(leaves.length / 2);
    const row = [
      ...leaves.slice(0, half).map((child) => ({ child, slot: slotWidth })),
      ...branches.map((child, index) => ({ child, slot: branchSlots(branches)[index]! })),
      ...leaves.slice(half).map((child) => ({ child, slot: slotWidth })),
    ];
    let left = x - row.reduce((sum, { slot }) => sum + slot, 0) / 2;
    for (const { child, slot } of row) {
      place(child, left + slot / 2, depth + 1);
      left += slot;
    }
  }
  place(unplaced[0]!, 0, 0);

  const xs = placed.map(({ x }) => x);
  const ys = placed.map(({ y }) => y);
  const x = Math.min(...xs) - margin;
  const y = Math.min(...ys) - margin;
  return {
    nodes: placed,
    bounds: { x, y, width: Math.max(...xs) + margin - x, height: Math.max(...ys) + margin * 2 - y },
  };
}

/** A thing and everything between it and the internet, to light its way. */
export function pathToInternet(tree: MapTree, id: string | null): Set<string> {
  const byId = new Map(tree.nodes.map((node) => [node.id, node]));
  const path = new Set<string>();
  let node = id === null ? undefined : byId.get(id);
  while (node !== undefined) {
    path.add(node.id);
    node = node.parent === null ? undefined : byId.get(node.parent);
  }
  return path;
}

export const isInfrastructure = (kind: MapNodeKind) =>
  kind === ROUTER_DEVICE_KIND.router || kind === ROUTER_DEVICE_KIND.switch || kind === ROUTER_DEVICE_KIND.accessPoint;
