import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { NetworkMapView } from "../../../src/shared/network.js";
import { pathOf } from "../components/stack-map.js";
import { TEXT } from "../constants.js";
import {
  NETWORK_MAP,
  isInfrastructure,
  layoutMapTree,
  pathToInternet,
  type MapNodeKind,
  type PlacedNode,
} from "../network-map-layout.js";

const text = TEXT.network.map;
const ZOOM_STEP = 1.25;
const WHEEL_ZOOM_STEP = 1.1;
const NAME_CHARACTERS = 16;
const GOOD_SIGNAL_DBM = -67;
const TALK_BEND = 60;
const ICON_VIEW = 24;
const NARROW_STAGE = 600;
const PHONE_VIEW_WIDTH = 420;

const ICON_PATHS: Record<MapNodeKind, string> = {
  internet: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c-5 5-5 13 0 18M12 3c5 5 5 13 0 18",
  router: "M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM12 7v.01M9 11c2-1.5 4-1.5 6 0",
  switch: "M2 8h20v8H2zM6 12h.01M9.5 12h.01M13 12h.01M16.5 12h.01M20 12h.01",
  access_point: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  wired_device: "M3 5h18v11H3zM8 20h8M12 16v4",
  wifi_device: "M2.5 9.5c5.5-5 13.5-5 19 0M6 13c3.5-3 8.500-3 12 0M9.500 16.500c1.500-1 3.500-1 5 0M12 20h.01",
};

const shortName = (name: string) =>
  name.length > NAME_CHARACTERS ? `${name.slice(0, NAME_CHARACTERS - 1).trimEnd()}…` : name;

type MapDevice = NetworkMapView["devices"][number];

// What presses a native button.
const ACTIVATING_KEYS: ReadonlySet<string> = new Set(["Enter", " "]);

function factLine(device: MapDevice | undefined) {
  if (device === undefined) return null;
  if (device.signal !== null && !device.wired) return text.signal(device.signal, device.band);
  return device.uplinkPort === null ? null : text.port(device.uplinkPort);
}

function linkPath(parent: PlacedNode, child: PlacedNode) {
  const start = parent.y + NETWORK_MAP.linkStart;
  const bus = start + NETWORK_MAP.busDrop;
  return `M${parent.x},${start} V${bus} H${child.x} V${child.y - NETWORK_MAP.iconSize / 2}`;
}

function Node({
  node,
  device,
  state,
  onPoint,
  onChoose,
}: {
  node: PlacedNode;
  device: MapDevice | undefined;
  state: string;
  onPoint: (id: string | null) => void;
  onChoose: (id: string) => void;
}) {
  const { iconSize } = NETWORK_MAP;
  const facts = factLine(device);
  const signalClass = (device?.signal ?? 0) >= GOOD_SIGNAL_DBM ? "good" : "weak";
  const classes = ["net-node", node.kind, node.online ? "" : "off", state].filter(Boolean).join(" ");
  return (
    <g
      className={classes}
      transform={`translate(${node.x} ${node.y})`}
      tabIndex={0}
      role="button"
      aria-label={[node.name, facts].filter(Boolean).join(", ")}
      onPointerEnter={() => onPoint(node.id)}
      onPointerLeave={() => onPoint(null)}
      onFocus={() => onPoint(node.id)}
      onBlur={() => onPoint(null)}
      onClick={() => onChoose(node.id)}
      onKeyDown={(event) => {
        if (!ACTIVATING_KEYS.has(event.key)) return;
        // Space would scroll the page. Held down, a key repeats, which would open and shut it over and over.
        event.preventDefault();
        if (!event.repeat) onChoose(node.id);
      }}
    >
      <title>{node.name}</title>
      <rect className="net-node-back" x={-iconSize / 2} y={-iconSize / 2} width={iconSize} height={iconSize} rx={7} />
      <path
        className="net-node-icon"
        d={ICON_PATHS[node.kind]}
        transform={`translate(${(-ICON_VIEW * 0.75) / 2} ${(-ICON_VIEW * 0.75) / 2}) scale(0.75)`}
      />
      <text className="net-node-name" y={iconSize / 2 + 14}>
        {shortName(node.name)}
      </text>
      {facts !== null && (
        <text className={`net-node-facts ${device?.wired === false ? signalClass : ""}`} y={iconSize / 2 + 27}>
          {facts}
        </text>
      )}
    </g>
  );
}

function ChosenDetails({
  node,
  device,
  talks,
  nameOf,
  onClose,
}: {
  node: PlacedNode;
  device: MapDevice | undefined;
  talks: NetworkMapView["talks"];
  nameOf: (id: string) => string;
  onClose: () => void;
}) {
  const facts = [
    device?.network,
    device?.ip,
    factLine(device),
    device === undefined || device.online ? null : text.offline,
  ];
  return (
    <div className="network-detail" role="status">
      <div className="row spread">
        <strong>{node.name}</strong>
        <button type="button" className="quiet" onClick={onClose}>
          {TEXT.network.close}
        </button>
      </div>
      <p className="small muted">{facts.filter(Boolean).join(TEXT.separator)}</p>
      {talks.length === 0 && <p className="small muted">{text.noTalks}</p>}
      {talks.map(({ from, to, lines, blocked }) => (
        <p key={`${from}${to}${blocked}`} className="small">
          {nameOf(from)} → {nameOf(to)}
          {TEXT.separator}
          {text.lines(lines, blocked)}
        </p>
      ))}
    </div>
  );
}

/**
 * What is plugged into what, drawn as UniFi draws it. Who talks to whom stays out of the way until a device is
 * pointed at; only what crossed between networks for the first time is always there.
 */
export function NetworkMap({ view }: { view: NetworkMapView }) {
  const tree = useMemo(() => layoutMapTree(view, text.internet), [view]);
  const [pointed, setPointed] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [frame, setFrame] = useState<typeof tree.bounds | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const dragging = useRef<{ x: number; y: number } | null>(null);
  const shown = frame ?? tree.bounds;

  const byId = useMemo(() => new Map(tree.nodes.map((node) => [node.id, node])), [tree]);
  const devices = useMemo(() => new Map(view.devices.map((device) => [device.id, device])), [view]);
  const lit = pointed ?? chosen;
  const path = useMemo(() => pathToInternet(tree, lit), [tree, lit]);
  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  const talksOf = (id: string | null) => view.talks.filter(({ from, to }) => from === id || to === id);
  const drawnTalks = view.talks.filter((talk) => talk.firstTime || talk.from === lit || talk.to === lit);

  const zoom = (by: number) =>
    setFrame((before) => {
      const current = before ?? tree.bounds;
      const width = current.width / by;
      const height = current.height / by;
      return {
        x: current.x + (current.width - width) / 2,
        y: current.y + (current.height - height) / 2,
        width,
        height,
      };
    });

  // All of a network on a phone is too small to read: it opens on the router, to drag from there.
  useEffect(() => {
    const width = svg.current?.clientWidth ?? 0;
    const height = svg.current?.clientHeight ?? 0;
    if (width === 0 || width >= NARROW_STAGE) return;
    setFrame({
      x: -PHONE_VIEW_WIDTH / 2,
      y: tree.bounds.y,
      width: PHONE_VIEW_WIDTH,
      height: (PHONE_VIEW_WIDTH * height) / width,
    });
    // Only on opening: new readings must not undo where a person has moved it.
  }, []);

  // A wheel listener React adds cannot stop the page scrolling instead.
  useEffect(() => {
    const element = svg.current;
    if (element === null) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoom(event.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  });

  const pan = (event: PointerEvent) => {
    const from = dragging.current;
    const scale = svg.current?.getScreenCTM()?.a;
    if (from === null || scale === undefined) return;
    const [dx, dy] = [(event.clientX - from.x) / scale, (event.clientY - from.y) / scale];
    dragging.current = { x: event.clientX, y: event.clientY };
    setFrame((before) => {
      const current = before ?? tree.bounds;
      return { ...current, x: current.x - dx, y: current.y - dy };
    });
  };
  const chosenNode = chosen === null ? undefined : byId.get(chosen);
  const choose = (id: string) => setChosen((before) => (before === id ? null : id));
  const stateOf = (id: string) => {
    if (lit === null) return "";
    return path.has(id) ? "lit" : "faded";
  };

  return (
    <div className="stack">
      <section className="card network-map-card">
        <div className="row spread">
          <h3>{text.title}</h3>
          <span className="small muted">{text.legend}</span>
        </div>
        <div className="network-map-stage">
          <svg
            ref={svg}
            className="network-map"
            viewBox={`${shown.x} ${shown.y} ${shown.width} ${shown.height}`}
            role="img"
            aria-label={text.title}
            style={{ aspectRatio: `${tree.bounds.width} / ${tree.bounds.height}` }}
            onPointerDown={(event) => {
              dragging.current = { x: event.clientX, y: event.clientY };
            }}
            onPointerMove={pan}
            onPointerUp={() => (dragging.current = null)}
            onPointerLeave={() => (dragging.current = null)}
          >
            {tree.nodes.map((node) => {
              const parent = node.parent === null ? undefined : byId.get(node.parent);
              if (parent === undefined) return null;
              const on = path.has(node.id) && path.has(parent.id);
              const classes = ["net-link", node.link, on ? "lit" : "", lit !== null && !on ? "faded" : ""];
              return <path key={node.id} className={classes.filter(Boolean).join(" ")} d={linkPath(parent, node)} />;
            })}
            {tree.nodes
              .filter(
                ({ kind, id }) =>
                  (isInfrastructure(kind) || kind === "internet") && tree.nodes.some(({ parent }) => parent === id),
              )
              .map(({ id, x, y }) => (
                <circle key={id} className="net-junction" cx={x} cy={y + NETWORK_MAP.linkStart} r={4} />
              ))}
            {drawnTalks.map(({ from, to, blocked, firstTime }) => {
              const start = byId.get(from);
              const end = byId.get(to);
              if (start === undefined || end === undefined) return null;
              const classes = ["net-talk", blocked ? "blocked" : "", firstTime ? "first" : ""]
                .filter(Boolean)
                .join(" ");
              return <path key={`${from}${to}${blocked}`} className={classes} d={pathOf(start, end, TALK_BEND)} />;
            })}
            {tree.nodes.map((node) => (
              <Node
                key={node.id}
                node={node}
                device={devices.get(node.id)}
                state={stateOf(node.id)}
                onPoint={setPointed}
                onChoose={choose}
              />
            ))}
          </svg>
          <div className="network-map-controls" role="group" aria-label={text.controls}>
            <button type="button" aria-label={text.zoomIn} onClick={() => zoom(ZOOM_STEP)}>
              +
            </button>
            <button type="button" aria-label={text.zoomOut} onClick={() => zoom(1 / ZOOM_STEP)}>
              −
            </button>
            <button type="button" aria-label={text.fit} title={text.fit} onClick={() => setFrame(null)}>
              ⤢
            </button>
          </div>
        </div>
        {chosenNode !== undefined && (
          <ChosenDetails
            node={chosenNode}
            device={devices.get(chosenNode.id)}
            talks={talksOf(chosen)}
            nameOf={nameOf}
            onClose={() => setChosen(null)}
          />
        )}
      </section>
      {!view.flowsAvailable && <p className="notice warning small">{text.noFlows}</p>}
      <p className="small muted">{text.limit}</p>
    </div>
  );
}
