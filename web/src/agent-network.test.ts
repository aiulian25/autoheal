import { describe, expect, it } from "vitest";
import { AGENT_NETWORK, agentNetwork, nodesAt, pulsesAt } from "./agent-network.js";

const WIDTH = 320;
const HEIGHT = 90;

describe("the Ollama card's network", () => {
  it("is the same every time, and every node stays inside the card", () => {
    const shape = agentNetwork();
    expect(agentNetwork()).toEqual(shape);
    for (const progress of [0, 0.3, 0.7]) {
      for (const node of nodesAt(shape, progress, WIDTH, HEIGHT)) {
        expect(node.x).toBeGreaterThanOrEqual(0);
        expect(node.x).toBeLessThanOrEqual(WIDTH);
        expect(node.y).toBeGreaterThanOrEqual(0);
        expect(node.y).toBeLessThanOrEqual(HEIGHT);
      }
    }
  });

  it("ends its loop where it began", () => {
    const shape = agentNetwork();
    const start = nodesAt(shape, 0, WIDTH, HEIGHT);
    const end = nodesAt(shape, 1, WIDTH, HEIGHT);
    end.forEach((node, index) => {
      expect(node.x).toBeCloseTo(start[index]!.x, 6);
      expect(node.y).toBeCloseTo(start[index]!.y, 6);
    });
  });

  it("carries more signals while the agent is at work", () => {
    const shape = agentNetwork();
    const placed = nodesAt(shape, 0.5, WIDTH, HEIGHT);
    expect(pulsesAt(shape, placed, 0.5, false)).toHaveLength(AGENT_NETWORK.idlePulses);
    expect(pulsesAt(shape, placed, 0.5, true)).toHaveLength(AGENT_NETWORK.workingPulses);
  });
});
