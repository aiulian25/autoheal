import { SHARED_VIA, type TopologySnapshot } from "../../src/shared/topology.js";

type Edge = TopologySnapshot["edges"][number];
export type LinkKind = Edge["kind"];

/** A dot on the map: a container, or, grouped, the folder or volume several keep their data in. */
export interface MapNode {
  id: string;
  kind: "container" | "folder" | "volume";
  // The container's name, the volume's, or the folder's fingerprint.
  name: string;
  project: string | null;
  links: number;
}

export interface MapLink {
  from: string;
  to: string;
  kind: LinkKind;
}

export interface MapGraph {
  nodes: MapNode[];
  links: MapLink[];
}

export interface Point {
  x: number;
  y: number;
}

export const MAP_LAYOUT = {
  width: 960,
  height: 520,
  margin: 48,
  iterations: 320,
  // A shared folder or volume is drawn as a wide label, not a dot: it keeps this much more room around it.
  resourceRoom: 3,
  // How strongly a Compose project's containers keep together, and everything drifts to the middle.
  cohesion: 0.06,
  gravity: 0.015,
} as const;

const RESOURCE_PREFIX = "shared:";
const weightOf = (node: MapNode) => (node.kind === "container" ? 1 : MAP_LAYOUT.resourceRoom);
const resourceKind = (via: string): MapNode["kind"] => (via.startsWith(SHARED_VIA.volume) ? "volume" : "folder");
const resourceName = (via: string) => via.slice(via.indexOf(":") + 1);

/**
 * The map's dots and lines from the host's report. Grouped, data shared through one folder or volume is drawn once,
 * as that folder or volume with a line to each container keeping data in it, instead of a line for every pair; a
 * link from a runner before it, which does not say what is shared, stays a line between the two.
 */
export function mapGraph(snapshot: TopologySnapshot, grouped: boolean): MapGraph {
  const nodes = new Map<string, MapNode>(
    snapshot.nodes.map((node) => [
      node.name,
      { id: node.name, kind: "container", name: node.name, project: node.composeProject, links: 0 },
    ]),
  );
  const links = new Map<string, MapLink>();
  const join = (from: string, to: string, kind: LinkKind) => {
    const key = JSON.stringify([from, to, kind]);
    if (links.has(key) || !nodes.has(from) || !nodes.has(to)) return;
    links.set(key, { from, to, kind });
    nodes.get(from)!.links += 1;
    nodes.get(to)!.links += 1;
  };
  for (const edge of snapshot.edges) {
    const through = grouped && edge.kind === "shared_writable_data" && edge.via !== undefined;
    if (!through) {
      join(edge.from, edge.to, edge.kind);
      continue;
    }
    const id = `${RESOURCE_PREFIX}${edge.via}`;
    if (!nodes.has(id) && nodes.has(edge.from) && nodes.has(edge.to)) {
      nodes.set(id, { id, kind: resourceKind(edge.via!), name: resourceName(edge.via!), project: null, links: 0 });
    }
    join(edge.from, id, edge.kind);
    join(edge.to, id, edge.kind);
  }
  return { nodes: [...nodes.values()], links: [...links.values()] };
}

/**
 * Where each dot goes: a force layout, the same every time for the same report. Every dot pushes the others away,
 * a line pulls its two ends together, a Compose project's containers keep together, and all of it stays in the
 * middle of the map.
 */
export function layoutMap(graph: MapGraph): Map<string, Point> {
  const { width, height, margin, iterations, cohesion, gravity } = MAP_LAYOUT;
  const count = Math.max(graph.nodes.length, 1);
  const spacing = Math.sqrt(((width - 2 * margin) * (height - 2 * margin)) / count);
  const places = new Map<string, Point>(
    graph.nodes.map((node, index) => {
      const angle = (index / count) * Math.PI * 2;
      return [
        node.id,
        { x: width / 2 + (width / 3) * Math.cos(angle), y: height / 2 + (height / 3) * Math.sin(angle) },
      ];
    }),
  );
  let temperature = width / 8;
  for (let step = 0; step < iterations; step += 1) {
    const moves = new Map<string, Point>(graph.nodes.map((node) => [node.id, { x: 0, y: 0 }]));
    const push = (id: string, x: number, y: number) => {
      const move = moves.get(id)!;
      move.x += x;
      move.y += y;
    };
    for (let left = 0; left < graph.nodes.length; left += 1) {
      for (let right = left + 1; right < graph.nodes.length; right += 1) {
        const a = graph.nodes[left]!.id;
        const b = graph.nodes[right]!.id;
        const pa = places.get(a)!;
        const pb = places.get(b)!;
        const dx = pa.x - pb.x || 0.01;
        const dy = pa.y - pb.y || 0.01;
        const distance = Math.hypot(dx, dy);
        const force =
          ((spacing * spacing) / distance) * ((weightOf(graph.nodes[left]!) + weightOf(graph.nodes[right]!)) / 2);
        push(a, (dx / distance) * force, (dy / distance) * force);
        push(b, (-dx / distance) * force, (-dy / distance) * force);
      }
    }
    for (const link of graph.links) {
      const pa = places.get(link.from)!;
      const pb = places.get(link.to)!;
      const dx = pa.x - pb.x;
      const dy = pa.y - pb.y;
      const distance = Math.max(Math.hypot(dx, dy), 0.01);
      const force = (distance * distance) / spacing;
      push(link.from, (-dx / distance) * force, (-dy / distance) * force);
      push(link.to, (dx / distance) * force, (dy / distance) * force);
    }
    const centres = new Map<string, Point & { members: number }>();
    for (const node of graph.nodes) {
      if (node.project === null) continue;
      const place = places.get(node.id)!;
      const centre = centres.get(node.project) ?? { x: 0, y: 0, members: 0 };
      centres.set(node.project, { x: centre.x + place.x, y: centre.y + place.y, members: centre.members + 1 });
    }
    for (const node of graph.nodes) {
      const place = places.get(node.id)!;
      const centre = node.project === null ? undefined : centres.get(node.project);
      if (centre !== undefined && centre.members > 1) {
        push(
          node.id,
          (centre.x / centre.members - place.x) * cohesion * spacing,
          (centre.y / centre.members - place.y) * cohesion * spacing,
        );
      }
      push(node.id, (width / 2 - place.x) * gravity * spacing, (height / 2 - place.y) * gravity * spacing);
    }
    for (const node of graph.nodes) {
      const move = moves.get(node.id)!;
      const length = Math.max(Math.hypot(move.x, move.y), 0.01);
      const place = places.get(node.id)!;
      const step = Math.min(length, temperature);
      places.set(node.id, {
        x: Math.min(width - margin, Math.max(margin, place.x + (move.x / length) * step)),
        y: Math.min(height - margin, Math.max(margin, place.y + (move.y / length) * step)),
      });
    }
    temperature *= 0.985;
  }
  return places;
}
