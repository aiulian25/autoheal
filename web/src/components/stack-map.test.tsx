import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { TopologySnapshot } from "../../../src/shared/topology.js";
import { DEPENDENCY_MAP_TEXT } from "../constants.js";
import { StackMap } from "./stack-map.js";

const text = DEPENDENCY_MAP_TEXT;
const node = (name: string, composeProject: string | null = null) => ({ name, containerId: name, composeProject });
const shared = (from: string, to: string) => ({
  from,
  to,
  kind: "shared_writable_data" as const,
  source: "docker" as const,
  via: "folder:3f2a91c0",
});
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
    shared("anchor", "npm"),
    shared("anchor", "radicale"),
    shared("anchor", "quantum"),
    shared("anchor", "attic"),
    shared("anchor", "attic-db"),
    shared("anchor", "gauges"),
    { from: "attic", to: "attic-db", kind: "declared_dependency", source: "docker" },
  ],
  truncated: false,
  notes: [],
};
afterEach(cleanup);

const dot = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}:`) });

it("lights what a container is linked to, says it beside it, and fades the rest", () => {
  const { container } = render(<StackMap snapshot={snapshot} />);
  fireEvent.pointerEnter(dot("attic"));
  const tip = screen.getByRole("status");
  expect(within(tip).getByText("attic")).toBeTruthy();
  expect(tip.textContent).toContain(text.partners.shared_writable_data(1));
  expect(tip.textContent).toContain(text.partners.declared_dependency(1));
  expect(container.querySelector("svg")!.getAttribute("class")).toContain("dimmed");
  const lit = [...container.querySelectorAll(".map-node.lit")].map((each) => each.textContent);
  expect(lit.sort()).toEqual(["anchor", "attic", "attic-db"]);
  fireEvent.pointerLeave(dot("attic"));
  expect(screen.queryByRole("status")).toBeNull();
});

it("rings a hub and says why, and is reached from the keyboard too", () => {
  const { container } = render(<StackMap snapshot={snapshot} />);
  expect(dot("anchor").getAttribute("class")).toContain("hub");
  fireEvent.focus(dot("anchor"));
  expect(screen.getByRole("status").textContent).toContain(text.hub);
  expect(container.querySelectorAll(".map-link.lit")).toHaveLength(6);
  // A Compose project with two containers is a bubble around them.
  expect(container.querySelector(".map-bubble text")!.textContent).toBe("attic");
});

it("draws the folder they share once when grouped, and says its path stays on the host", () => {
  const { container } = render(<StackMap snapshot={snapshot} />);
  expect(container.querySelectorAll(".map-link.shared_writable_data")).toHaveLength(6);
  fireEvent.click(screen.getByRole("button", { name: text.group }));
  expect(screen.getByText(text.groupedNote)).toBeTruthy();
  expect(dot(text.folder("3f2a91c0"))).toBeTruthy();
  // One line from each of the seven containers keeping data there, instead of six pairs.
  expect(container.querySelectorAll(".map-link.shared_writable_data")).toHaveLength(7);
});
