import { useEffect, useMemo, useRef } from "react";
import { AGENT_NETWORK, agentNetwork, nodesAt, pulsesAt, type AgentNetworkShape } from "../agent-network.js";
import { MAP_VIEW } from "../constants.js";

const FRAME_MILLISECONDS = 33;
const LINK_OPACITY = 0.22;
const NODE_OPACITY = 0.6;
const NODE_RADIUS = 1.8;
const PULSE_RADIUS = 2.2;
const PULSE_BLUR = 9;

function draw(canvas: HTMLCanvasElement, shape: AgentNetworkShape, now: number, working: boolean) {
  const context = canvas.getContext("2d");
  if (context === null) return;
  const scale = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * scale) || canvas.height !== Math.round(height * scale)) {
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
  }
  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.clearRect(0, 0, width, height);
  // Its colour comes from the theme, through the canvas's own style.
  const colour = getComputedStyle(canvas).color;
  const progress = (now / AGENT_NETWORK.loopMilliseconds) % 1;
  const placed = nodesAt(shape, progress, width, height);
  context.strokeStyle = colour;
  context.fillStyle = colour;
  context.globalAlpha = LINK_OPACITY;
  context.lineWidth = 1;
  context.beginPath();
  for (const [from, to] of shape.links) {
    context.moveTo(placed[from]!.x, placed[from]!.y);
    context.lineTo(placed[to]!.x, placed[to]!.y);
  }
  context.stroke();
  context.globalAlpha = NODE_OPACITY;
  for (const node of placed) {
    context.beginPath();
    context.arc(node.x, node.y, NODE_RADIUS, 0, Math.PI * 2);
    context.fill();
  }
  context.globalAlpha = 1;
  context.shadowColor = colour;
  context.shadowBlur = PULSE_BLUR;
  for (const pulse of pulsesAt(shape, placed, progress, working)) {
    context.beginPath();
    context.arc(pulse.x, pulse.y, PULSE_RADIUS, 0, Math.PI * 2);
    context.fill();
  }
  context.shadowBlur = 0;
}

/**
 * The network behind the Ollama card's words. It runs slowly, carries more signals while the agent is at work, and
 * stands still and dim when no server answers or a person asked for less motion.
 */
export function AgentNetwork({ working, answering }: { working: boolean; answering: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const shape = useMemo(agentNetwork, []);
  useEffect(() => {
    const element = canvas.current;
    if (element === null) return undefined;
    // ponytail: only a test's browser has no matchMedia, and it has no canvas to draw on either.
    if (window.matchMedia === undefined) return undefined;
    const calm = window.matchMedia(MAP_VIEW.reducedMotion).matches;
    if (calm || !answering) {
      const once = () => draw(element, shape, 0, false);
      const resized = window.ResizeObserver === undefined ? null : new ResizeObserver(once);
      resized?.observe(element);
      once();
      return () => resized?.disconnect();
    }
    let last = 0;
    let frame = requestAnimationFrame(function step(now) {
      if (now - last >= FRAME_MILLISECONDS) {
        last = now;
        draw(element, shape, now, working);
      }
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [shape, working, answering]);
  return (
    <span className={answering ? "agent-network" : "agent-network quiet"} aria-hidden>
      <canvas ref={canvas} />
    </span>
  );
}
