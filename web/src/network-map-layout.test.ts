import { describe, expect, it } from "vitest";
import { ROUTER_DEVICE_KIND, type NetworkMapView } from "../../src/shared/network.js";
import { NETWORK_MAP, OUTSIDE_NODE, layoutMapTree, pathToInternet } from "./network-map-layout.js";

const device = (id: string, uplink: string | null, wired = true): NetworkMapView["devices"][number] => ({
  id,
  name: id,
  network: "LAN",
  ip: null,
  wired,
  uplink,
  uplinkPort: null,
  signal: null,
  band: null,
  online: true,
});
const ROUTER = { id: "r", name: "Router", kind: ROUTER_DEVICE_KIND.router, uplink: null };
const switchOn = (id: string) => ({ id, name: id, kind: ROUTER_DEVICE_KIND.switch, uplink: "Router" });
const view = (infrastructure: NetworkMapView["infrastructure"], devices: NetworkMapView["devices"]) => ({
  infrastructure,
  devices,
  talks: [],
  flowsAvailable: false,
});
const treeOf = (shown: NetworkMapView) => layoutMapTree(shown, "Internet");
const nodeOf = (shown: NetworkMapView, id: string) => treeOf(shown).nodes.find((node) => node.id === id)!;

describe("the map's tree", () => {
  const home = view(
    [ROUTER, switchOn("Switch")],
    [
      device("phone", "Router", false),
      device("tablet", "Router", false),
      device("nas", "Switch"),
      device("pc", "Switch"),
    ],
  );

  it("runs internet, router, then what hangs off each, a row each", () => {
    const { rowHeight } = NETWORK_MAP;
    expect(nodeOf(home, OUTSIDE_NODE).y).toBe(0);
    expect(nodeOf(home, "r")).toMatchObject({ y: rowHeight, parent: OUTSIDE_NODE });
    expect(nodeOf(home, "Switch")).toMatchObject({ y: 2 * rowHeight, parent: "r" });
    expect(nodeOf(home, "phone")).toMatchObject({ y: 2 * rowHeight, parent: "r", link: "wifi", kind: "wifi_device" });
    expect(nodeOf(home, "nas")).toMatchObject({ y: 3 * rowHeight, parent: "Switch", link: "wired" });
  });

  it("keeps the switch in the middle of its row, with Wi-Fi either side", () => {
    expect(nodeOf(home, "phone").x).toBeLessThan(nodeOf(home, "Switch").x);
    expect(nodeOf(home, "tablet").x).toBeGreaterThan(nodeOf(home, "Switch").x);
  });

  it("never puts two things in one place, even with two full switches", () => {
    const wide = view(
      [ROUTER, switchOn("A"), switchOn("B")],
      [
        ...Array.from({ length: 12 }, (_, index) => device(`a${index}`, "A")),
        ...Array.from({ length: 12 }, (_, index) => device(`b${index}`, "B")),
      ],
    );
    const places = treeOf(wide).nodes.map(({ x, y }) => `${x},${y}`);
    expect(new Set(places).size).toBe(places.length);
  });

  it("does not lose a device whose uplink it cannot place, or a router not yet read", () => {
    expect(nodeOf(view([ROUTER], [device("lost", "gone")]), "lost").parent).toBe("r");
    expect(nodeOf(view([], [device("early", null)]), "early").parent).toBe(OUTSIDE_NODE);
  });

  it("lights the way from a device to the internet", () => {
    expect([...pathToInternet(treeOf(home), "nas")]).toEqual(["nas", "Switch", "r", OUTSIDE_NODE]);
    expect(pathToInternet(treeOf(home), null).size).toBe(0);
  });
});
