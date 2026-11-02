/** What the Ollama card draws behind its words: a small network with signals running along its lines. */
export const AGENT_NETWORK = {
  nodes: 26,
  linksPerNode: 2,
  idlePulses: 7,
  workingPulses: 18,
  loopMilliseconds: 12_000,
  drift: 0.02,
  // How much further apart it reads across than down: the card is taller than it is wide only with many hosts.
  acrossBias: 1.2,
  seed: 42,
} as const;

const SEED_MULTIPLIER = 16_807;
const SEED_MODULUS = 2_147_483_647;
const FULL_TURN = Math.PI * 2;
const MAXIMUM_CYCLES = 2;
const MAXIMUM_PULSE_CYCLES = 3;

export interface NetworkPoint {
  x: number;
  y: number;
}

interface NetworkNode extends NetworkPoint {
  cycles: number;
  phase: number;
}

interface NetworkPulse {
  link: number;
  cycles: number;
  start: number;
}

export interface AgentNetworkShape {
  nodes: NetworkNode[];
  links: [number, number][];
  pulses: NetworkPulse[];
}

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * SEED_MULTIPLIER) % SEED_MODULUS;
    return state / SEED_MODULUS;
  };
}

const wholeCycles = (random: () => number, most: number) => 1 + Math.floor(random() * most);

/** The same network every time, so it never jumps when the page is read again. */
export function agentNetwork(): AgentNetworkShape {
  const random = seeded(AGENT_NETWORK.seed);
  const nodes = Array.from({ length: AGENT_NETWORK.nodes }, () => ({
    x: random(),
    y: random(),
    cycles: wholeCycles(random, MAXIMUM_CYCLES),
    phase: random() * FULL_TURN,
  }));
  const distance = (from: NetworkPoint, to: NetworkPoint) =>
    Math.hypot(from.x - to.x, (from.y - to.y) * AGENT_NETWORK.acrossBias);
  const links = nodes.flatMap((node, index) =>
    nodes
      .map((other, otherIndex) => ({ otherIndex, away: distance(node, other) }))
      .filter(({ otherIndex }) => otherIndex !== index)
      .sort((left, right) => left.away - right.away)
      .slice(0, AGENT_NETWORK.linksPerNode)
      .map(({ otherIndex }): [number, number] => [index, otherIndex]),
  );
  const pulses = Array.from({ length: AGENT_NETWORK.workingPulses }, () => ({
    link: Math.floor(random() * links.length),
    cycles: wholeCycles(random, MAXIMUM_PULSE_CYCLES),
    start: random(),
  }));
  return { nodes, links, pulses };
}

/** Where each node is, at a point in the loop from 0 to 1: whole cycles, so its end meets its start. */
export function nodesAt(shape: AgentNetworkShape, progress: number, width: number, height: number): NetworkPoint[] {
  const inset = (position: number) => AGENT_NETWORK.drift + position * (1 - 2 * AGENT_NETWORK.drift);
  return shape.nodes.map((node) => {
    const angle = FULL_TURN * node.cycles * progress + node.phase;
    return {
      x: (inset(node.x) + AGENT_NETWORK.drift * Math.sin(angle)) * width,
      y: (inset(node.y) + AGENT_NETWORK.drift * Math.cos(angle)) * height,
    };
  });
}

/** Where each signal is: more of them while the agent is at work. */
export function pulsesAt(
  shape: AgentNetworkShape,
  placed: readonly NetworkPoint[],
  progress: number,
  working: boolean,
): NetworkPoint[] {
  const shown = working ? AGENT_NETWORK.workingPulses : AGENT_NETWORK.idlePulses;
  return shape.pulses.slice(0, shown).map((pulse) => {
    const [from, to] = shape.links[pulse.link]!;
    const along = (progress * pulse.cycles + pulse.start) % 1;
    const start = placed[from]!;
    const end = placed[to]!;
    return { x: start.x + (end.x - start.x) * along, y: start.y + (end.y - start.y) * along };
  });
}
