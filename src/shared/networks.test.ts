import { describe, expect, it } from "vitest";
import {
  NETWORK_STATE,
  isCleanable,
  isLeftBehind,
  isLocked,
  networkState,
  rangeOf,
  rangesOverlap,
  type NetworkReport,
} from "./networks.js";

const network = (overrides: Partial<NetworkReport>): NetworkReport => ({
  name: "wyrmrss_default",
  driver: "bridge",
  subnet: "192.168.96.0/20",
  gateway: "192.168.96.1",
  internal: false,
  project: "wyrmrss",
  projectHere: false,
  own: false,
  members: [],
  ...overrides,
});
const running = { name: "app", running: true, address: "172.18.0.2" };
const stopped = { name: "autoheal", running: false, address: "" };

describe("what a network is", () => {
  it.each([
    ["Compose made it and its containers are gone", {}, NETWORK_STATE.leftBehind],
    ["a person made it and nothing is on it", { project: null }, NETWORK_STATE.empty],
    ["its app is still here, on other networks", { projectHere: true }, NETWORK_STATE.projectStillHere],
    ["something runs on it", { members: [running] }, NETWORK_STATE.inUse],
    ["only a stopped container is on it", { members: [stopped] }, NETWORK_STATE.keptForStopped],
    ["the runner stands on it", { own: true, members: [running] }, NETWORK_STATE.autohealOwn],
    ["Docker made it, even with nothing on it", { name: "bridge", project: null }, NETWORK_STATE.dockerOwn],
  ])("says so when %s", (_case, overrides, state) => {
    expect(networkState(network(overrides))).toBe(state);
  });

  it("cleans up only what nothing needs, and the nightly clean-up only what Compose left", () => {
    expect(isCleanable(network({}))).toBe(true);
    expect(isCleanable(network({ project: null }))).toBe(true);
    expect(isCleanable(network({ projectHere: true }))).toBe(false);
    expect(isCleanable(network({ members: [stopped] }))).toBe(false);
    expect(isLeftBehind(network({}))).toBe(true);
    expect(isLeftBehind(network({ project: null }))).toBe(false);
  });

  it("locks Docker's own and the runner's own", () => {
    expect(isLocked(network({ name: "host" }))).toBe(true);
    expect(isLocked(network({ own: true }))).toBe(true);
    expect(isLocked(network({}))).toBe(false);
  });
});

describe("address ranges", () => {
  it("reads a range from where its block starts, and refuses what is not one", () => {
    expect(rangeOf("10.0.0.5/24")).toEqual({ first: 167772160, last: 167772415 });
    expect(rangeOf("300.0.0.0/24")).toBeNull();
    expect(rangeOf("10.0.0.0/33")).toBeNull();
    expect(rangeOf("media")).toBeNull();
  });

  it("finds a clash either way round, and not between neighbours", () => {
    expect(rangesOverlap("172.18.0.0/16", "172.18.5.0/24")).toBe(true);
    expect(rangesOverlap("172.18.5.0/24", "172.18.0.0/16")).toBe(true);
    expect(rangesOverlap("172.18.0.0/16", "172.19.0.0/16")).toBe(false);
    expect(rangesOverlap("fd00::/64", "172.18.0.0/16")).toBe(false);
  });
});
