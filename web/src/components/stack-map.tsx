import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { TopologySnapshot } from "../../../src/shared/topology.js";
import { DEPENDENCY_MAP_TEXT, MAP_VIEW } from "../constants.js";
import { layoutMap, mapGraph, MAP_LAYOUT, type MapGraph, type MapNode, type Point } from "../stack-layout.js";

const text = DEPENDENCY_MAP_TEXT;

// A dot grows with its links, so the busiest stand out; a hub, linked to a good share of the host, gets a halo.
const radiusOf = (node: MapNode) => MAP_VIEW.radius + Math.sqrt(node.links) * MAP_VIEW.radiusPerLink;
const isHub = (node: MapNode, containers: number) =>
  node.kind === "container" && node.links >= Math.max(MAP_VIEW.hubLinks, containers * MAP_VIEW.hubShare);

/** Who a dot is linked to, by kind of link, for its tooltip. */
function partnersOf(graph: MapGraph, id: string) {
  const counts = new Map<string, number>();
  for (const link of graph.links) {
    if (link.from !== id && link.to !== id) continue;
    counts.set(link.kind, (counts.get(link.kind) ?? 0) + 1);
  }
  return [...counts.entries()].map(([kind, count]) => text.partners[kind as keyof typeof text.partners](count));
}

// Each Compose project with two or more containers on the map: a soft bubble around them.
function bubblesOf(graph: MapGraph, places: Map<string, Point>) {
  const members = new Map<string, Point[]>();
  for (const node of graph.nodes) {
    if (node.project === null) continue;
    members.set(node.project, [...(members.get(node.project) ?? []), places.get(node.id)!]);
  }
  return [...members.entries()]
    .filter(([, points]) => points.length > 1)
    .map(([project, points]) => {
      const xs = points.map((point) => point.x);
      const ys = points.map((point) => point.y);
      const pad = MAP_VIEW.bubblePadding;
      return {
        project,
        x: Math.min(...xs) - pad,
        y: Math.min(...ys) - pad,
        width: Math.max(...xs) - Math.min(...xs) + 2 * pad,
        height: Math.max(...ys) - Math.min(...ys) + 2 * pad,
      };
    });
}

const nameOf = (node: MapNode) => {
  if (node.kind === "volume") return text.volume(node.name);
  return node.kind === "folder" ? text.folder(node.name) : node.name;
};

// Two lines between the same pair bend apart, so both show.
export function pathOf(from: Point, to: Point, bend: number) {
  const length = Math.max(Math.hypot(to.x - from.x, to.y - from.y), 1);
  const middleX = (from.x + to.x) / 2 - ((to.y - from.y) / length) * bend;
  const middleY = (from.y + to.y) / 2 + ((to.x - from.x) / length) * bend;
  return `M${from.x},${from.y} Q${middleX},${middleY} ${to.x},${to.y}`;
}

/**
 * The host's containers as a map: Compose projects as bubbles, the busiest containers larger, hubs ringed. Hovering
 * or focusing one lights what it is linked to, with dots running along those lines, and says so beside it; a dot can
 * be dragged to tidy the map. Grouped, data shared through one folder or volume is drawn once.
 */
export function StackMap({ snapshot }: { snapshot: TopologySnapshot }) {
  const named = snapshot.edges.some((edge) => edge.via !== undefined);
  const [grouped, setGrouped] = useState(false);
  const graph = useMemo(() => mapGraph(snapshot, grouped && named), [snapshot, grouped, named]);
  const laidOut = useMemo(() => layoutMap(graph), [graph]);
  const [moved, setMoved] = useState(new Map<string, Point>());
  const [lit, setLit] = useState<string | null>(null);
  const dragging = useRef<string | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const flows = useRef<SVGGElement>(null);
  const placeOf = (id: string) => moved.get(id) ?? laidOut.get(id)!;
  const containers = graph.nodes.filter((node) => node.kind === "container").length;
  const litLinks = lit === null ? [] : graph.links.filter((link) => link.from === lit || link.to === lit);
  const near = new Set(litLinks.flatMap((link) => [link.from, link.to]));

  // Dots run along the lit lines, outward from the one lit; none for a person who asked for less motion.
  useEffect(() => {
    const layer = flows.current;
    const calm = window.matchMedia?.(MAP_VIEW.reducedMotion).matches ?? true;
    if (layer === null || lit === null || calm) return undefined;
    const paths = [...layer.parentElement!.querySelectorAll<SVGPathElement>("path.map-link.lit")];
    const dots = paths.map((path) => {
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("r", String(MAP_VIEW.dotRadius));
      dot.setAttribute("class", `map-dot ${path.dataset.kind ?? ""}`);
      layer.append(dot);
      return { path, dot, outward: path.dataset.from === lit };
    });
    const start = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      dots.forEach(({ path, dot, outward }, index) => {
        const along = ((now - start) / MAP_VIEW.flowMilliseconds + index * MAP_VIEW.flowStagger) % 1;
        const point = path.getPointAtLength((outward ? along : 1 - along) * path.getTotalLength());
        dot.setAttribute("cx", String(point.x));
        dot.setAttribute("cy", String(point.y));
      });
      frame = requestAnimationFrame(step);
    });
    return () => {
      cancelAnimationFrame(frame);
      dots.forEach(({ dot }) => dot.remove());
    };
  }, [lit, graph, moved]);

  const toMap = (event: PointerEvent): Point | null => {
    const matrix = svg.current?.getScreenCTM()?.inverse();
    if (matrix === undefined) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix);
    return { x: point.x, y: point.y };
  };
  const drag = (event: PointerEvent) => {
    const id = dragging.current;
    const point = id === null ? null : toMap(event);
    if (id === null || point === null) return;
    setMoved((before) => new Map(before).set(id, point));
  };
  const regroup = () => {
    setGrouped(!grouped);
    setMoved(new Map());
    setLit(null);
  };
  const tip = lit === null ? null : graph.nodes.find((node) => node.id === lit);
  const tipAt = tip === undefined || tip === null ? null : placeOf(tip.id);
  const pairs = new Map<string, number>();
  return (
    <div className="stack-map">
      {named && (
        <p className="row">
          <button type="button" className="quiet small" aria-pressed={grouped} onClick={regroup}>
            {text.group}
          </button>
          <span className="small muted">{grouped ? text.groupedNote : text.groupHint}</span>
        </p>
      )}
      <div className="stack-map-stage">
        <svg
          ref={svg}
          viewBox={`0 0 ${MAP_LAYOUT.width} ${MAP_LAYOUT.height}`}
          role="img"
          aria-label={text.mapLabel}
          className={lit === null ? "stack-map-svg" : "stack-map-svg dimmed"}
          onPointerMove={drag}
          onPointerUp={() => (dragging.current = null)}
          onPointerLeave={() => (dragging.current = null)}
        >
          {bubblesOf(graph, new Map(graph.nodes.map((node) => [node.id, placeOf(node.id)]))).map((bubble) => (
            <g key={bubble.project} className="map-bubble">
              <rect x={bubble.x} y={bubble.y} width={bubble.width} height={bubble.height} rx={MAP_VIEW.bubbleRound} />
              <text x={bubble.x + MAP_VIEW.bubbleLabelInset} y={bubble.y + MAP_VIEW.bubbleLabelDrop}>
                {bubble.project}
              </text>
            </g>
          ))}
          {graph.links.map((link) => {
            const pair = [link.from, link.to].sort().join("\n");
            const seen = pairs.get(pair) ?? 0;
            pairs.set(pair, seen + 1);
            const on = litLinks.includes(link);
            return (
              <path
                key={`${link.from}\n${link.to}\n${link.kind}`}
                className={on ? `map-link ${link.kind} lit` : `map-link ${link.kind}`}
                data-kind={link.kind}
                data-from={link.from}
                d={pathOf(placeOf(link.from), placeOf(link.to), seen * MAP_VIEW.bend)}
              />
            );
          })}
          <g ref={flows} />
          {graph.nodes.map((node) => {
            const place = placeOf(node.id);
            const radius = radiusOf(node);
            const classes = [
              "map-node",
              node.kind,
              isHub(node, containers) && "hub",
              (node.id === lit || near.has(node.id)) && "lit",
              node.id === lit && "focus",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <g
                key={node.id}
                className={classes}
                tabIndex={0}
                role="button"
                aria-label={`${nameOf(node)}: ${partnersOf(graph, node.id).join(", ") || text.alone}`}
                onPointerEnter={() => dragging.current === null && setLit(node.id)}
                onPointerLeave={() => dragging.current === null && setLit(null)}
                onFocus={() => setLit(node.id)}
                onBlur={() => setLit(null)}
                onPointerDown={(event) => {
                  dragging.current = node.id;
                  (event.target as Element).setPointerCapture?.(event.pointerId);
                }}
              >
                {node.kind === "container" ? (
                  <circle cx={place.x} cy={place.y} r={radius} />
                ) : (
                  <rect
                    x={place.x - MAP_VIEW.resourceWidth / 2}
                    y={place.y - MAP_VIEW.resourceHeight / 2}
                    width={MAP_VIEW.resourceWidth}
                    height={MAP_VIEW.resourceHeight}
                    rx={MAP_VIEW.resourceRound}
                  />
                )}
                <text
                  x={node.kind === "container" ? place.x + radius + MAP_VIEW.labelGap : place.x}
                  y={node.kind === "container" ? place.y + MAP_VIEW.labelDrop : place.y + MAP_VIEW.labelDrop}
                  textAnchor={node.kind === "container" ? "start" : "middle"}
                >
                  {nameOf(node).slice(0, MAP_VIEW.labelCharacters)}
                </text>
              </g>
            );
          })}
        </svg>
        {tip !== null && tip !== undefined && tipAt !== null && (
          <div
            className="stack-map-tip"
            role="status"
            style={{
              left: `${(tipAt.x / MAP_LAYOUT.width) * 100}%`,
              top: `${(tipAt.y / MAP_LAYOUT.height) * 100}%`,
            }}
          >
            <strong>{nameOf(tip)}</strong>
            {tip.project !== null && <span className="muted"> · {tip.project}</span>}
            <p>{partnersOf(graph, tip.id).join(" · ") || text.alone}</p>
            {isHub(tip, containers) && <p className="text-warning">{text.hub}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
