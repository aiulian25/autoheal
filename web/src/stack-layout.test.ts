import { describe, expect, it } from "vitest";
import type { TopologySnapshot } from "../../src/shared/topology.js";
import { layoutMap, mapGraph, MAP_LAYOUT } from "./stack-layout.js";

const node = (name: string, composeProject: string | null = null) => ({ name, containerId: name, composeProject });
const shared = (from: string, to: string, via?: string) => ({
  from,
  to,
  kind: "shared_writable_data" as const,
  source: "docker" as const,
  ...(via === undefined ? {} : { via }),
});
// A hub whose folder holds three others' data, a pair from one project, and one alone.
const snapshot: TopologySnapshot = {
  capturedAt: 1,
  nodes: [
    node("anchor"),
    node("npm"),
    node("radicale"),
    node("quantum"),
    node("attic", "attic"),
    node("attic-db", "attic"),
    node("gauges"),
  ],
  edges: [
    shared("anchor", "npm", "folder:3f2a91c0"),
    shared("anchor", "radicale", "folder:3f2a91c0"),
    shared("anchor", "quantum", "folder:3f2a91c0"),
    shared("npm", "radicale", "volume:proxy"),
    { from: "attic", to: "attic-db", kind: "declared_dependency", source: "docker" },
    { from: "attic", to: "attic-db", kind: "compose_association", source: "docker" },
    // From a runner that does not say what is shared.
    shared("quantum", "attic-db"),
  ],
  truncated: false,
  notes: [],
};

describe("the dependency map's graph", () => {
  it("draws a line for each link, counting each container's", () => {
    const graph = mapGraph(snapshot, false);
    expect(graph.nodes.map((each) => [each.id, each.links])).toEqual([
      ["anchor", 3],
      ["npm", 2],
      ["radicale", 2],
      ["quantum", 2],
      ["attic", 2],
      ["attic-db", 3],
      ["gauges", 0],
    ]);
    expect(graph.links).toHaveLength(7);
  });

  it("grouped, draws each shared folder or volume once, linked to whoever keeps data in it", () => {
    const graph = mapGraph(snapshot, true);
    const resources = graph.nodes.filter((each) => each.kind !== "container");
    expect(resources.map((each) => [each.kind, each.name, each.links])).toEqual([
      ["folder", "3f2a91c0", 4],
      ["volume", "proxy", 2],
    ]);
    // Three pair lines through the folder become four, one per container; the unnamed one stays a pair.
    expect(
      graph.links
        .filter((link) => link.to === "shared:folder:3f2a91c0")
        .map((link) => link.from)
        .sort(),
    ).toEqual(["anchor", "npm", "quantum", "radicale"]);
    expect(graph.links).toContainEqual({ from: "quantum", to: "attic-db", kind: "shared_writable_data" });
  });
});

describe("where the map puts each dot", () => {
  const graph = mapGraph(snapshot, false);
  const places = layoutMap(graph);
  const distance = (a: string, b: string) =>
    Math.hypot(places.get(a)!.x - places.get(b)!.x, places.get(a)!.y - places.get(b)!.y);

  it("is the same every time for the same report, and inside the map", () => {
    expect(layoutMap(graph)).toEqual(places);
    for (const { x, y } of places.values()) {
      expect(x).toBeGreaterThanOrEqual(MAP_LAYOUT.margin);
      expect(x).toBeLessThanOrEqual(MAP_LAYOUT.width - MAP_LAYOUT.margin);
      expect(y).toBeGreaterThanOrEqual(MAP_LAYOUT.margin);
      expect(y).toBeLessThanOrEqual(MAP_LAYOUT.height - MAP_LAYOUT.margin);
    }
  });

  it("keeps linked containers nearer each other than a container linked to nothing", () => {
    expect(distance("attic", "attic-db")).toBeLessThan(distance("attic", "gauges"));
    expect(distance("anchor", "npm")).toBeLessThan(distance("anchor", "gauges"));
  });
});
