import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NetworkMapView } from "../../../src/shared/network.js";
import { NetworkMap } from "./network-map.js";

const VIEW: NetworkMapView = {
  infrastructure: [{ id: "gw", name: "Gateway", kind: "router", uplink: null }],
  devices: [
    {
      id: "00:00:5e:00:53:01",
      name: "NAS",
      network: "LAN",
      ip: "192.0.2.10",
      wired: true,
      uplink: "Gateway",
      uplinkPort: 4,
      signal: null,
      band: null,
      online: true,
    },
  ],
  talks: [],
  flowsAvailable: false,
};

const nas = () => screen.getByRole("button", { name: /^NAS/ });
const details = () => screen.queryByText("NAS", { selector: "strong" });
const press = (key: string, extra: object = {}) => fireEvent.keyDown(nas(), { key, ...extra });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a node on the map, by keyboard", () => {
  it("can be reached by Tab, and keeps its name", () => {
    render(<NetworkMap view={VIEW} />);
    expect(nas().getAttribute("tabindex")).toBe("0");
    nas().focus();
    expect(document.activeElement).toBe(nas());
  });

  it.each([
    ["Enter", "Enter"],
    ["Space", " "],
  ])("opens with %s, once, as a click does, without moving the page", (_name, key) => {
    render(<NetworkMap view={VIEW} />);
    expect(details()).toBeNull();
    // fireEvent says false when the page's default, such as Space scrolling, was stopped.
    expect(press(key)).toBe(false);
    expect(details()).not.toBeNull();
  });

  it.each([
    ["Enter", "Enter"],
    ["Space", " "],
  ])("does not flip open and shut while %s is held down, nor move the page", (_name, key) => {
    render(<NetworkMap view={VIEW} />);
    press(key);
    for (const _held of [1, 2, 3]) {
      expect(press(key, { repeat: true })).toBe(false);
      expect(details()).not.toBeNull();
    }
  });

  it("does nothing for any other key, and leaves that key alone", () => {
    render(<NetworkMap view={VIEW} />);
    for (const key of ["a", "Tab", "Escape", "ArrowDown"]) expect(press(key)).toBe(true);
    expect(details()).toBeNull();
  });

  it("does the same as a click", () => {
    render(<NetworkMap view={VIEW} />);
    fireEvent.click(nas());
    const byClick = details();
    expect(byClick).not.toBeNull();
    press(" ");
    expect(details()).toBeNull();
  });
});
